/**
 * One storage interface, two backends:
 *  - Electron: real files in the vault folder (the normal case).
 *  - Browser:  localStorage, so `npm run dev` in a plain browser still works.
 */
import type { Page, Settings, Workspace } from '../types'
import { pageIndex, searchPages, type SearchResult } from '../../shared/search-core.mjs'

/** A ranked search result, best first (see shared/search-core.mjs). */
export interface SearchHit extends SearchResult {
  archived?: boolean
}

/** What a read or write of a synced file gives back. */
export interface SyncResult<T> {
  /** The file as it is on disk now (merged with other computers' changes). */
  data: T | null
  /** Grows with every change the sync service makes; older news is ignored. */
  seq: number
  /** Nothing worth writing (only layout the app measured by itself). */
  skipped?: boolean
  /** The file could not be read. It is left alone. */
  damaged?: boolean
}

export interface Touched {
  all?: boolean
  cells?: string[]
  meta?: boolean
}

/** Per computer state, never synced. */
export interface LocalState {
  lastOpenPageId?: string
  recent?: string[]
  collapsed?: string[]
}

export interface ConflictCell {
  pageId: string
  pageTitle: string
  cellId: string
  cellTitle: string
  reason: 'edited-both' | 'deleted-elsewhere' | string
  of: string | null
}

export interface ConflictList {
  cells: ConflictCell[]
  /** Page files with no entry in the tree (deleted elsewhere but edited here). */
  orphans: { pageId: string; title: string; conflicts: number }[]
}

export interface SyncStatus {
  deviceId: string
  vault: string | null
  watching: boolean
  pollMs: number
  lastRemoteAt: number
  lastScanAt: number
}

export type VaultEvent =
  | { type: 'page'; id: string; data: Page; seq: number }
  | { type: 'workspace'; data: Workspace; seq: number }
  | { type: 'settings'; data: Settings; seq: number }
  | { type: 'page-removed'; id: string }
  | { type: 'asset'; name: string }
  | { type: 'conflicts'; list: ConflictList }

export interface ArtifactItem {
  name: string
  isDirectory: boolean
  relativePath: string
}

export interface PickedArtifact {
  relativePath: string
  name: string
  isDirectory: boolean
}

interface Backend {
  isDesktop: boolean
  vaultPath(): Promise<string>
  chooseVault(): Promise<string | null>
  revealVault(): Promise<void>
  readWorkspace(): Promise<SyncResult<Workspace>>
  writeWorkspace(w: Workspace, base: Workspace | null): Promise<SyncResult<Workspace>>
  readSettings(): Promise<SyncResult<Settings>>
  writeSettings(s: Settings, base: Settings | null): Promise<SyncResult<Settings>>
  readPage(id: string): Promise<SyncResult<Page>>
  writePage(id: string, p: Page, base: Page | null, touched: Touched | null): Promise<SyncResult<Page>>
  deletePage(id: string): Promise<void>
  readLocal(): Promise<LocalState | null>
  writeLocal(s: LocalState): Promise<void>
  /** Changes made by other computers. Returns an unsubscribe function. */
  onVaultEvent(cb: (ev: VaultEvent) => void): () => void
  listConflicts(): Promise<ConflictList>
  scanNow(): Promise<void>
  syncStatus(): Promise<SyncStatus | null>
  saveAsset(dataUrl: string): Promise<string | null>
  search(q: string): Promise<SearchHit[]>
  exportFile(name: string, content: string): Promise<string | null>
  openExternal(url: string): Promise<void>
  openFileDialog(): Promise<string | null>
  listArtifacts(subDir?: string, recursive?: boolean): Promise<ArtifactItem[]>
  pickArtifactFile(subDir?: string): Promise<PickedArtifact | null>
  pickArtifactDirectory(subDir?: string): Promise<PickedArtifact | null>
  revealArtifact(relativePath?: string): Promise<void>
}

const NO_CONFLICTS: ConflictList = { cells: [], orphans: [] }

const desktop = (window as any).notes

