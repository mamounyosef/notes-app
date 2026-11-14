/**
 * Syncs the phone's copy with the cloud. A port of shared/cloud-sync.mjs with
 * the same rules, so the phone behaves like one more computer:
 *  - the phone copy is the working copy: the app reads and saves locally and
 *    works the same with no internet;
 *  - every run first pulls what others saved and merges it in, then pushes
 *    what changed here;
 *  - a push only lands on top of the latest cloud version (compare and swap on
 *    `rev`); if another device got there first, its version is pulled, merged
 *    and pushed again;
 *  - the loop guard (shared/push-guard.mjs) stops a sync loop.
 *
 * Phone differences, to save data, storage and battery:
 *  - images download only when a page shows them (or in the background when
 *    "keep images offline" is on), never all at start;
 *  - files are never deleted from the cloud by the phone, and artifacts (the
 *    assistant's folders) are not synced;
 *  - live updates and polling stop while the app is in the background.
 */
import * as core from '../../../shared/sync-core.mjs'
import { PushGuard, pausedMessage, type PausedItem } from '../../../shared/push-guard.mjs'
import type { MobileVault, Kind } from './vault'
import type { Remote } from './remote'
import * as idb from './idb'
import * as assets from './assets'

const PUSH_DELAY_MS = 1200
const POLL_MS = 60_000
const FULL_CHECK_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
const REFUSED = Symbol('refused')

export interface CloudStatus {
  phase: 'off' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error'
  email: string
  lastSyncAt: number
  lastError: string
  paused: PausedItem[]
  pending: number
  signedIn: boolean
  /** Pull progress on the first sync (notes received so far). */
  received: number
  firstSyncDone: boolean
}

interface DocState {
  rev: number
  hash: string | null
  deleted?: boolean
  pendingDelete?: boolean
}
interface FileState {
  rev: number
  sha: string | null
  deleted?: boolean
  size?: number
}
interface State {
  userId: string | null
  docCursor: number
  fileCursor: number
  docs: Record<string, DocState>
  /** What the cloud has, per path ("assets/<name>"). */
  files: Record<string, FileState>
  /** Images made on this phone and not uploaded yet: path -> sha. */
  outbox: Record<string, string>
  firstSyncDone?: boolean
}

const emptyState = (): State => ({ userId: null, docCursor: 0, fileCursor: 0, docs: {}, files: {}, outbox: {} })
const syncHash = (kind: Kind, data: unknown) => (kind === 'page' && data ? 'v2:' : '') + core.hash(core.stable(core.syncView(kind, data)))
const unchanged = (kind: Kind, data: unknown, st?: DocState) => Boolean(st?.hash) && syncHash(kind, data) === st!.hash
const keyOf = (kind: Kind, id?: string) => `${kind}:${id || ''}`
const parseKey = (key: string) => {
  const i = key.indexOf(':')
  const kind = key.slice(0, i) as Kind
  const id = key.slice(i + 1)
  return { kind, id: kind === 'page' ? id : undefined, docId: id }
}

function offlineError(e: any) {
  const msg = String(e?.message || e)
  return !navigator.onLine || /fetch|network|Failed to fetch|NetworkError|timeout|ERR_|socket|Load failed/i.test(msg)
}

export class CloudSync {
  remote: Remote | null = null
  state: State = emptyState()
  dirty = new Set<string>()
  failures = 0
  lastFullAt = 0
  guard = new PushGuard()
  info: CloudStatus = { phase: 'off', email: '', lastSyncAt: 0, lastError: '', paused: [], pending: 0, signedIn: false, received: 0, firstSyncDone: false }
  private listeners = new Set<(s: CloudStatus) => void>()
  private timer: any = null
  private poll: any = null
  private unsubscribe: (() => void) | null = null
  private running: Promise<void> | null = null
  private again = false
  private loaded: Promise<void>
  private active = true
  private lastProgressSave = 0
  private downloading = new Map<string, Promise<boolean>>()

  constructor(private vault: MobileVault) {
    this.loaded = (async () => {
      const s = await idb.get<State>('meta', 'cloud')
      if (s) this.state = { ...emptyState(), ...s }
      this.info.firstSyncDone = Boolean(this.state.firstSyncDone)
    })()
    vault.onLocalChange = (kind, id, info) => this.markDirty(kind, id, info)
  }

