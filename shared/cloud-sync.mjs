/**
 * Syncs the notes folder with the cloud (see shared/cloud-remote-supabase.mjs).
 *
 *  - The folder stays the working copy: the app reads and saves locally and
 *    works the same with no internet.
 *  - Every run first pulls what other computers saved and merges it into the
 *    folder (VaultSync.applyRemote, which never drops a cell it has not seen
 *    deleted), then pushes what changed here.
 *  - A push only lands on top of the latest cloud version (compare and swap
 *    on `rev`). If another computer got there first, the newer version is
 *    pulled, merged and pushed again. A stale copy can never replace a newer one.
 *  - Images and artifacts sync as files: content addressed blobs plus a
 *    path -> sha list. If both computers changed the same file, both are kept.
 *
 * Plain Node, no Electron, so scripts/test-cloud-sync.mjs can run it.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import * as core from './sync-core.mjs'
import { PushGuard, pausedMessage } from './push-guard.mjs'

const PUSH_DELAY_MS = 1000
const POLL_MS = 60_000
const FULL_CHECK_MS = 10 * 60_000
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_ATTEMPTS = 5
const FILE_ROOTS = ['assets', 'artifacts']

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex')
const docHash = (data) => sha1(core.stable(data))
/** Fields each computer sets by itself: measured sizes and save times. */
const SELF_SET = new Set(['x', 'y', 'w', 'h', 'z', 'updatedAt'])
/**
 * What decides whether a note needs pushing. For pages it leaves out what each
 * computer measures or stamps on its own: a deliberate move or resize bumps
 * the cell's version, which is still in here. Otherwise two computers that
 * measure a cell differently keep pushing their own copy to each other forever.
 */
const syncHash = (kind, data) => {
  if (kind !== 'page' || !data) return docHash(data)
  const strip = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => !SELF_SET.has(k)))
  const { updatedAt: _u, ...page } = data
  return 'v2:' + docHash({ ...page, cells: (data.cells || []).map(strip) })
}
/** The stored hash still matches this note (also accepts hashes saved before syncHash). */
const unchanged = (kind, data, st) => Boolean(st?.hash) && (syncHash(kind, data) === st.hash || docHash(data) === st.hash)
const keyOf = (kind, id) => `${kind}:${id || ''}`
const parseKey = (key) => {
  const i = key.indexOf(':')
  const kind = key.slice(0, i)
  const id = key.slice(i + 1)
  return { kind, id: kind === 'page' ? id : undefined, docId: id }
}
const isTemp = (name) => name.endsWith('.tmp') || name.includes('.tmp-') || name.includes('.cloud-dl-')

function offlineError(e) {
  const msg = String(e?.message || e)
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(msg)
}

function emptyState() {
  return { userId: null, docCursor: 0, fileCursor: 0, docs: {}, files: {}, fileCache: {} }
}

export class CloudSync {
  /**
   * @param {{ vault: import('./vault-sync.mjs').VaultSync, stateDir: string,
   *   onStatus?(s: any): void, log?(...a: any[]): void }} opts
   */
  constructor({ vault, stateDir, onStatus, log }) {
    this.vault = vault
    this.stateDir = stateDir
    this.onStatus = onStatus || (() => {})
    this.log = log || (() => {})
    this.remote = null
    this.dir = null
    this.state = emptyState()
    this.dirty = new Set()
    this.failures = 0
    this.lastFullAt = 0
    this.guard = new PushGuard()
    this.info = { phase: 'off', email: '', lastSyncAt: 0, lastError: '', skipped: [], paused: [] }
  }

  /* ---------------- setup ---------------- */