const electronBackend: Backend = {
  isDesktop: true,
  vaultPath: () => desktop.vault.get(),
  chooseVault: () => desktop.vault.choose(),
  revealVault: () => desktop.vault.reveal(),
  readWorkspace: () => desktop.workspace.read(),
  writeWorkspace: (w, base) => desktop.workspace.write(w, base),
  readSettings: () => desktop.settings.read(),
  writeSettings: (s, base) => desktop.settings.write(s, base),
  readPage: (id) => desktop.page.read(id),
  writePage: (id, p, base, touched) => desktop.page.write(id, p, base, touched),
  deletePage: (id) => desktop.page.remove(id),
  readLocal: () => desktop.local.read(),
  writeLocal: (s) => desktop.local.write(s),
  onVaultEvent: (cb) => desktop.sync.onEvent(cb),
  listConflicts: async () => (await desktop.sync.conflicts()) || NO_CONFLICTS,
  scanNow: () => desktop.sync.scan(),
  syncStatus: () => desktop.sync.status(),
  saveAsset: (d) => desktop.asset.save(d),
  search: (q) => desktop.search(q),
  exportFile: (n, c) => desktop.exportFile(n, c),
  openExternal: (url) => desktop.openExternal(url),
  openFileDialog: () => desktop.openFileDialog(),
  listArtifacts: (subDir, recursive) => (desktop?.artifacts ? desktop.artifacts.list(subDir, recursive) : Promise.resolve([])),
  pickArtifactFile: (subDir) => (desktop?.artifacts ? desktop.artifacts.pickFile(subDir) : Promise.resolve(null)),
  pickArtifactDirectory: (subDir) => (desktop?.artifacts ? desktop.artifacts.pickDirectory(subDir) : Promise.resolve(null)),
  revealArtifact: (rel) => (desktop?.artifacts ? desktop.artifacts.reveal(rel) : Promise.resolve()),
}

const LS = {
  get<T>(k: string, fb: T): T {
    try {
      const raw = localStorage.getItem(k)
      return raw ? (JSON.parse(raw) as T) : fb
    } catch {
      return fb
    }
  },
  set(k: string, v: unknown) {
    localStorage.setItem(k, JSON.stringify(v))
  },
}

const webBackend: Backend = {
  isDesktop: false,
  vaultPath: async () => 'browser storage',
  chooseVault: async () => null,
  revealVault: async () => {},
  readWorkspace: async () => ({ data: LS.get<Workspace | null>('notes:workspace', null), seq: 0 }),
  writeWorkspace: async (w) => (LS.set('notes:workspace', w), { data: w, seq: 0 }),
  readSettings: async () => ({ data: LS.get<Settings | null>('notes:settings', null), seq: 0 }),
  writeSettings: async (s) => (LS.set('notes:settings', s), { data: s, seq: 0 }),
  readPage: async (id) => ({ data: LS.get<Page | null>(`notes:page:${id}`, null), seq: 0 }),
  writePage: async (id, p) => (LS.set(`notes:page:${id}`, p), { data: p, seq: 0 }),
  deletePage: async (id) => localStorage.removeItem(`notes:page:${id}`),
  readLocal: async () => LS.get<LocalState | null>('notes:local', null),
  writeLocal: async (s) => LS.set('notes:local', s),
  onVaultEvent: () => () => {},
  listConflicts: async () => NO_CONFLICTS,
  scanNow: async () => {},
  syncStatus: async () => null,
  saveAsset: async (dataUrl) => dataUrl, // inline in the browser build
  async search(q) {
    if (!q.trim()) return []
    const index = pageIndex(LS.get<Workspace | null>('notes:workspace', null)?.tree || [])
    const pages = [...index].flatMap(([id, info]) => {
      const page = LS.get<Page | null>(`notes:page:${id}`, null)
      return page ? [{ ...page, id, path: info.path }] : []
    })
    return searchPages(q, pages).map((r) => ({ ...r, archived: Boolean(index.get(r.pageId)?.archived) }))
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
  async openFileDialog() {
    return null
  },
  async listArtifacts() {
    return []
  },
  async pickArtifactFile() {
    return null
  },
  async pickArtifactDirectory() {
    return null
  },
  async revealArtifact() {},
}

/**
 * Browser mode against `node server/server.mjs`: same notes folder as the
 * desktop app, so a tab and the window show the same notes.
 */
const httpBackend: Backend = {
  isDesktop: false,
  vaultPath: async () => (await getJson<{ path: string }>('/api/vault'))?.path || 'server',
  chooseVault: async () => null,
  revealVault: async () => {},
  readWorkspace: () => syncGet<Workspace>('/api/workspace'),
  writeWorkspace: (w, base) => syncPost<Workspace>('/api/workspace', { data: w, base }),
  readSettings: () => syncGet<Settings>('/api/settings'),
  writeSettings: (s, base) => syncPost<Settings>('/api/settings', { data: s, base }),
  async readPage(id) {
    return toBrowser(await syncGet<Page>(`/api/page/${encodeURIComponent(id)}`))
  },
  async writePage(id, p, base, touched) {
    const body = { data: toFile(p), base: base && toFile(base), touched }
    return toBrowser(await syncPost<Page>(`/api/page/${encodeURIComponent(id)}`, body))
  },
  async deletePage(id) {
    await fetch(`/api/page/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  readLocal: async () => LS.get<LocalState | null>('notes:local:server', null),
  writeLocal: async (s) => LS.set('notes:local:server', s),
  onVaultEvent(cb) {
    const es = new EventSource('/api/events')
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as VaultEvent
        if (ev.type === 'page') ev.data = toFile(ev.data, true)
        cb(ev)
      } catch {
        /* ignore malformed */
      }
    }
    return () => es.close()
  },
  listConflicts: async () => (await getJson<ConflictList>('/api/sync/conflicts')) || NO_CONFLICTS,
  async scanNow() {
    await fetch('/api/sync/scan', { method: 'POST' }).catch(() => {})
  },
  syncStatus: () => getJson<SyncStatus>('/api/sync/status'),
  async saveAsset(dataUrl) {
    const r = await fetch('/api/asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    })
    const j = await r.json()
    return j?.url || dataUrl
  },
  async search(q) {
    return (await getJson<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`)) || []
  },
  exportFile: webBackend.exportFile,
  openExternal: webBackend.openExternal,
  openFileDialog: webBackend.openFileDialog,
  listArtifacts: webBackend.listArtifacts,
  pickArtifactFile: webBackend.pickArtifactFile,
  pickArtifactDirectory: webBackend.pickArtifactDirectory,
  revealArtifact: webBackend.revealArtifact,
}