  onStatus(cb: (s: CloudStatus) => void) {
    this.listeners.add(cb)
    cb(this.status())
    return () => this.listeners.delete(cb)
  }

  status(): CloudStatus {
    return { ...this.info, pending: this.dirty.size + Object.keys(this.state.outbox).length, signedIn: Boolean(this.remote) }
  }

  private setInfo(patch: Partial<CloudStatus>) {
    Object.assign(this.info, patch)
    const s = this.status()
    for (const cb of this.listeners) cb(s)
  }

  /** Signed in (a remote) or signed out (null). */
  setRemote(remote: Remote | null) {
    this.stopLive()
    this.remote = remote
    if (!remote) {
      this.setInfo({ phase: 'off', email: '' })
      return
    }
    this.lastFullAt = 0
    if (this.active) this.startLive()
    this.schedule(0)
  }

  /** The app went to the background (false) or came back (true). */
  setActive(on: boolean) {
    if (this.active === on) return
    this.active = on
    if (!this.remote) return
    if (on) {
      this.startLive()
      this.schedule(0)
    } else {
      this.stopLive()
      // Last chance to send what was typed before the app was put away.
      if (this.dirty.size || Object.keys(this.state.outbox).length) this.schedule(0)
    }
  }

  private startLive() {
    if (!this.remote) return
    this.stopLive()
    this.poll = setInterval(() => this.schedule(0), POLL_MS)
    try {
      this.unsubscribe = this.remote.subscribe(
        () => this.schedule(400),
        (st) => {
          if (st === 'SUBSCRIBED') this.schedule(0)
        },
      )
    } catch (e) {
      console.warn('cloud: live updates unavailable', e)
    }
  }

  private stopLive() {
    clearInterval(this.poll)
    this.poll = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  markDirty(kind: Kind, id: string | undefined, info?: { deleted?: boolean }) {
    const key = keyOf(kind, id)
    if (info?.deleted) {
      this.state.docs[key] = { ...(this.state.docs[key] || { rev: 0, hash: null }), pendingDelete: true }
      this.saveState()
    }
    this.dirty.add(key)
    this.setInfo({})
    this.schedule(PUSH_DELAY_MS)
  }

  /** A picture made on this phone: uploaded on the next run. */
  addOutgoingFile(path: string, sha: string) {
    this.state.outbox[path] = sha
    this.saveState()
    this.schedule(PUSH_DELAY_MS)
  }

  schedule(ms: number) {
    if (!this.remote) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.syncNow(), ms)
  }