  /** The notes folder changed (or was set for the first time). */
  setVaultDir(dir) {
    this.dir = path.resolve(dir)
    this.stateFile = path.join(this.stateDir, 'cloud', `${sha1(this.dir.toLowerCase()).slice(0, 16)}.json`)
    try {
      this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }
    } catch {
      this.state = emptyState()
    }
    this.dirty.clear()
    this.lastFullAt = 0
    this.schedule(0)
  }

  /** Signed in (a remote) or signed out (null). */
  setRemote(remote) {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.remote = remote
    clearInterval(this.poll)
    if (!remote) {
      this.setInfo({ phase: 'off', email: '' })
      return
    }
    this.lastFullAt = 0
    this.poll = setInterval(() => this.schedule(0), POLL_MS)
    try {
      this.unsubscribe = remote.subscribe(
        () => this.schedule(300),
        (st) => {
          if (st === 'SUBSCRIBED') this.schedule(0)
        },
      )
    } catch (e) {
      this.log('cloud: live updates unavailable', e)
    }
    this.schedule(0)
  }

  stop() {
    clearTimeout(this.timer)
    clearInterval(this.poll)
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  status() {
    return { ...this.info, pending: this.dirty.size, signedIn: Boolean(this.remote) }
  }

  setInfo(patch) {
    Object.assign(this.info, patch)
    this.onStatus(this.status())
  }

  /** VaultSync saw a local change. */
  markDirty(kind, id, info) {
    const key = keyOf(kind, id)
    if (info?.deleted) {
      this.state.docs[key] = { ...(this.state.docs[key] || { rev: 0, hash: null }), pendingDelete: true }
      this.saveState()
    }
    this.dirty.add(key)
    this.schedule(PUSH_DELAY_MS)
  }

  /* ---------------- scheduling ---------------- */

  schedule(ms) {
    if (!this.remote || !this.dir) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.syncNow(), ms)
  }

  /** Runs one full pull + push. Resolves when it (and any run asked for meanwhile) is done. */
  syncNow() {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.runOnce()
        } while (this.again && this.remote)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  async runOnce() {
    const remote = this.remote
    if (!remote || !this.dir) return
    clearTimeout(this.timer)
    this.setInfo({ phase: 'syncing' })
    try {
      const session = await remote.session()
      if (!session) {
        this.setInfo({ phase: 'signed-out', email: '' })
        return
      }
      if (this.state.userId !== session.userId) {
        // A different account: start over against it (the local folder is untouched).
        this.state = { ...emptyState(), userId: session.userId }
        this.lastFullAt = 0
      }
      this.info.email = session.email
      await this.vault.ready

      const full = Date.now() - this.lastFullAt > FULL_CHECK_MS
      if (full) for (const [kind, id] of await this.vault.listDocs()) this.dirty.add(keyOf(kind, id))

      await this.pullDocs(remote, full)
      await this.pushDocs(remote)
      await this.syncFiles(remote, full)

      if (full) this.lastFullAt = Date.now()
      this.failures = 0
      const paused = this.guard.pausedItems()
      if (paused.length) this.log('cloud: paused by the loop guard', paused)
      this.setInfo({ phase: paused.length ? 'error' : 'idle', lastSyncAt: Date.now(), lastError: pausedMessage(paused), paused })
    } catch (e) {
      this.failures++
      const offline = offlineError(e)
      this.log('cloud: sync failed', e)
      this.setInfo({ phase: offline ? 'offline' : 'error', lastError: offline ? '' : String(e?.message || e) })
      // Try again soon, then less often: 5 s, 10 s, 20 s ... up to 2 minutes.
      this.schedule(Math.min(5000 * 2 ** (this.failures - 1), 120_000))
    } finally {
      await this.saveState()
    }
  }

  /* ---------------- notes ---------------- */

  async pullDocs(remote, full) {
    const rows = await remote.docsSince(this.state.docCursor)
    for (const row of rows) {
      await this.applyDoc(row)
      this.state.docCursor = Math.max(this.state.docCursor, Number(row.change_seq))
    }
    if (!full) return
    // Catches anything a cursor could miss (writes that committed out of order).
    for (const r of await remote.docRevs()) {
      const st = this.state.docs[keyOf(r.kind, r.doc_id)]
      if (st && Number(st.rev) >= Number(r.rev)) continue
      const row = await remote.getDoc(r.kind, r.doc_id)
      if (row) await this.applyDoc(row)
    }
  }

  /** A cloud version of a note: merge it into the folder. */
  async applyDoc(row, force = false) {
    const key = keyOf(row.kind, row.doc_id)
    const { kind, id } = parseKey(key)
    const st = this.state.docs[key]
    const rev = Number(row.rev)
    if (!force && st && Number(st.rev) >= rev) return

    if (row.deleted) {
      if (kind !== 'page') {
        this.state.docs[key] = { ...(st || {}), rev, hash: st?.hash ?? null }
        return
      }
      const local = await this.vault.current(kind, id)
      if (!local || st?.pendingDelete || unchanged(kind, local, st)) {
        // Nothing here that the cloud has not seen: delete it here too.
        if (local) await this.vault.removeRemote(id)
        this.state.docs[key] = { rev, hash: null, deleted: true }
        this.dirty.delete(key)
      } else {
        // Edited here after it was deleted elsewhere: keep it and send it back.
        this.state.docs[key] = { rev, hash: st?.hash ?? null }
        this.dirty.add(key)
      }
      return
    }

    // Edited elsewhere after we deleted it: it comes back (shown as an orphan).
    const merged = await this.vault.applyRemote(kind, id, row.data)
    const h = syncHash(kind, row.data)
    this.state.docs[key] = { rev, hash: h }
    if (syncHash(kind, merged) !== h) this.dirty.add(key)
    else this.dirty.delete(key)
  }

  async pushDocs(remote) {
    for (const key of [...this.dirty]) {
      const { kind, id, docId } = parseKey(key)
      let st = this.state.docs[key] || { rev: 0, hash: null }

      if (st.pendingDelete) {
        if (!Number(st.rev)) {
          delete this.state.docs[key]
          this.dirty.delete(key)
          continue
        }
        if (this.guard.check(key, 'deleted')) continue
        const res = await remote.pushDoc({ kind, docId, data: null, expectedRev: Number(st.rev), deleted: true, device: this.vault.device })
        if (res?.ok) {
          this.guard.record(key, 'deleted')
          this.state.docs[key] = { rev: Number(res.rev), hash: null, deleted: true }
          this.dirty.delete(key)
        } else {
          const row = await remote.getDoc(kind, docId)
          if (row && !row.deleted) {
            delete st.pendingDelete
            await this.applyDoc(row, true)
          } else {
            this.state.docs[key] = { rev: Number(row?.rev || 0), hash: null, deleted: true }
            this.dirty.delete(key)
          }
        }
        continue
      }

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const cur = await this.vault.current(kind, id)
        if (!cur) {
          this.dirty.delete(key)
          break
        }
        const h = syncHash(kind, cur)
        if (unchanged(kind, cur, st)) {
          if (st.hash !== h) this.state.docs[key] = { ...st, hash: h }
          this.dirty.delete(key)
          break
        }
        // A loop: leave it saved here and dirty, it goes up after the pause.
        if (this.guard.check(key, h)) break
        const res = await remote.pushDoc({
          kind,
          docId,
          data: cur,
          expectedRev: Number(st.rev) || 0,
          deleted: false,
          device: this.vault.device,
        })
        if (res?.ok) {
          this.guard.record(key, h)
          this.state.docs[key] = { rev: Number(res.rev), hash: h }
          this.dirty.delete(key)
          this.progress()
          break
        }
        // Someone saved first: take theirs, merge, try again.
        const row = await remote.getDoc(kind, docId)
        if (row) await this.applyDoc(row, true)
        else this.state.docs[key] = { rev: 0, hash: null }
        st = this.state.docs[key]
      }
    }
  }

  /* ---------------- files ---------------- */

  async scanFiles() {
    const files = new Map()
    const known = new Set()
    const walk = async (rel) => {
      const entries = await fsp.readdir(path.join(this.dir, rel), { withFileTypes: true })
      for (const ent of entries) {
        if (isTemp(ent.name)) continue
        const r = `${rel}/${ent.name}`
        if (ent.isDirectory()) await walk(r)
        else if (ent.isFile()) {
          const full = path.join(this.dir, r)
          const st = await fsp.stat(full).catch(() => null)
          if (!st) continue
          const k = `${st.mtimeMs}:${st.size}`
          let cached = this.state.fileCache[r]
          if (!cached || cached.k !== k) {
            cached = { k, sha: sha1(await fsp.readFile(full)), size: st.size }
            this.state.fileCache[r] = cached
          }
          files.set(r, { sha: cached.sha, size: cached.size })
        }
      }
    }
    for (const root of FILE_ROOTS) {
      try {
        await walk(root)
        known.add(root)
      } catch (e) {
        if (e.code === 'ENOENT') known.add(root)
        else this.log('cloud: could not read', root, e)
      }
    }
    for (const p of Object.keys(this.state.fileCache)) if (!files.has(p) && known.has(p.split('/')[0])) delete this.state.fileCache[p]
    return { files, known }
  }

  async syncFiles(remote, full) {
    const local = await this.scanFiles()

    const rows = await remote.filesSince(this.state.fileCursor)
    for (const row of rows) {
      await this.applyFile(remote, row, local)
      this.state.fileCursor = Math.max(this.state.fileCursor, Number(row.change_seq))
    }
    if (full) {
      for (const row of await remote.fileRevs()) {
        const st = this.state.files[row.path]
        if (!st || Number(st.rev) < Number(row.rev)) await this.applyFile(remote, row, local)
      }
    }

    const skipped = []
    for (const [p, loc] of local.files) {
      if (this.state.files[p]?.sha === loc.sha) continue
      if (loc.size > MAX_FILE_BYTES) {
        skipped.push(p)
        continue
      }
      await this.pushFile(remote, p, local)
    }
    if (skipped.length) this.log('cloud: files over 50 MB are not synced', skipped)
    this.info.skipped = skipped

    // Files deleted here.
    for (const [p, st] of Object.entries(this.state.files)) {
      if (st.deleted || !st.sha || local.files.has(p) || !local.known.has(p.split('/')[0])) continue
      const res = await remote.pushFile({ path: p, sha: null, size: 0, expectedRev: Number(st.rev), deleted: true, device: this.vault.device })
      if (res?.ok) this.state.files[p] = { rev: Number(res.rev), sha: null, deleted: true }
      else {
        const row = await remote.getFile(p)
        if (row) await this.applyFile(remote, row, local, true)
      }
    }
  }

  async pushFile(remote, p, local) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const loc = local.files.get(p)
      const st = this.state.files[p]
      if (!loc || st?.sha === loc.sha) return
      if (this.guard.check(`file:${p}`, loc.sha)) return
      if (!(await remote.hasBlob(loc.sha))) {
        const buf = await fsp.readFile(path.join(this.dir, p))
        if (sha1(buf) !== loc.sha) return // changed while we looked; the next run sends it
        await remote.uploadBlob(loc.sha, buf)
      }
      const res = await remote.pushFile({
        path: p,
        sha: loc.sha,
        size: loc.size,
        expectedRev: Number(st?.rev) || 0,
        deleted: false,
        device: this.vault.device,
      })
      if (res?.ok) {
        this.guard.record(`file:${p}`, loc.sha)
        this.state.files[p] = { rev: Number(res.rev), sha: loc.sha }
        this.progress()
        return
      }
      const row = await remote.getFile(p)
      if (row) await this.applyFile(remote, row, local, true)
      else this.state.files[p] = { rev: 0, sha: null }
    }
  }

  /** A cloud version of a file. */
  async applyFile(remote, row, local, force = false) {
    const p = row.path
    if (!FILE_ROOTS.includes(p.split('/')[0]) || p.split('/').includes('..')) return
    const st = this.state.files[p]
    const rev = Number(row.rev)
    if (!force && st && Number(st.rev) >= rev) return
    const loc = local.files.get(p)
    const base = st?.sha ?? null
    const full = path.join(this.dir, p)

    if (row.deleted) {
      if (loc && loc.sha !== base) {
        // Changed here after it was deleted elsewhere: keep it, send it back.
        this.state.files[p] = { rev, sha: null }
        return
      }
      if (loc) {
        const dest = path.join(this.dir, '.trash', 'files', `${Date.now()}-${p.replace(/[\\/]/g, '__')}`)
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        await fsp.rename(full, dest).catch(() => {})
        local.files.delete(p)
        delete this.state.fileCache[p]
      }
      this.state.files[p] = { rev, sha: null, deleted: true }
      return
    }

    if (loc && loc.sha === row.sha) {
      this.state.files[p] = { rev, sha: row.sha }
      return
    }
    if (loc && loc.sha !== base) {
      // Both computers changed it: keep ours under a new name.
      const ext = path.extname(p)
      const conflict = `${p.slice(0, p.length - ext.length)} (conflict ${this.vault.device})${ext}`
      await fsp.rename(full, path.join(this.dir, conflict))
      local.files.set(conflict, loc)
      delete this.state.fileCache[p]
    }
    const buf = await remote.downloadBlob(row.sha)
    if (sha1(buf) !== row.sha) throw new Error(`cloud: download of ${p} was damaged`)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    const tmp = `${full}.cloud-dl-${process.pid}`
    await fsp.writeFile(tmp, buf)
    await fsp.rename(tmp, full)
    const stat = await fsp.stat(full)
    this.state.fileCache[p] = { k: `${stat.mtimeMs}:${stat.size}`, sha: row.sha, size: stat.size }
    local.files.set(p, { sha: row.sha, size: stat.size })
    this.state.files[p] = { rev, sha: row.sha }
    if (p.startsWith('assets/')) this.vault.emit({ type: 'asset', name: p.slice('assets/'.length) })
  }

  /* ---------------- state ---------------- */

  /** Saves what is done so far every few seconds, so a long first upload survives a restart. */
  progress() {
    if (Date.now() - (this.lastProgressSave || 0) < 3000) return
    this.lastProgressSave = Date.now()
    this.saveState()
  }

  async saveState() {
    if (!this.stateFile) return
    this.saving = (this.saving || Promise.resolve()).then(async () => {
      await fsp.mkdir(path.dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(this.state), 'utf8')
      await fsp.rename(tmp, this.stateFile)
    }).catch((e) => this.log('cloud: could not save state', e))
    return this.saving
  }
}