/**
 * Image sources are stored as asset://local/<file> so the desktop app can serve
 * them; in a browser the same files come from /media/<file>.
 */
function rewrite<T>(value: T, from: string, to: string): T {
  return JSON.parse(JSON.stringify(value).split(from).join(to))
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

/** Pages keep asset://local/ links on disk and /media/ links in a browser tab. */
function toFile(p: Page, toBrowserLinks = false): Page {
  return toBrowserLinks ? rewrite(p, 'asset://local/', '/media/') : rewrite(p, '/media/', 'asset://local/')
}

function toBrowser(r: SyncResult<Page>): SyncResult<Page> {
  return r.data ? { ...r, data: toFile(r.data, true) } : r
}

async function syncGet<T>(url: string): Promise<SyncResult<T>> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Reading ${url} failed (${r.status})`)
  return (await r.json()) as SyncResult<T>
}

/** Writes must not fail silently: the caller keeps the edits and retries. */
async function syncPost<T>(url: string, body: unknown): Promise<SyncResult<T>> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`Saving ${url} failed (${r.status})`)
  return (await r.json()) as SyncResult<T>
}

/** Chosen once at startup: desktop, the local server, or the browser itself. */
let active: Backend = desktop?.isDesktop ? electronBackend : webBackend

export async function pickBackend() {
  if (desktop?.isDesktop) return
  const probe = await getJson<{ path: string }>('/api/vault')
  if (probe?.path) active = httpBackend
}

export const storage: Backend = new Proxy({} as Backend, {
  get: (_t, key: string) => (active as any)[key],
})
export const isDesktop = Boolean(desktop?.isDesktop)

/** Cloud sync (Supabase) state, see shared/cloud-sync.mjs. Desktop only. */
export interface CloudStatus {
  phase: 'off' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error'
  email: string
  lastSyncAt: number
  lastError: string
  skipped: string[]
  pending: number
  signedIn: boolean
  url?: string
  key?: string
}

export const cloud = {
  available: Boolean(desktop?.cloud),
  status: (): Promise<CloudStatus | null> => (desktop?.cloud ? desktop.cloud.status() : Promise.resolve(null)),
  signIn: (url: string, key: string, email: string, password: string): Promise<{ ok: boolean; error?: string }> =>
    desktop?.cloud ? desktop.cloud.signIn(url, key, email, password) : Promise.resolve({ ok: false, error: 'Desktop app only' }),
  signOut: (): Promise<void> => (desktop?.cloud ? desktop.cloud.signOut() : Promise.resolve()),
  syncNow: (): Promise<void> => (desktop?.cloud ? desktop.cloud.syncNow() : Promise.resolve()),
  onStatus: (cb: (s: CloudStatus) => void): (() => void) => (desktop?.cloud ? desktop.cloud.onStatus(cb) : () => {}),
}