  syncNow(): Promise<void> {
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

  private async upload<T>(key: string, push: () => Promise<T>): Promise<T | typeof REFUSED> {
    try {
      return await push()
    } catch (e) {
      if (this.guard.refused(key, e)) return REFUSED
      throw e
    }
  }

  private async runOnce() {
    const remote = this.remote
    await this.loaded
    if (!remote) return
    clearTimeout(this.timer)
    this.setInfo({ phase: 'syncing' })
    try {
      const session = await remote.session()
      if (!session) {
        this.setInfo({ phase: 'signed-out', email: '' })
        return
      }
      if (this.state.userId !== session.userId) {
        this.state = { ...emptyState(), userId: session.userId }
        this.lastFullAt = 0
      }
      this.info.email = session.email
      await this.vault.ready

      const full = Date.now() - this.lastFullAt > FULL_CHECK_MS
      if (full) for (const [kind, id] of await this.vault.listDocs()) this.dirty.add(keyOf(kind, id))

      await this.pullDocs(remote, full)
      if (!this.state.firstSyncDone) {
        this.state.firstSyncDone = true
        this.info.firstSyncDone = true
      }
      await this.pushDocs(remote)
      await this.syncFiles(remote, full)

      if (full) this.lastFullAt = Date.now()
      this.failures = 0
      const paused = this.guard.pausedItems()
      this.setInfo({ phase: paused.length ? 'error' : 'idle', lastSyncAt: Date.now(), lastError: pausedMessage(paused), paused })
    } catch (e: any) {
      this.failures++
      const offline = offlineError(e)
      console.warn('cloud: sync failed', e)
      this.setInfo({ phase: offline ? 'offline' : 'error', lastError: offline ? '' : String(e?.message || e) })
      this.schedule(Math.min(5000 * 2 ** (this.failures - 1), 120_000))
    } finally {
      await this.saveState()
    }
  }

  /* ---------------- notes ---------------- */

  private async pullDocs(remote: Remote, full: boolean) {
    const rows = await remote.docsSince(this.state.docCursor)
    let n = 0
    for (const row of rows) {
      await this.applyDoc(row)
      this.state.docCursor = Math.max(this.state.docCursor, Number(row.change_seq))
      if (++n % 10 === 0) {
        this.setInfo({ received: n })
        this.progress()
      }
    }
    if (!full) return
    for (const r of await remote.docRevs()) {
      const st = this.state.docs[keyOf(r.kind, r.doc_id)]
      if (st && Number(st.rev) >= Number(r.rev)) continue
      const row = await remote.getDoc(r.kind, r.doc_id)
      if (row) await this.applyDoc(row)
    }
  }

  private async applyDoc(row: any, force = false) {
    const key = keyOf(row.kind, row.doc_id)
    const { kind, id } = parseKey(key)
    if (kind !== 'page' && kind !== 'workspace' && kind !== 'settings') return
    const st = this.state.docs[key]
    const rev = Number(row.rev)
    if (!force && st && Number(st.rev) >= rev) return

    if (row.deleted) {
      if (kind !== 'page') {
        this.state.docs[key] = { ...(st || { hash: null }), rev, hash: st?.hash ?? null }
        return
      }
      const local = await this.vault.current(kind, id)
      if (!local || st?.pendingDelete || unchanged(kind, local, st)) {
        if (local) await this.vault.removeRemote(id!)
        this.state.docs[key] = { rev, hash: null, deleted: true }
        this.dirty.delete(key)
      } else {
        this.state.docs[key] = { rev, hash: st?.hash ?? null }
        this.dirty.add(key)
      }
      return
    }

    const merged = await this.vault.applyRemote(kind, id, row.data)
    const h = syncHash(kind, row.data)
    this.state.docs[key] = { rev, hash: h }
    if (syncHash(kind, merged) !== h) this.dirty.add(key)
    else this.dirty.delete(key)
  }

  private async pushDocs(remote: Remote) {
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
        const res = await this.upload(key, () =>
          remote.pushDoc({ kind, docId, data: null, expectedRev: Number(st.rev), deleted: true, device: this.vault.device }),
        )
        if (res === REFUSED) continue
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
          this.dirty.delete(key)
          break
        }
        if (this.guard.check(key, h)) break
        const res = await this.upload(key, () =>
          remote.pushDoc({ kind, docId, data: cur, expectedRev: Number(st.rev) || 0, deleted: false, device: this.vault.device }),
        )
        if (res === REFUSED) break
        if (res?.ok) {
          this.guard.record(key, h)
          this.state.docs[key] = { rev: Number(res.rev), hash: h }
          this.dirty.delete(key)
          this.progress()
          break
        }
        const row = await remote.getDoc(kind, docId)
        if (row) await this.applyDoc(row, true)
        else this.state.docs[key] = { rev: 0, hash: null }
        st = this.state.docs[key]
      }
    }
    this.setInfo({})
  }

  /* ---------------- files (images) ---------------- */

  private async syncFiles(remote: Remote, full: boolean) {
    // What the cloud has: remembered, downloaded only when needed.
    const rows = await remote.filesSince(this.state.fileCursor)
    const fresh: string[] = []
    for (const row of rows) {
      this.noteFile(row)
      if (!row.deleted && String(row.path).startsWith('assets/')) fresh.push(row.path)
      this.state.fileCursor = Math.max(this.state.fileCursor, Number(row.change_seq))
    }
    if (full) for (const row of await remote.fileRevs()) this.noteFile(row)

    // A changed image already on the phone is refreshed.
    for (const p of fresh) {
      const name = p.slice('assets/'.length)
      const st = this.state.files[p]
      if (st?.sha && (await assets.has(name)) && (await assets.sha1Of(name)) !== st.sha) await this.download(p, true)
    }

    // Pictures added on this phone go up.
    for (const [p, sha] of Object.entries(this.state.outbox)) {
      const name = p.slice('assets/'.length)
      if (this.guard.check(`file:${p}`, sha)) continue
      if (!(await remote.hasBlob(sha))) {
        const bytes = await assets.read(name)
        if (!bytes) {
          delete this.state.outbox[p]
          continue
        }
        await remote.uploadBlob(sha, bytes)
      }
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const st = this.state.files[p]
        if (st?.sha === sha) break
        const res = await this.upload(`file:${p}`, () =>
          remote.pushFile({ path: p, sha, size: assets.sizeHint(name), expectedRev: Number(st?.rev) || 0, deleted: false, device: this.vault.device }),
        )
        if (res === REFUSED) break
        if (res?.ok) {
          this.guard.record(`file:${p}`, sha)
          this.state.files[p] = { rev: Number(res.rev), sha }
          break
        }
        const row = await remote.getFile(p)
        if (row) this.noteFile(row, true)
        else this.state.files[p] = { rev: 0, sha: null }
      }
      if (this.state.files[p]?.sha === sha) delete this.state.outbox[p]
    }
  }

  private noteFile(row: any, force = false) {
    const p = String(row.path || '')
    if (!p.startsWith('assets/') || p.split('/').includes('..')) return
    const st = this.state.files[p]
    const rev = Number(row.rev)
    if (!force && st && Number(st.rev) >= rev) return
    this.state.files[p] = row.deleted ? { rev, sha: null, deleted: true } : { rev, sha: row.sha, size: Number(row.size) || 0 }
  }

  /** Brings one image to the phone. True when it is there afterwards. */
  download(path: string, force = false): Promise<boolean> {
    const name = path.slice('assets/'.length)
    const running = this.downloading.get(path)
    if (running) return running
    const job = (async () => {
      const remote = this.remote
      if (!remote) return false
      if (!force && (await assets.has(name))) return true
      let st = this.state.files[path]
      if (!st?.sha) {
        const row = await remote.getFile(path).catch(() => null)
        if (row) this.noteFile(row, true)
        st = this.state.files[path]
      }
      if (!st?.sha) return false
      const bytes = await remote.downloadBlob(st.sha)
      if ((await assets.sha1(bytes)) !== st.sha) throw new Error(`download of ${path} was damaged`)
      await assets.write(name, bytes)
      this.vault.emit({ type: 'asset', name })
      return true
    })()
      .catch((e) => {
        console.warn('cloud: image download failed', path, e)
        return false
      })
      .finally(() => this.downloading.delete(path))
    this.downloading.set(path, job)
    return job
  }

  /** Every image the cloud has that the phone lacks (for "keep images offline"). */
  async missingImages(): Promise<string[]> {
    await this.loaded
    const out: string[] = []
    for (const [p, st] of Object.entries(this.state.files)) {
      if (st.deleted || !st.sha || !p.startsWith('assets/')) continue
      if (!(await assets.has(p.slice(7)))) out.push(p)
    }
    return out
  }

  /** Total size of images in the cloud, in bytes (for the settings page). */
  cloudImageBytes(): number {
    return Object.values(this.state.files).reduce((n, f) => n + (f.deleted ? 0 : f.size || 0), 0)
  }

  /** Forgets everything about the account (sign out). */
  async reset() {
    this.state = emptyState()
    this.dirty.clear()
    this.info.firstSyncDone = false
    await this.saveState()
  }

  private progress() {
    if (Date.now() - this.lastProgressSave < 3000) return
    this.lastProgressSave = Date.now()
    this.saveState()
  }

  private saving: Promise<void> = Promise.resolve()
  saveState(): Promise<void> {
    this.saving = this.saving
      .then(() => idb.put('meta', 'cloud', JSON.parse(JSON.stringify(this.state))))
      .catch((e) => console.warn('cloud: could not save state', e))
    return this.saving
  }
}
