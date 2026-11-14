/**
 * The storage backend the shared store (src/store.ts) runs on inside the
 * Android app: the phone's offline copy plus cloud sync.
 */
import type { Backend, ConflictList, LocalState, SearchHit, VaultEvent } from '../../../src/lib/storage'
import { pageIndex, searchPages, type SearchablePage } from '../../../shared/search-core.mjs'
import type { Page, Settings, Workspace } from '../../../src/types'
import { MobileVault } from './vault'
import { CloudSync } from './cloud'
import * as assets from './assets'

export const vault = new MobileVault()
export const cloud = new CloudSync(vault)

/* ---------------- search cache ---------------- */

let index: Map<string, SearchablePage> | null = null
let indexing: Promise<Map<string, SearchablePage>> | null = null
let treeCache: Workspace['tree'] = []

const slim = (id: string, p: Page): SearchablePage => ({
  id,
  title: p.title,
  updatedAt: p.updatedAt,
  cells: (p.cells || []).map((c) => ({ id: c.id, title: c.title, html: c.html })),
})

vault.onPageStored = (id, page) => {
  if (!index) return
  if (page) index.set(id, slim(id, page))
  else index.delete(id)
}

function searchIndex() {
  if (index) return Promise.resolve(index)
  indexing ??= vault.allPages().then((pages) => {
    index = new Map(pages.map((p) => [p.id, slim(p.id, p)]))
    return index
  })
  return indexing
}

/** Warm the search index in the background (first search is instant). */
export function warmSearch() {
  const idle = (window as any).requestIdleCallback || ((f: () => void) => setTimeout(f, 1500))
  idle(() => searchIndex())
}

/* ---------------- pictures on screen ---------------- */

/** Pages refer to pictures; missing ones are fetched while the page is open. */
function fetchImagesOf(page: Page | null) {
  if (!page) return
  const html = (page.cells || []).map((c) => c.html || '').join('')
  for (const name of assets.namesIn(html)) {
    assets.has(name).then((ok) => {
      if (!ok) cloud.download(`assets/${name}`)
    })
  }
}

const LOCAL_KEY = 'notes:local:mobile'
const NO_CONFLICTS: ConflictList = { cells: [], orphans: [] }

function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) return null
  return { bytes: assets.fromBase64(m[2]), ext: (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg') }
}

export const mobileBackend: Backend = {
  isDesktop: false,
  vaultPath: async () => 'this phone',
  chooseVault: async () => null,
  revealVault: async () => {},

  async readWorkspace() {
    const r = await vault.read<Workspace>('workspace')
    if (r.data) treeCache = r.data.tree || []
    return r
  },
  async writeWorkspace(w, base) {
    const r = await vault.write<Workspace>('workspace', undefined, w, base, null)
    if (r.data) treeCache = r.data.tree || []
    return r
  },
  readSettings: () => vault.read<Settings>('settings'),
  writeSettings: (s, base) => vault.write<Settings>('settings', undefined, s, base, null),

  async readPage(id) {
    const r = await vault.read<Page>('page', id)
    fetchImagesOf(r.data)
    return r.data ? { ...r, data: assets.toDisplay(r.data) } : r
  },
  async writePage(id, p, base, touched) {
    const r = await vault.write<Page>('page', id, assets.toStored(p), base ? assets.toStored(base) : null, touched)
    return r.data ? { ...r, data: assets.toDisplay(r.data) } : r
  },
  deletePage: (id) => vault.deletePage(id),

  async readLocal() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null') as LocalState | null
    } catch {
      return null
    }
  },
  async writeLocal(s) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(s))
    } catch {
      /* full: per phone state only */
    }
  },

  onVaultEvent(cb) {
    return vault.on((ev: VaultEvent) => {
      if (ev.type === 'workspace') treeCache = ev.data.tree || []
      if (ev.type === 'page') {
        fetchImagesOf(ev.data)
        cb({ ...ev, data: assets.toDisplay(ev.data) })
      } else cb(ev)
    })
  },

  async listConflicts() {
    const idx = await searchIndex()
    const pages = await vault.allPages()
    const alive = new Set(pageIndex(treeCache).keys())
    const cells: ConflictList['cells'] = []
    const orphans: ConflictList['orphans'] = []
    for (const p of pages) {
      const conflicted = (p.cells || []).filter((c) => c.conflict)
      if (alive.has(p.id)) {
        for (const c of conflicted)
          cells.push({ pageId: p.id, pageTitle: p.title || 'Untitled', cellId: c.id, cellTitle: c.title || 'Cell', reason: c.conflict!.reason, of: c.conflict!.of || null })
      } else if (treeCache.length && ((p.cells || []).length || (p.strokes || []).length)) {
        orphans.push({ pageId: p.id, title: p.title || 'Untitled', conflicts: conflicted.length })
      }
    }
    void idx
    return cells.length || orphans.length ? { cells, orphans } : NO_CONFLICTS
  },
  scanNow: () => cloud.syncNow(),
  syncStatus: async () => null,

  async saveAsset(dataUrl) {
    const d = dataUrlBytes(dataUrl)
    if (!d) return dataUrl
    const saved = await assets.save(d.bytes, d.ext)
    cloud.addOutgoingFile(`assets/${saved.name}`, saved.sha)
    return saved.shown
  },

  async search(q) {
    if (!q.trim()) return []
    const idx = await searchIndex()
    const info = pageIndex(treeCache)
    const pages: SearchablePage[] = []
    for (const [id, meta] of info) {
      const p = idx.get(id)
      if (p) pages.push({ ...p, path: meta.path })
    }
    return searchPages(q, pages).map((r) => ({ ...r, archived: Boolean(info.get(r.pageId)?.archived) })) as SearchHit[]
  },

  async exportFile(name, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    return name
  },
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  openFileDialog: async () => null,
  listArtifacts: async () => [],
  pickArtifactFile: async () => null,
  pickArtifactDirectory: async () => null,
  revealArtifact: async () => {},
}
