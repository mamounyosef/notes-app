/**
 * Keeps the notes folder in step with what other computers write into it
 * through Google Drive (or any other folder sync).
 *
 *  - Watches the folder (file events plus a steady poll, since cloud drives
 *    do not always report changes) and tells the app about every page,
 *    tree or settings file that changed on disk without us writing it.
 *  - Every write merges with whatever is on disk at that moment, so a save
 *    never overwrites changes that just arrived.
 *  - Keeps a private copy of the last merged state of every file it handled
 *    (the journal, outside the synced folder). If a cloud drive ever replaces
 *    a file with an older copy, the journal is merged back in and nothing is
 *    lost.
 *  - Files the cloud drive renamed as duplicates ("page (1).json") are merged
 *    into the real file and moved to .trash.
 *
 * Plain Node, shared by the Electron main process and server/server.mjs.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import * as core from './sync-core.mjs'

const POLL_MS = 3000
const ORPHAN_GRACE_MS = 60_000
const DUP_RE = /^(.+?)\s*\((\d+)\)\.json$/
const sha = (text) => crypto.createHash('sha1').update(text).digest('hex')
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A random id for this computer, kept outside the synced folder. */
export function loadDeviceId(stateDir) {
  const file = path.join(stateDir, 'device-id')
  try {
    const id = fs.readFileSync(file, 'utf8').trim()
    if (/^[a-z0-9]{6,32}$/i.test(id)) return id
  } catch {
    /* first run */
  }
  const id = `d${crypto.randomBytes(6).toString('hex')}`
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(file, id, 'utf8')
  return id
}

function plainText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

const KINDS = {
  page: { merge: core.mergePages, adopt: core.adoptLegacyPage },
  workspace: { merge: core.mergeWorkspaces, adopt: core.adoptLegacyWorkspace },
  settings: { merge: core.mergeSettings, adopt: (d) => d },
}

export class VaultSync {
  /**
   * @param {{ stateDir: string, emit(ev: any): void, log?(...a: any[]): void }} opts
   */
  constructor({ stateDir, emit, log }) {
    this.stateDir = stateDir
    this.device = loadDeviceId(stateDir)
    this.emit = emit
    this.log = log || (() => {})
    this.vault = null
    this.queues = new Map()
    this.reset()
  }

  reset() {
    this.known = new Map() // file -> sha of the content we last wrote or handled
    this.stats = new Map() // file -> "mtime:size" when last handled
    this.titles = new Map() // pageId -> title, for every page file seen
    this.emptyPages = new Set() // pages with no cells and no ink
    this.conflictIndex = new Map() // pageId -> conflict cells
    this.wsCache = null
    this.assets = null
    this.seq = 0
    this.lastRemoteAt = 0
    this.lastScanAt = 0
    this.lastConflictKey = ''
  }

  /* ---------------- lifecycle ---------------- */

