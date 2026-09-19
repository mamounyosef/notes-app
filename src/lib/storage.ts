/**
 * One storage interface, two backends:
 *  - Electron: real files in the vault folder (the normal case).
 *  - Browser:  localStorage, so `npm run dev` in a plain browser still works.
 */
import type { Page, Settings, Workspace } from '../types'

export interface SearchHit {
  pageId: string
  title: string
  hits: { cellId: string; cellTitle: string; snippet: string }[]
}

interface Backend {
  isDesktop: boolean
  vaultPath(): Promise<string>
  chooseVault(): Promise<string | null>
  revealVault(): Promise<void>
  readWorkspace(): Promise<Workspace | null>
  writeWorkspace(w: Workspace): Promise<void>
  readSettings(): Promise<Settings | null>
  writeSettings(s: Settings): Promise<void>
  readPage(id: string): Promise<Page | null>
  writePage(id: string, p: Page): Promise<void>
  deletePage(id: string): Promise<void>
  saveAsset(dataUrl: string): Promise<string | null>
  search(q: string): Promise<SearchHit[]>
  exportFile(name: string, content: string): Promise<string | null>
}

const desktop = (window as any).notes

const electronBackend: Backend = {
  isDesktop: true,
  vaultPath: () => desktop.vault.get(),
  chooseVault: () => desktop.vault.choose(),
  revealVault: () => desktop.vault.reveal(),
  readWorkspace: () => desktop.workspace.read(),
  writeWorkspace: (w) => desktop.workspace.write(w),
  readSettings: () => desktop.settings.read(),
  writeSettings: (s) => desktop.settings.write(s),
  readPage: (id) => desktop.page.read(id),
  writePage: (id, p) => desktop.page.write(id, p),
  deletePage: (id) => desktop.page.remove(id),
  saveAsset: (d) => desktop.asset.save(d),
  search: (q) => desktop.search(q),
  exportFile: (n, c) => desktop.exportFile(n, c),
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
  readWorkspace: async () => LS.get<Workspace | null>('notes:workspace', null),
  writeWorkspace: async (w) => LS.set('notes:workspace', w),
  readSettings: async () => LS.get<Settings | null>('notes:settings', null),
  writeSettings: async (s) => LS.set('notes:settings', s),
  readPage: async (id) => LS.get<Page | null>(`notes:page:${id}`, null),
  writePage: async (id, p) => LS.set(`notes:page:${id}`, p),
  deletePage: async (id) => localStorage.removeItem(`notes:page:${id}`),
  saveAsset: async (dataUrl) => dataUrl, // inline in the browser build
  async search(q) {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const out: SearchHit[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      if (!key.startsWith('notes:page:')) continue
      const raw = localStorage.getItem(key) || ''
      if (!raw.toLowerCase().includes(needle)) continue
      const page = JSON.parse(raw) as Page
      const hits = (page.cells || [])
        .map((c) => {
          const text = stripHtml(`${c.title} ${c.html}`)
          const i2 = text.toLowerCase().indexOf(needle)
          return i2 < 0
            ? null
            : {
                cellId: c.id,
                cellTitle: c.title,
                snippet: text.slice(Math.max(0, i2 - 40), i2 + needle.length + 60).trim(),
              }
        })
        .filter(Boolean) as SearchHit['hits']
      out.push({ pageId: page.id, title: page.title, hits: hits.slice(0, 4) })
    }
    return out
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
  readWorkspace: () => getJson<Workspace | null>('/api/workspace'),
  writeWorkspace: (w) => postJson('/api/workspace', w),
  readSettings: () => getJson<Settings | null>('/api/settings'),
  writeSettings: (s) => postJson('/api/settings', s),
  async readPage(id) {
    const page = await getJson<Page | null>(`/api/page/${encodeURIComponent(id)}`)
    return page ? (rewrite(page, 'asset://local/', '/media/') as Page) : null
  },
  writePage: (id, p) => postJson(`/api/page/${encodeURIComponent(id)}`, rewrite(p, '/media/', 'asset://local/')),
  async deletePage(id) {
    await fetch(`/api/page/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
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

async function postJson(url: string, data: unknown) {
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
}

function stripHtml(html: string) {
  const d = document.createElement('div')
  d.innerHTML = html
  return (d.textContent || '').replace(/\s+/g, ' ').trim()
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