  setVault(vault) {
    this.stop()
    this.vault = path.resolve(vault)
    this.journalDir = path.join(this.stateDir, 'journal', sha(this.vault.toLowerCase()).slice(0, 16))
    this.reset()
    for (const d of ['pages', 'assets', '.trash']) fs.mkdirSync(path.join(this.vault, d), { recursive: true })
    fs.mkdirSync(path.join(this.journalDir, 'pages'), { recursive: true })
    this.ready = this.initialScan().catch((e) => this.log('sync: first scan failed', e))
    this.timer = setInterval(() => this.scan(), POLL_MS)
    try {
      this.watcher = fs.watch(this.vault, { recursive: true }, (_evt, name) => {
        const n = String(name || '')
        if (n.includes('.tmp') || n.startsWith('.trash')) return
        clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => this.scan(), 250)
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      this.watcher = null // polling still covers everything
    }
  }

  stop() {
    clearInterval(this.timer)
    clearTimeout(this.watchTimer)
    clearTimeout(this.conflictTimer)
    try {
      this.watcher?.close()
    } catch {
      /* ignore */
    }
    this.watcher = null
  }

  status() {
    return {
      deviceId: this.device,
      vault: this.vault,
      watching: Boolean(this.watcher),
      pollMs: POLL_MS,
      lastRemoteAt: this.lastRemoteAt,
      lastScanAt: this.lastScanAt,
    }
  }

  /* ---------------- paths ---------------- */

  file(kind, id) {
    if (kind === 'page') return path.join(this.vault, 'pages', `${safeId(id)}.json`)
    return path.join(this.vault, `${kind}.json`)
  }

  journal(kind, id) {
    if (kind === 'page') return path.join(this.journalDir, 'pages', `${safeId(id)}.json`)
    return path.join(this.journalDir, `${kind}.json`)
  }

  /* ---------------- low level io ---------------- */

  /** One operation at a time per file, in order. */
  queue(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    this.queues.set(key, tail)
    tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return next
  }

  async readText(file) {
    try {
      return await fsp.readFile(file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  /** Reads JSON, retrying a few times while a sync client is still writing. */
  async readJson(file) {
    for (let i = 0; i < 6; i++) {
      const text = await this.readText(file).catch(() => undefined)
      if (text === null) return { text: null, data: null }
      if (text !== undefined && text.trim()) {
        try {
          return { text, data: JSON.parse(text) }
        } catch {
          /* half written, try again */
        }
      }
      await sleep(150 + i * 100)
    }
    return { text: null, data: null, bad: true }
  }

  async statKey(file) {
    try {
      const st = await fsp.stat(file)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  async writeText(file, text) {
    this.known.set(file, sha(text))
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, text, 'utf8')
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(tmp, file)
        break
      } catch (e) {
        // A sync client can hold the file open for a moment on Windows.
        if (i >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
          await fsp.rm(tmp, { force: true }).catch(() => {})
          throw e
        }
        await sleep(100 + i * 100)
      }
    }
    const key = await this.statKey(file)
    if (key) this.stats.set(file, key)
  }

  async readJournal(kind, id) {
    try {
      return JSON.parse(await fsp.readFile(this.journal(kind, id), 'utf8'))
    } catch {
      return null
    }
  }

  async writeJournal(kind, id, data) {
    const file = this.journal(kind, id)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8')
    await fsp.rename(tmp, file)
  }

  async moveToTrash(file, name) {
    const dest = path.join(this.vault, '.trash', name)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.rename(file, dest)
  }

  /** Damaged files are set aside instead of being overwritten. */
  async setAsideDamaged(file) {
    const base = path.basename(file, '.json')
    await this.moveToTrash(file, `${base}-damaged-${Date.now()}.json`).catch(() => {})
    this.log('sync: set aside a damaged file', file)
  }

  /* ---------------- reads ---------------- */

  async read(kind, id) {
    await this.ready
    const file = this.file(kind, id)
    return this.queue(file, async () => {
      let r = await this.readJson(file)
      if (r.bad) return { data: null, damaged: true, seq: this.seq }
      if (!r.data && kind === 'page') {
        const restored = await this.restoreFromTrash(id)
        if (restored) r = await this.readJson(file)
      }
      if (!r.data) return { data: null, seq: this.seq }
      this.known.set(file, sha(r.text))
      const key = await this.statKey(file)
      if (key) this.stats.set(file, key)
      this.track(kind, id, r.data)
      return { data: r.data, seq: this.seq }
    })
  }

  /** A page that exists in the tree but whose file was trashed elsewhere. */
  async restoreFromTrash(id) {
    const dir = path.join(this.vault, '.trash')
    const names = await fsp.readdir(dir).catch(() => [])
    const prefix = `${safeId(id)}-`
    const hits = names
      .filter((n) => n.startsWith(prefix) && n.endsWith('.json') && /^\d+$/.test(n.slice(prefix.length, -5)))
      .sort((a, b) => Number(b.slice(prefix.length, -5)) - Number(a.slice(prefix.length, -5)))
    if (!hits.length) return false
    await fsp.rename(path.join(dir, hits[0]), this.file('page', id)).catch(() => {})
    this.log('sync: restored a page from .trash', id)
    return true
  }

  /* ---------------- writes ---------------- */

  /**
   * Saves local edits. `base` is the version the edits started from. The
   * result is what is on disk afterwards, merged with anything that arrived.
   */
  async write(kind, id, data, base, touched) {
    await this.ready
    const file = this.file(kind, id)
    return this.queue(file, async () => {
      const now = Date.now()
      let stamped
      let bumped
      if (kind === 'page') ({ page: stamped, bumped } = core.stampPage(base, data, this.device, touched, now))
      else if (kind === 'workspace') ({ workspace: stamped, bumped } = core.stampWorkspace(base, data, this.device, now))
      else ({ settings: stamped, bumped } = core.stampSettings(base, data, now))

      let disk = await this.readJson(file)
      if (disk.bad) {
        await this.setAsideDamaged(file)
        disk = { text: null, data: null }
      }
      if (!bumped && base && disk.data) return { data: null, skipped: true, seq: this.seq }

      const k = KINDS[kind]
      const journal = await this.readJournal(kind, id)
      let merged = stamped
      if (disk.data) merged = k.merge(merged, k.adopt(disk.data, base || journal, now), 'a')
      if (journal) merged = k.merge(merged, journal, 'a')

      const text = JSON.stringify(merged, null, 2)
      if (text !== disk.text) await this.writeText(file, text)
      else this.known.set(file, sha(text))
      await this.writeJournal(kind, id, merged)
      this.seq++
      this.track(kind, id, merged)
      return { data: merged, seq: this.seq }
    })
  }

  async deletePage(id) {
    await this.ready
    const file = this.file('page', id)
    return this.queue(file, async () => {
      if (fs.existsSync(file)) await this.moveToTrash(file, `${safeId(id)}-${Date.now()}.json`).catch(() => {})
      await fsp.rm(this.journal('page', id), { force: true }).catch(() => {})
      this.known.delete(file)
      this.stats.delete(file)
      this.titles.delete(id)
      this.conflictIndex.delete(id)
      this.scheduleConflicts()
      return true
    })
  }

  /* ---------------- watching ---------------- */

  async initialScan() {
    // Remember what is there now, so only later changes count as news.
    for (const kind of ['workspace', 'settings']) {
      const file = this.file(kind)
      const key = await this.statKey(file)
      if (key) this.stats.set(file, key)
    }
    const r = await this.readJson(this.file('workspace'))
    if (r.data) this.wsCache = r.data

    const dir = path.join(this.vault, 'pages')
    const names = await fsp.readdir(dir).catch(() => [])
    await this.eachLimited(names, async (name) => {
      if (!name.endsWith('.json') || DUP_RE.test(name)) return
      const id = name.slice(0, -5)
      if (safeId(id) !== id) return
      const file = path.join(dir, name)
      const key = await this.statKey(file)
      if (key) this.stats.set(file, key)
      const p = await this.readJson(file)
      if (p.data) this.indexPage(id, p.data)
    })
    this.assets = new Set(await fsp.readdir(path.join(this.vault, 'assets')).catch(() => []))

    // Anything this computer saved that a cloud drive replaced while the app
    // was closed is merged back now.
    for (const kind of ['workspace', 'settings']) {
      if (await this.readJournal(kind)) await this.reconcile(kind, undefined, true)
    }
    const jnames = await fsp.readdir(path.join(this.journalDir, 'pages')).catch(() => [])
    for (const n of jnames) if (n.endsWith('.json')) await this.reconcile('page', n.slice(0, -5), true)

    this.scheduleConflicts(0)
  }

  async eachLimited(items, fn, limit = 16) {
    let i = 0
    const run = async () => {
      while (i < items.length) await fn(items[i++])
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  }

  /** Resolves once the folder has been looked at after this call. */
  scan() {
    if (!this.vault) return Promise.resolve()
    if (this.scanning) {
      this.rescan = true
      return this.scanning
    }
    this.scanning = (async () => {
      try {
        await this.ready
        do {
          this.rescan = false
          await this.scanOnce()
        } while (this.rescan)
        this.lastScanAt = Date.now()
        // Pages without a tree entry only count as orphans after a grace period.
        this.scheduleConflicts()
      } catch (e) {
        this.log('sync: scan failed', e)
      } finally {
        this.scanning = null
      }
    })()
    return this.scanning
  }

  async scanOnce() {
    const vault = this.vault
    for (const kind of ['workspace', 'settings']) {
      const file = this.file(kind)
      const key = await this.statKey(file)
      if (key && key !== this.stats.get(file)) await this.reconcile(kind)
    }

    const rootNames = await fsp.readdir(vault).catch(() => [])
    for (const n of rootNames) {
      const m = DUP_RE.exec(n)
      if (m && (m[1] === 'workspace' || m[1] === 'settings')) await this.mergeDuplicate(m[1], undefined, path.join(vault, n))
    }

    const dir = path.join(vault, 'pages')
    const names = await fsp.readdir(dir).catch(() => null)
    if (names) {
      const present = new Set()
      await this.eachLimited(names, async (name) => {
        if (!name.endsWith('.json')) return
        const dup = DUP_RE.exec(name)
        if (dup) {
          if (safeId(dup[1]) === dup[1]) await this.mergeDuplicate('page', dup[1], path.join(dir, name))
          return
        }
        const id = name.slice(0, -5)
        if (safeId(id) !== id) return
        const file = path.join(dir, name)
        present.add(file)
        const key = await this.statKey(file)
        if (key && key !== this.stats.get(file)) await this.reconcile('page', id)
      })
      for (const file of [...this.stats.keys()]) {
        if (path.dirname(file) !== dir || present.has(file)) continue
        this.stats.delete(file)
        this.known.delete(file)
        const id = path.basename(file, '.json')
        this.titles.delete(id)
        this.conflictIndex.delete(id)
        this.scheduleConflicts()
        this.emit({ type: 'page-removed', id })
      }
    }

    const assets = await fsp.readdir(path.join(vault, 'assets')).catch(() => null)
    if (assets && this.assets) {
      for (const name of assets) if (!this.assets.has(name)) this.emit({ type: 'asset', name })
      this.assets = new Set(assets)
    }
  }

  /**
   * A file changed on disk. Merge it with our journal; if the journal had
   * something the file lacks (an older copy came in), write the merge back.
   */
  async reconcile(kind, id, force = false) {
    const file = this.file(kind, id)
    return this.queue(file, async () => {
      const key = await this.statKey(file)
      if (!key) return
      const r = await this.readJson(file)
      if (r.bad || !r.data) return // half written: the next scan tries again
      this.stats.set(file, key)
      const h = sha(r.text)
      if (!force && this.known.get(file) === h) return
      this.known.set(file, h)

      const k = KINDS[kind]
      const now = Date.now()
      const journal = await this.readJournal(kind, id)
      let data = r.data
      if (journal) {
        const disk = k.adopt(r.data, journal, now)
        const merged = k.merge(journal, disk, 'b')
        if (core.stable(merged) !== core.stable(disk)) {
          await this.writeText(file, JSON.stringify(merged, null, 2))
          this.log('sync: merged local changes back into', file)
        }
        data = merged
      }
      await this.writeJournal(kind, id, data)
      this.track(kind, id, data)
      if (!force || core.stable(data) !== core.stable(r.data)) {
        this.seq++
        this.lastRemoteAt = now
        this.emit({ type: kind, id, data, seq: this.seq })
      }
    })
  }

  /** "page (1).json" and friends: fold into the real file, then trash. */
  async mergeDuplicate(kind, id, dupFile) {
    const file = this.file(kind, id)
    return this.queue(file, async () => {
      const dup = await this.readJson(dupFile)
      if (dup.bad || !dup.data) return
      const k = KINDS[kind]
      const now = Date.now()
      const main = await this.readJson(file)
      const journal = await this.readJournal(kind, id)
      const ref = journal || (main.data && !main.bad ? main.data : null)
      let merged = k.adopt(dup.data, ref, now)
      if (main.data) merged = k.merge(k.adopt(main.data, ref, now), merged, 'a')
      if (journal) merged = k.merge(merged, journal, 'a')
      await this.writeText(file, JSON.stringify(merged, null, 2))
      await this.writeJournal(kind, id, merged)
      await this.moveToTrash(dupFile, `conflict-${Date.now()}-${path.basename(dupFile)}`).catch(() => {})
      this.log('sync: merged a duplicate file made by the cloud drive', dupFile)
      this.track(kind, id, merged)
      this.seq++
      this.lastRemoteAt = now
      this.emit({ type: kind, id, data: merged, seq: this.seq })
    })
  }

  /* ---------------- conflict list ---------------- */

  track(kind, id, data) {
    if (kind === 'page') this.indexPage(id, data)
    else if (kind === 'workspace') {
      this.wsCache = data
      this.scheduleConflicts()
    }
  }

  indexPage(id, page) {
    this.titles.set(id, page.title || 'Untitled')
    // An empty page can hold no lost work, so it is never flagged as an orphan.
    if ((page.cells || []).length || (page.strokes || []).length) this.emptyPages.delete(id)
    else this.emptyPages.add(id)
    const cells = (page.cells || [])
      .filter((c) => c.conflict)
      .map((c) => ({
        cellId: c.id,
        cellTitle: c.title || plainText(c.html).slice(0, 80) || 'Empty cell',
        reason: c.conflict.reason,
        of: c.conflict.of || null,
      }))
    if (cells.length) this.conflictIndex.set(id, cells)
    else this.conflictIndex.delete(id)
    this.scheduleConflicts()
  }

  async listConflicts() {
    await this.ready
    const alive = new Set(core.flattenTree(this.wsCache?.tree || []).keys())
    const cells = []
    for (const [pageId, list] of this.conflictIndex) {
      if (!alive.has(pageId)) continue
      for (const c of list) cells.push({ pageId, pageTitle: this.titles.get(pageId) || 'Untitled', ...c })
    }
    const orphans = []
    if (this.wsCache) {
      const now = Date.now()
      for (const [pageId, title] of this.titles) {
        if (alive.has(pageId) || this.emptyPages.has(pageId)) continue
        const key = this.stats.get(this.file('page', pageId))
        const mtime = key ? Number(key.split(':')[0]) : 0
        if (now - mtime < ORPHAN_GRACE_MS) continue // its tree entry may still be on the way
        orphans.push({ pageId, title, conflicts: (this.conflictIndex.get(pageId) || []).length })
      }
    }
    return { cells, orphans }
  }

  scheduleConflicts(ms = 400) {
    clearTimeout(this.conflictTimer)
    this.conflictTimer = setTimeout(async () => {
      const list = await this.listConflicts()
      const key = core.stable(list)
      if (key === this.lastConflictKey) return
      this.lastConflictKey = key
      this.emit({ type: 'conflicts', list })
    }, ms)
  }
}
