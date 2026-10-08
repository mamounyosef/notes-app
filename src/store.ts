import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { pickBackend, storage, type ConflictList, type LocalState, type Touched, type VaultEvent } from './lib/storage'
import * as Sync from '../shared/sync-core.mjs'
import { DEFAULT_SETTINGS, type Cell, type Page, type Settings, type Stroke, type TreeNode, type Workspace } from './types'

const now = () => Date.now()
const uid = () => nanoid(12)

function newNode(kind: TreeNode['kind'], title: string): TreeNode {
  return { id: uid(), kind, title, children: [], createdAt: now(), updatedAt: now() }
}

function emptyWorkspace(): Workspace {
  const page = newNode('page', 'Welcome')
  const section = newNode('section', 'General')
  section.children = [page]
  const notebook = newNode('notebook', 'My Notebook')
  notebook.color = '#7c9cff'
  notebook.children = [section]
  return { version: 1, tree: [notebook], favorites: [], recent: [page.id], lastOpenPageId: page.id }
}

function emptyPage(id: string, title: string, gridSize?: number): Page {
  return { id, title, cells: [], strokes: [], gridSize, createdAt: now(), updatedAt: now() }
}

/* ---------- tree helpers (pure) ---------- */

export function walk(nodes: TreeNode[], fn: (n: TreeNode, parent: TreeNode | null) => void, parent: TreeNode | null = null) {
  for (const n of nodes) {
    fn(n, parent)
    walk(n.children, fn, n)
  }
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = findNode(n.children, id)
    if (hit) return hit
  }
  return null
}

export function findParent(nodes: TreeNode[], id: string, parent: TreeNode | null = null): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return parent
    const hit = findParent(n.children, id, n)
    if (hit !== null || n.children.some((c) => c.id === id)) return hit ?? n
  }
  return null
}

function removeNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return nodes.splice(i, 1)[0]
    const hit = removeNode(nodes[i].children, id)
    if (hit) return hit
  }
  return null
}

export function pathTo(nodes: TreeNode[], id: string): TreeNode[] {
  for (const n of nodes) {
    if (n.id === id) return [n]
    const sub = pathTo(n.children, id)
    if (sub.length) return [n, ...sub]
  }
  return []
}

function isPage(nodes: TreeNode[], id: string): boolean {
  return findNode(nodes, id)?.kind === 'page'
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

/* ---------- store ---------- */

interface State {
  ready: boolean
  workspace: Workspace
  settings: Settings
  page: Page | null
  activePageId: string | null
  /** Notebook shown in the middle pane. */
  activeNotebookId: string | null
  selection: string[]
  editingCellId: string | null
  history: Page[]
  future: Page[]
  /** Browser style page navigation stacks (page ids). */
  navBack: string[]
  navForward: string[]
  dirty: boolean
  zoom: number
  tool: 'select' | 'pen' | 'highlighter' | 'eraser' | 'space'
  penColor: string
  penSize: number
  vaultPath: string
  searchResult: { cellId: string; query: string } | null
  setSearchResult(res: { cellId: string; query: string } | null): void

  /** Cells and pages that sync kept two versions of. */
  conflicts: ConflictList
  showSyncPanel: boolean
  /** Last save that failed (the edits are kept and retried). */
  syncError: string | null
  /** The notes folder could not be read at start. Nothing is written then. */
  fatal: string | null
  setShowSyncPanel(open: boolean): void
  refreshConflicts(): Promise<void>
  resolveConflict(cellId: string, action: 'keep-both' | 'use-this' | 'discard' | 'keep' | 'delete'): void
  showConflict(pageId: string, cellId: string): Promise<void>
  restoreOrphan(pageId: string, title: string): Promise<void>
  discardOrphan(pageId: string): Promise<void>

  init(): Promise<void>
  save(): Promise<void>
  saveWorkspace(): Promise<void>
  setSettings(patch: Partial<Settings>): void

  openPage(id: string, fromNav?: boolean): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  addNode(kind: TreeNode['kind'], parentId: string | null): Promise<string>
  renameNode(id: string, title: string): void
  archiveNode(id: string, archived: boolean): void
  deleteNode(id: string): Promise<void>
  moveNode(dragId: string, targetId: string, position: 'before' | 'after' | 'inside'): void
  toggleCollapse(id: string): void
  setNodeColor(id: string, color: string): void
  toggleFavorite(id: string): void

  pushHistory(): void
  undo(): void
  redo(): void

  addCell(partial?: Partial<Cell>): string
  /** `auto` marks layout the app measured by itself (not an edit to sync). */
  updateCell(id: string, patch: Partial<Cell>, record?: boolean, reflow?: boolean, auto?: boolean): void
  updateCells(ids: string[], patch: (c: Cell) => Partial<Cell>, reflow?: boolean): void
  deleteCells(ids: string[]): void
  duplicateCells(ids: string[]): void
  bringToFront(ids: string[]): void
  sendToBack(ids: string[]): void
  setSelection(ids: string[]): void
  setPageTitle(title: string): void
  insertSpace(atY: number, amount: number): void
  addPageStroke(stroke: Page['strokes'][number]): void
  addCellStroke(cellId: string, stroke: Stroke): void
  reflowOverlaps(record?: boolean): void
  clearPageInk(): void
  setZoom(z: number): void
  setTool(t: State['tool']): void
}

let saveTimer: any = null
let wsTimer: any = null
let settingsTimer: any = null
let localTimer: any = null
let gridScaleTimer: any = null

/* ------------------------------------------------------------------ *
 * Sync bookkeeping (see shared/sync-core.mjs and shared/vault-sync.mjs)
 *
 * For each synced file we remember the version on disk that the in-memory
 * copy started from (the base). A save sends the edits together with that
 * base, the sync service merges them with whatever is on disk right then and
 * hands back the result, which becomes the new base.
 * ------------------------------------------------------------------ */

let pageBase: Page | null = null
let pageSeq = 0
let pageSaving: Promise<void> | null = null
let pageSaveAgain = false
let pendingPageEvent: { data: Page; seq: number } | null = null
let openToken = 0

/** Cells the person moved or resized on purpose since the last save. */
let touched = { all: false, cells: new Set<string>(), meta: false }

let wsBase: Workspace | null = null
let wsSeq = 0
let wsDirty = false
let wsSaving: Promise<void> | null = null
let wsSaveAgain = false
let pendingWsEvent: { data: Workspace; seq: number } | null = null

let settingsBase: Settings | null = null
let settingsSeq = 0
let settingsDirty = false
let settingsSaving: Promise<void> | null = null
let settingsSaveAgain = false
let pendingSettingsEvent: { data: Settings; seq: number } | null = null

let local: LocalState = {}
let unsubscribe: (() => void) | null = null

/** Marks layout or page level changes as made by the person (synced). */
export function markTouched(t: { cells?: string[]; meta?: boolean; all?: boolean }) {
  for (const id of t.cells || []) touched.cells.add(id)
  if (t.meta) touched.meta = true
  if (t.all) touched.all = true
}

function takeTouched(): Touched {
  const t = { all: touched.all, cells: [...touched.cells], meta: touched.meta }
  touched = { all: false, cells: new Set(), meta: false }
  return t
}

function restoreTouched(t: Touched) {
  markTouched({ cells: t.cells, meta: t.meta, all: t.all })
}

function resetTouched() {
  touched = { all: false, cells: new Set(), meta: false }
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

/** Lays the per computer state over a workspace read from the synced folder. */
function withLocal(ws: Workspace): Workspace {
  const folded = new Set(local.collapsed || [])
  const visit = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      const out: TreeNode = { ...n, children: visit(n.children || []) }
      if (folded.has(n.id)) out.collapsed = true
      else delete out.collapsed
      return out
    })
  return { ...ws, tree: visit(ws.tree || []), favorites: ws.favorites || [], recent: local.recent || [], lastOpenPageId: local.lastOpenPageId }
}

function saveLocalSoon() {
  clearTimeout(localTimer)
  localTimer = setTimeout(() => storage.writeLocal(local).catch(() => {}), 300)
}

/** Brings a page to the current grid. Layout only, never saved on its own. */
function alignGrid(page: Page, settings: Settings): Page {
  const currentGridSize = settings.gridSize || 20
  const snapToGrid = settings.snapToGrid !== false
  if (page.gridSize !== undefined && page.gridSize !== currentGridSize && page.gridSize > 0) {
    return interpolatePage(page, page.gridSize, currentGridSize, snapToGrid)
  }
  if (page.gridSize === undefined) return { ...page, gridSize: currentGridSize }
  if (!snapToGrid) return page
  const off = (c: Cell) =>
    c.x % currentGridSize !== 0 || c.y % currentGridSize !== 0 || c.w % currentGridSize !== 0 || c.h % currentGridSize !== 0
  if (!page.cells.some(off)) return page
  return {
    ...page,
    cells: page.cells.map((c) =>
      off(c)
        ? {
            ...c,
            x: Math.round(c.x / currentGridSize) * currentGridSize,
            y: Math.round(c.y / currentGridSize) * currentGridSize,
            w: Math.max(currentGridSize * 2, Math.ceil(c.w / currentGridSize) * currentGridSize),
            h: Math.max(currentGridSize * 2, Math.ceil(c.h / currentGridSize) * currentGridSize),
          }
        : c,
    ),
  }
}

interface GridScaleBase {
  gridSize: number
  pageId: string
  cells: { id: string; x: number; y: number; w: number; h: number }[]
  strokes: { points: number[] }[]
}

let gridScaleBase: GridScaleBase | null = null

function scalePageFromBase(page: Page, base: GridScaleBase, targetGrid: number, snapToGrid = true): Page {
  const baseGrid = base.gridSize > 0 ? base.gridSize : 20
  const ratio = targetGrid / baseGrid
  const baseMap = new Map(base.cells.map((c) => [c.id, c]))
  const cells = page.cells.map((c) => {
    const b = baseMap.get(c.id)
    if (!b) return c
    const rawX = b.x * ratio
    const rawY = b.y * ratio
    const rawW = b.w * ratio
    const rawH = b.h * ratio

    const x = snapToGrid ? Math.round(rawX / targetGrid) * targetGrid : Math.round(rawX)
    const y = snapToGrid ? Math.round(rawY / targetGrid) * targetGrid : Math.round(rawY)
    const w = snapToGrid ? Math.max(targetGrid * 2, Math.ceil(rawW / targetGrid) * targetGrid) : Math.max(60, Math.round(rawW))
    const h = snapToGrid ? Math.max(targetGrid * 2, Math.ceil(rawH / targetGrid) * targetGrid) : Math.max(40, Math.round(rawH))

    return {
      ...c,
      x: Math.max(0, x),
      y: Math.max(0, y),
      w,
      h,
      updatedAt: now(),
    }
  })
  const strokes = (page.strokes || []).map((s, idx) => {
    const bs = base.strokes[idx]
    if (!bs) return s
    return {
      ...s,
      points: bs.points.map((pt) => Math.round(pt * ratio)),
    }
  })
  return {
    ...page,
    gridSize: targetGrid,
    cells,
    strokes,
    updatedAt: now(),
  }
}

function interpolatePage(page: Page, fromGrid: number, toGrid: number, snapToGrid = true): Page {
  if (fromGrid === toGrid || fromGrid <= 0 || toGrid <= 0) {
    return { ...page, gridSize: toGrid }
  }
  const ratio = toGrid / fromGrid
  const cells = page.cells.map((c) => {
    const rawX = c.x * ratio
    const rawY = c.y * ratio
    const rawW = c.w * ratio
    const rawH = c.h * ratio

    const x = snapToGrid ? Math.round(rawX / toGrid) * toGrid : Math.round(rawX)
    const y = snapToGrid ? Math.round(rawY / toGrid) * toGrid : Math.round(rawY)
    const w = snapToGrid ? Math.max(toGrid * 2, Math.ceil(rawW / toGrid) * toGrid) : Math.max(60, Math.round(rawW))
    const h = snapToGrid ? Math.max(toGrid * 2, Math.ceil(rawH / toGrid) * toGrid) : Math.max(40, Math.round(rawH))

    return {
      ...c,
      x: Math.max(0, x),
      y: Math.max(0, y),
      w,
      h,
      updatedAt: now(),
    }
  })
  const strokes = (page.strokes || []).map((s) => ({
    ...s,
    points: s.points.map((pt) => Math.round(pt * ratio)),
  }))
  return {
    ...page,
    gridSize: toGrid,
    cells,
    strokes,
    updatedAt: now(),
  }
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  workspace: emptyWorkspace(),
  settings: DEFAULT_SETTINGS,
  page: null,
  activePageId: null,
  activeNotebookId: null,
  selection: [],
  editingCellId: null,
  history: [],
  future: [],
  navBack: [],
  navForward: [],
  dirty: false,
  zoom: 1,
  tool: 'select',
  penColor: '#e06c75',
  penSize: 3,
  vaultPath: '',
  searchResult: null,
  setSearchResult: (res) => set({ searchResult: res }),

  conflicts: { cells: [], orphans: [] },
  showSyncPanel: false,
  syncError: null,
  fatal: null,
  setShowSyncPanel: (open) => {
    set({ showSyncPanel: open })
    if (open) get().refreshConflicts()
  },

  async refreshConflicts() {
    try {
      set({ conflicts: await storage.listConflicts() })
    } catch {
      /* keep the last list */
    }
  },

  async init() {
    await pickBackend()
    let wsR, stR, vault, loc
    try {
      ;[wsR, stR, vault, loc] = await Promise.all([
        storage.readWorkspace(),
        storage.readSettings(),
        storage.vaultPath(),
        storage.readLocal(),
      ])
    } catch (e) {
      set({ ready: true, fatal: `The notes folder could not be read: ${errorText(e)}` })
      return
    }
    if (wsR.damaged) {
      // Never paper over a damaged tree with an empty one.
      set({ ready: true, vaultPath: vault, fatal: 'workspace.json in the notes folder could not be read. Nothing was changed. Check the file, then restart Notes.' })
      return
    }
    const ws = wsR.data
    wsBase = ws
    wsSeq = wsR.seq
    settingsBase = stR.damaged ? null : stR.data
    settingsSeq = stR.seq

    // Per computer state used to live in workspace.json. Carry it over once.
    if (loc) local = loc
    else {
      const collapsed: string[] = []
      if (ws?.tree) walk(ws.tree, (n) => n.collapsed && collapsed.push(n.id))
      local = { lastOpenPageId: ws?.lastOpenPageId, recent: ws?.recent || [], collapsed }
      storage.writeLocal(local).catch(() => {})
    }

    const workspace = ws && ws.tree?.length ? withLocal(ws) : emptyWorkspace()
    const settings = { ...DEFAULT_SETTINGS, ...(settingsBase || {}) }
    set({ workspace, settings, vaultPath: vault, ready: true })
    if (!ws || !ws.tree?.length) {
      wsDirty = true
      await get().saveWorkspace()
    }

    unsubscribe?.()
    unsubscribe = storage.onVaultEvent((ev) => handleVaultEvent(ev))
    get().refreshConflicts()

    const tree = get().workspace.tree
    let firstPage: string | null = null
    walk(tree, (n) => {
      if (!firstPage && n.kind === 'page') firstPage = n.id
    })
    const target = local.lastOpenPageId && isPage(tree, local.lastOpenPageId) ? local.lastOpenPageId : firstPage
    if (target) await get().openPage(target)
  },

  async save() {
    if (pageSaving) {
      pageSaveAgain = true
      return pageSaving
    }
    pageSaving = (async () => {
      do {
        pageSaveAgain = false
        const sent = get().page
        if (!sent || !get().dirty) break
        const t = takeTouched()
        const base = pageBase && pageBase.id === sent.id ? pageBase : null
        let res
        try {
          res = await storage.writePage(sent.id, sent, base, t)
        } catch (e) {
          // Keep the edits in memory and try again shortly.
          restoreTouched(t)
          set({ syncError: `Saving failed, retrying: ${errorText(e)}` })
          clearTimeout(saveTimer)
          saveTimer = setTimeout(() => get().save(), 3000)
          break
        }
        if (get().syncError) set({ syncError: null })
        const cur = get().page
        pageSeq = Math.max(pageSeq, res.seq)
        if (!cur || cur.id !== sent.id) {
          if (res.data && pageBase?.id === sent.id) pageBase = res.data
          break
        }
        if (res.skipped || !res.data) {
          if (cur === sent) set({ dirty: false })
          continue
        }
        pageBase = res.data
        if (Sync.samePageContent(sent, res.data)) {
          if (cur === sent) set({ dirty: false })
          continue
        }
        // The save picked up changes from another computer.
        const next = cur === sent ? res.data : Sync.rebasePage(cur, sent, res.data)
        applyPage(next, cur === sent ? false : true)
      } while (pageSaveAgain)
    })()
    try {
      await pageSaving
    } finally {
      pageSaving = null
    }
    const ev = pendingPageEvent
    pendingPageEvent = null
    if (ev) onRemotePage(ev.data, ev.seq)
  },

  async saveWorkspace() {
    if (wsSaving) {
      wsSaveAgain = true
      return wsSaving
    }
    wsSaving = (async () => {
      do {
        wsSaveAgain = false
        if (!wsDirty) break
        wsDirty = false
        const sent = get().workspace
        let res
        try {
          res = await storage.writeWorkspace(sent, wsBase)
        } catch (e) {
          wsDirty = true
          set({ syncError: `Saving the notebook list failed, retrying: ${errorText(e)}` })
          clearTimeout(wsTimer)
          wsTimer = setTimeout(() => get().saveWorkspace(), 3000)
          break
        }
        if (get().syncError) set({ syncError: null })
        wsSeq = Math.max(wsSeq, res.seq)
        if (res.skipped || !res.data) continue
        wsBase = res.data
        if (Sync.sameWorkspaceContent(sent, res.data)) continue
        const cur = get().workspace
        applyWorkspace(withLocal(cur === sent ? res.data : Sync.rebaseWorkspace(cur, sent, res.data)))
      } while (wsSaveAgain || wsDirty)
    })()
    try {
      await wsSaving
    } finally {
      wsSaving = null
    }
    const ev = pendingWsEvent
    pendingWsEvent = null
    if (ev) onRemoteWorkspace(ev.data, ev.seq)
  },

  setSettings(patch) {
    const oldSettings = get().settings
    const settings = { ...oldSettings, ...patch }
    let page = get().page

    if (
      patch.gridSize !== undefined &&
      typeof patch.gridSize === 'number' &&
      patch.gridSize > 0 &&
      patch.gridSize !== oldSettings.gridSize &&
      page
    ) {
      if (!gridScaleBase || gridScaleBase.pageId !== page.id) {
        get().pushHistory()
        gridScaleBase = {
          gridSize: page.gridSize || oldSettings.gridSize || 20,
          pageId: page.id,
          cells: page.cells.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
          strokes: (page.strokes || []).map((s) => ({ points: [...s.points] })),
        }
      }

      page = scalePageFromBase(page, gridScaleBase, patch.gridSize, settings.snapToGrid)
      set({ settings, page, dirty: true })
      scheduleSave(get)

      clearTimeout(gridScaleTimer)
      gridScaleTimer = setTimeout(() => {
        gridScaleBase = null
      }, 600)
    } else {
      set({ settings })
    }

    settingsDirty = true
    clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => saveSettings(), 250)
  },

  async openPage(id, fromNav = false) {
    const token = ++openToken
    const prevId = get().activePageId
    if (!fromNav && prevId && prevId !== id && isPage(get().workspace.tree, prevId)) {
      set({ navBack: [...get().navBack, prevId].slice(-100), navForward: [] })
    }
    clearTimeout(gridScaleTimer)
    gridScaleBase = null

    // Finish saving the page we are leaving before anything else.
    clearTimeout(saveTimer)
    if (get().dirty) await get().save()
    if (pageSaving) await pageSaving
    if (token !== openToken) return

    const node = findNode(get().workspace.tree, id)
    let res
    try {
      res = await storage.readPage(id)
    } catch (e) {
      set({ syncError: `Opening the page failed: ${errorText(e)}` })
      return
    }
    if (token !== openToken) return
    if (res.damaged) {
      set({ syncError: 'That page file could not be read, so it was left untouched.' })
      return
    }

    let page = res.data
    const fresh = !page
    if (!page) page = emptyPage(id, node?.title || 'Untitled', get().settings.gridSize)
    resetTouched()
    pageBase = res.data
    pageSeq = res.seq
    pendingPageEvent = null
    let retitled = false
    if (node && page.title !== node.title) {
      page = { ...page, title: node.title }
      markTouched({ meta: true })
      retitled = true
    }
    page = alignGrid(page, get().settings)

    local = { ...local, lastOpenPageId: id, recent: [id, ...(local.recent || []).filter((r) => r !== id)].slice(0, 25) }
    saveLocalSoon()

    const notebook = pathTo(get().workspace.tree, id)[0]?.id ?? null
    set({
      page,
      activePageId: id,
      activeNotebookId: notebook,
      workspace: { ...get().workspace, lastOpenPageId: local.lastOpenPageId, recent: local.recent || [] },
      selection: [],
      editingCellId: null,
      history: [],
      future: [],
      dirty: fresh || retitled,
    })
    if (fresh) await get().save()
    else if (retitled) scheduleSave(get)
  },

  async goBack() {
    const tree = get().workspace.tree
    const back = get().navBack.filter((pid) => isPage(tree, pid))
    const cur = get().activePageId
    let target = back.pop()
    while (target && target === cur) target = back.pop()
    if (!target) { set({ navBack: back }); return }
    set({ navBack: back, navForward: cur ? [cur, ...get().navForward] : get().navForward })
    await get().openPage(target, true)
  },

  async goForward() {
    const tree = get().workspace.tree
    const fwd = get().navForward.filter((pid) => isPage(tree, pid))
    const cur = get().activePageId
    let target = fwd.shift()
    while (target && target === cur) target = fwd.shift()
    if (!target) { set({ navForward: fwd }); return }
    set({ navForward: fwd, navBack: cur ? [...get().navBack, cur] : get().navBack })
    await get().openPage(target, true)
  },

  async addNode(kind, parentId) {
    const ws = clone(get().workspace)
    const node = newNode(kind, kind === 'notebook' ? 'New Notebook' : kind === 'section' ? 'New Section' : 'Untitled Page')
    if (kind === 'notebook' || !parentId) {
      ws.tree.push(node)
    } else {
      const parent = findNode(ws.tree, parentId)
      if (parent) {
        parent.children.push(node)
        parent.collapsed = false
      } else ws.tree.push(node)
    }
    set({ workspace: ws })
    wsDirty = true
    await get().saveWorkspace()
    if (kind === 'page') await get().openPage(node.id)
    return node.id
  },

  renameNode(id, title) {
    const ws = clone(get().workspace)
    const n = findNode(ws.tree, id)
    if (!n) return
    n.title = title
    n.updatedAt = now()
    set({ workspace: ws })
    if (get().activePageId === id && get().page && get().page!.title !== title) {
      set({ page: { ...get().page!, title, updatedAt: now() }, dirty: true })
      markTouched({ meta: true })
      scheduleSave(get)
    }
    scheduleWorkspace(200)
  },

  archiveNode(id, archived) {
    const ws = clone(get().workspace)
    const n = findNode(ws.tree, id)
    if (!n) return
    n.archived = archived
    n.updatedAt = now()
    set({ workspace: ws })
    scheduleWorkspace(200)
  },

  async deleteNode(id) {
    const ws = clone(get().workspace)
    const removed = removeNode(ws.tree, id)
    if (!removed) return
    const pageIds: string[] = []
    walk([removed], (n) => {
      if (n.kind === 'page') pageIds.push(n.id)
    })
    ws.favorites = ws.favorites.filter((f) => !pageIds.includes(f))
    ws.recent = ws.recent.filter((r) => !pageIds.includes(r))
    const leaving = get().activePageId && pageIds.includes(get().activePageId!)
    if (leaving) {
      // Nothing left to save on a page that is being deleted.
      clearTimeout(saveTimer)
      if (pageSaving) await pageSaving
      set({ dirty: false })
    }
    set({
      workspace: ws,
      navBack: get().navBack.filter((r) => !pageIds.includes(r)),
      navForward: get().navForward.filter((r) => !pageIds.includes(r)),
    })
    wsDirty = true
    await get().saveWorkspace()
    for (const pid of pageIds) await storage.deletePage(pid)
    if (leaving) {
      let next: string | null = null
      walk(get().workspace.tree, (n) => {
        if (!next && n.kind === 'page') next = n.id
      })
      if (next) await get().openPage(next)
      else {
        pageBase = null
        set({ page: null, activePageId: null })
      }
    }
  },

  moveNode(dragId, targetId, position) {
    if (dragId === targetId) return
    const ws = clone(get().workspace)
    // Never drop a node inside its own subtree.
    const dragging = findNode(ws.tree, dragId)
    if (!dragging) return
    let illegal = false
    walk([dragging], (n) => {
      if (n.id === targetId) illegal = true
    })
    if (illegal) return

    removeNode(ws.tree, dragId)
    if (position === 'inside') {
      const target = findNode(ws.tree, targetId)
      if (!target) return
      target.children.push(dragging)
      target.collapsed = false
    } else {
      const parent = findParent(ws.tree, targetId)
      const siblings = parent ? parent.children : ws.tree
      const idx = siblings.findIndex((s) => s.id === targetId)
      siblings.splice(position === 'before' ? idx : idx + 1, 0, dragging)
    }
    set({ workspace: ws })
    scheduleWorkspace(0)
  },

  /** Folding is per computer: it goes to local state, not the synced tree. */
  toggleCollapse(id) {
    const ws = clone(get().workspace)
    const n = findNode(ws.tree, id)
    if (!n) return
    n.collapsed = !n.collapsed
    const folded = new Set(local.collapsed || [])
    if (n.collapsed) folded.add(id)
    else folded.delete(id)
    local = { ...local, collapsed: [...folded] }
    saveLocalSoon()
    set({ workspace: ws })
  },

  setNodeColor(id, color) {
    const ws = clone(get().workspace)
    const n = findNode(ws.tree, id)
    if (!n) return
    n.color = color
    set({ workspace: ws })
    scheduleWorkspace(0)
  },

  toggleFavorite(id) {
    const ws = clone(get().workspace)
    ws.favorites = ws.favorites.includes(id) ? ws.favorites.filter((f) => f !== id) : [...ws.favorites, id]
    set({ workspace: ws })
    scheduleWorkspace(0)
  },

  /* ---------- page edits ---------- */

  pushHistory() {
    const { page, history } = get()
    if (!page) return
    set({ history: [...history.slice(-60), clone(page)], future: [] })
  },

  undo() {
    clearTimeout(gridScaleTimer)
    gridScaleBase = null
    const { history, page } = get()
    if (!history.length || !page) return
    const prev = history[history.length - 1]
    set({ history: history.slice(0, -1), future: [clone(page), ...get().future].slice(0, 60), page: prev, dirty: true })
    markTouched({ all: true })
    scheduleSave(get)
  },

  redo() {
    clearTimeout(gridScaleTimer)
    gridScaleBase = null
    const { future, page } = get()
    if (!future.length || !page) return
    const next = future[0]
    set({ future: future.slice(1), history: [...get().history, clone(page!)], page: next, dirty: true })
    markTouched({ all: true })
    scheduleSave(get)
  },

  addCell(partial = {}) {
    const { page, settings } = get()
    if (!page) return ''
    get().pushHistory()
    const maxZ = page.cells.reduce((m, c) => Math.max(m, c.z), 0)
    const rawW = partial.w ?? settings.defaultCellWidth
    const rawH = partial.h ?? settings.defaultCellHeight
    const snap = (v: number) => (settings.snapToGrid ? Math.round(v / settings.gridSize) * settings.gridSize : v)
    const snapCeil = (v: number) => (settings.snapToGrid ? Math.ceil(v / settings.gridSize) * settings.gridSize : v)
    const rawX = partial.x ?? 40
    const rawY = partial.y ?? 40
    const cell: Cell = {
      id: uid(),
      kind: 'text',
      z: maxZ + 1,
      title: '',
      showTitle: true,
      html: '',
      autoHeight: settings.cellAutoHeight,
      createdAt: now(),
      updatedAt: now(),
      ...partial,
      x: snap(rawX),
      y: snap(rawY),
      w: Math.max(settings.gridSize * 2, snapCeil(rawW)),
      h: Math.max(settings.gridSize * 2, snapCeil(rawH)),
    }
    set({
      page: { ...page, cells: [...page.cells, cell], updatedAt: now() },
      selection: [cell.id],
      editingCellId: cell.id,
      dirty: true,
    })
    scheduleSave(get)
    return cell.id
  },

  updateCell(id, patch, record = false, reflow = true, auto = false) {
    const { page } = get()
    if (!page) return
    if (record) get().pushHistory()
    if (!auto) markTouched({ cells: [id] })
    const cells = page.cells.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: now() } : c))
    set({ page: { ...page, cells, updatedAt: now() }, dirty: true })
    if (reflow && ('w' in patch || 'h' in patch || 'x' in patch || 'y' in patch)) get().reflowOverlaps(false)
    scheduleSave(get)
  },

  updateCells(ids, patch, reflow = true) {
    const { page } = get()
    if (!page) return
    markTouched({ cells: ids })
    let needsReflow = false
    const cells = page.cells.map((c) => {
      if (!ids.includes(c.id)) return c
      const p = patch(c)
      if ('w' in p || 'h' in p || 'x' in p || 'y' in p) needsReflow = true
      return { ...c, ...p, updatedAt: now() }
    })
    set({ page: { ...page, cells, updatedAt: now() }, dirty: true })
    if (reflow && needsReflow) get().reflowOverlaps(false)
    scheduleSave(get)
  },

  deleteCells(ids) {
    const { page } = get()
    if (!page || !ids.length) return
    get().pushHistory()
    set({
      page: { ...page, cells: page.cells.filter((c) => !ids.includes(c.id)), updatedAt: now() },
      selection: [],
      editingCellId: null,
      dirty: true,
    })
    scheduleSave(get)
  },

  duplicateCells(ids) {
    const { page, settings } = get()
    if (!page) return
    get().pushHistory()
    let maxZ = page.cells.reduce((m, c) => Math.max(m, c.z), 0)
    const copies = page.cells
      .filter((c) => ids.includes(c.id))
      .map((c) => ({
        ...clone(c),
        id: uid(),
        x: c.x + settings.gridSize,
        y: c.y + settings.gridSize,
        z: ++maxZ,
        createdAt: now(),
        updatedAt: now(),
      }))
    set({
      page: { ...page, cells: [...page.cells, ...copies], updatedAt: now() },
      selection: copies.map((c) => c.id),
      dirty: true,
    })
    scheduleSave(get)
  },

  bringToFront(ids) {
    const { page } = get()
    if (!page) return
    let maxZ = page.cells.reduce((m, c) => Math.max(m, c.z), 0)
    get().updateCells(ids, () => ({ z: ++maxZ }))
  },

  sendToBack(ids) {
    const { page } = get()
    if (!page) return
    let minZ = page.cells.reduce((m, c) => Math.min(m, c.z), 0)
    get().updateCells(ids, () => ({ z: --minZ }))
  },

  setSelection(ids) {
    set({ selection: ids })
  },

  setPageTitle(title) {
    const { page } = get()
    if (!page) return
    set({ page: { ...page, title, updatedAt: now() }, dirty: true })
    markTouched({ meta: true })
    get().renameNode(page.id, title)
    scheduleSave(get)
  },

  /** OneNote's "insert space": everything below `atY` shifts by `amount`. */
  insertSpace(atY, amount) {
    const { page } = get()
    if (!page || !amount) return
    get().pushHistory()
    markTouched({ cells: page.cells.filter((c) => c.y >= atY).map((c) => c.id), meta: true })
    const cells = page.cells.map((c) => (c.y >= atY ? { ...c, y: Math.max(0, c.y + amount) } : c))
    const strokes = page.strokes.map((s) => {
      const pts = s.points.slice()
      for (let i = 1; i < pts.length; i += 2) if (pts[i] >= atY) pts[i] = Math.max(0, pts[i] + amount)
      return { ...s, points: pts }
    })
    set({ page: { ...page, cells, strokes, updatedAt: now() }, dirty: true })
    scheduleSave(get)
  },

  /**
   * Pushes cells down until nothing overlaps, keeping the reading order and
   * the horizontal placement exactly as they were.
   */
  reflowOverlaps(record = true) {
    const { page, settings } = get()
    if (!page || page.cells.length < 2) return
    if (record) get().pushHistory()
    const gap = settings.cellGap
    const cells = [...page.cells].sort((a, b) => a.y - b.y || a.x - b.x)
    const moved = new Map<string, { x: number; y: number }>()
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i]
      const posA = moved.get(a.id) ?? { x: a.x, y: a.y }
      for (let j = i + 1; j < cells.length; j++) {
        const b = cells[j]
        const posB = moved.get(b.id) ?? { x: b.x, y: b.y }
        const overlapX = posA.x < posB.x + b.w && posB.x < posA.x + a.w
        const overlapY = posA.y < posB.y + b.h && posB.y < posA.y + a.h
        if (overlapX && overlapY) {
          const rightPush = posA.x + a.w + gap
          const downPush = posA.y + a.h + gap
          const pushRightDist = posB.x >= posA.x ? rightPush - posB.x : Infinity
          const pushDownDist = posB.y >= posA.y ? downPush - posB.y : Infinity
          
          let newX = posB.x
          let newY = posB.y
          
          if (pushRightDist < pushDownDist && pushRightDist !== Infinity) {
            newX = rightPush
          } else if (pushDownDist !== Infinity) {
            newY = downPush
          } else {
            newY = downPush
          }
          moved.set(b.id, { x: Math.round(newX), y: Math.round(newY) })
        }
      }
    }
    if (!moved.size) return
    // An explicit "tidy" is an edit; the automatic one after a drag is not.
    if (record) markTouched({ cells: [...moved.keys()] })
    const next = page.cells.map((c) => {
      if (moved.has(c.id)) {
        const pos = moved.get(c.id)!
        return { ...c, x: pos.x, y: pos.y }
      }
      return c
    })
    set({ page: { ...page, cells: next, updatedAt: now() }, dirty: true })
    scheduleSave(get)
  },

  addPageStroke(stroke) {
    const { page } = get()
    if (!page) return
    get().pushHistory()
    set({ page: { ...page, strokes: [...page.strokes, stroke], updatedAt: now() }, dirty: true })
    scheduleSave(get)
  },

  addCellStroke(cellId, stroke) {
    const { page } = get()
    if (!page) return
    get().pushHistory()
    const cells = page.cells.map(c => {
      if (c.id === cellId) {
        return { ...c, strokes: [...(c.strokes || []), stroke], updatedAt: now() }
      }
      return c
    })
    set({ page: { ...page, cells, updatedAt: now() }, dirty: true })
    scheduleSave(get)
  },

  clearPageInk() {
    const { page } = get()
    if (!page) return
    get().pushHistory()
    set({ page: { ...page, strokes: [], updatedAt: now() }, dirty: true })
    scheduleSave(get)
  },

  /* ---------- sync conflicts ---------- */

  resolveConflict(cellId, action) {
    const { page } = get()
    if (!page) return
    const cell = page.cells.find((c) => c.id === cellId)
    if (!cell) return
    get().pushHistory()
    const clear = (c: Cell): Cell => {
      const { conflict: _drop, ...rest } = c
      return { ...rest, updatedAt: now() }
    }
    let cells = page.cells
    const touchedIds = [cellId]
    if (action === 'keep-both' || action === 'keep') {
      cells = cells.map((c) => (c.id === cellId ? clear(c) : c))
    } else if (action === 'discard' || action === 'delete') {
      cells = cells.filter((c) => c.id !== cellId)
    } else if (action === 'use-this') {
      const of = cell.conflict?.of
      const original = of ? cells.find((c) => c.id === of) : null
      if (original) {
        touchedIds.push(original.id)
        cells = cells
          .filter((c) => c.id !== cellId)
          .map((c) => (c.id === original.id ? { ...c, html: cell.html, title: cell.title, strokes: cell.strokes, updatedAt: now() } : c))
      } else {
        cells = cells.map((c) => (c.id === cellId ? clear(c) : c))
      }
    }
    markTouched({ cells: touchedIds })
    set({
      page: { ...page, cells, updatedAt: now() },
      selection: get().selection.filter((id) => cells.some((c) => c.id === id)),
      editingCellId: null,
      dirty: true,
      conflicts: { ...get().conflicts, cells: get().conflicts.cells.filter((c) => !(c.pageId === page.id && c.cellId === cellId)) },
    })
    clearTimeout(saveTimer)
    get().save()
  },

  async showConflict(pageId, cellId) {
    if (get().activePageId !== pageId) await get().openPage(pageId)
    if (get().activePageId === pageId) set({ searchResult: { cellId, query: '' }, selection: [cellId] })
  },

  /** Puts a page whose tree entry was deleted elsewhere back, under "Recovered". */
  async restoreOrphan(pageId, title) {
    const ws = clone(get().workspace)
    if (findNode(ws.tree, pageId)) return
    let nb = findNode(ws.tree, Sync.RECOVERED_NOTEBOOK)
    if (!nb) {
      nb = { id: Sync.RECOVERED_NOTEBOOK, kind: 'notebook', title: 'Recovered', color: '#e5c07b', children: [], createdAt: now(), updatedAt: now() }
      ws.tree.push(nb)
    }
    let sec = findNode(ws.tree, Sync.RECOVERED_SECTION)
    if (!sec) {
      sec = { id: Sync.RECOVERED_SECTION, kind: 'section', title: 'Recovered', children: [], createdAt: now(), updatedAt: now() }
      nb.children.push(sec)
    }
    sec.children.push({ id: pageId, kind: 'page', title: title || 'Recovered page', children: [], createdAt: now(), updatedAt: now() })
    set({
      workspace: ws,
      conflicts: { ...get().conflicts, orphans: get().conflicts.orphans.filter((o) => o.pageId !== pageId) },
    })
    wsDirty = true
    await get().saveWorkspace()
    await get().openPage(pageId)
    get().refreshConflicts()
  },

  async discardOrphan(pageId) {
    await storage.deletePage(pageId)
    set({ conflicts: { ...get().conflicts, orphans: get().conflicts.orphans.filter((o) => o.pageId !== pageId) } })
    get().refreshConflicts()
  },

  setZoom(z) {
    set({ zoom: Math.min(3, Math.max(0.3, Number(z.toFixed(2)))) })
  },

  setTool(t) {
    set({ tool: t, selection: t === 'select' ? get().selection : [] })
  },
}))

function scheduleSave(get: () => State) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => get().save(), get().settings.autosaveMs)
}

function scheduleWorkspace(ms: number) {
  wsDirty = true
  clearTimeout(wsTimer)
  wsTimer = setTimeout(() => useStore.getState().saveWorkspace(), ms)
}

async function saveSettings() {
  if (settingsSaving) {
    settingsSaveAgain = true
    return settingsSaving
  }
  const st = useStore
  settingsSaving = (async () => {
    do {
      settingsSaveAgain = false
      if (!settingsDirty) break
      settingsDirty = false
      const sent = st.getState().settings
      let res
      try {
        res = await storage.writeSettings(sent, settingsBase)
      } catch (e) {
        settingsDirty = true
        clearTimeout(settingsTimer)
        settingsTimer = setTimeout(() => saveSettings(), 3000)
        break
      }
      settingsSeq = Math.max(settingsSeq, res.seq)
      if (res.skipped || !res.data) continue
      settingsBase = res.data
      const cur = st.getState().settings
      const next = cur === sent ? res.data : Sync.rebaseSettings(cur, sent, res.data)
      if (!sameSettings(cur, next)) applySettings({ ...DEFAULT_SETTINGS, ...next })
    } while (settingsSaveAgain || settingsDirty)
  })()
  try {
    await settingsSaving
  } finally {
    settingsSaving = null
  }
  const ev = pendingSettingsEvent
  pendingSettingsEvent = null
  if (ev) onRemoteSettings(ev.data, ev.seq)
}

function sameSettings(a: Settings, b: Settings) {
  const strip = (s: Settings) => ({ ...s, _t: undefined })
  return Sync.stable(strip(a)) === Sync.stable(strip(b))
}

/* ---------- applying changes that came from disk ---------- */

/** Shows a new version of the open page, keeping selection where it can. */
function applyPage(page: Page, stillDirty: boolean) {
  const s = useStore.getState()
  const ids = new Set(page.cells.map((c) => c.id))
  useStore.setState({
    page: alignGrid(page, s.settings),
    dirty: stillDirty,
    // Undo would put back the other computer's changes as if they were ours.
    history: [],
    future: [],
    selection: s.selection.filter((id) => ids.has(id)),
    editingCellId: s.editingCellId && ids.has(s.editingCellId) ? s.editingCellId : null,
  })
}

function onRemotePage(data: Page, seq: number) {
  const s = useStore.getState()
  if (!s.page || s.page.id !== data.id) return
  if (seq <= pageSeq) return
  if (pageSaving || s.dirty) {
    // Our unsaved edits go first; the save merges them with this version.
    pendingPageEvent = { data, seq }
    if (!pageSaving) {
      clearTimeout(saveTimer)
      s.save()
    }
    return
  }
  pageBase = data
  pageSeq = seq
  if (Sync.samePageContent(s.page, data)) return
  applyPage(data, false)
}

function applyWorkspace(ws: Workspace) {
  const s = useStore.getState()
  useStore.setState({ workspace: ws })
  // The open page may have been deleted on the other computer.
  const active = s.activePageId
  if (active && !isPage(ws.tree, active)) {
    let next: string | null = null
    walk(ws.tree, (n) => {
      if (!next && n.kind === 'page') next = n.id
    })
    const leave = async () => {
      // Unsaved edits are still written; the page then shows up under
      // "Pages not in any notebook" in the sync panel, nothing is lost.
      clearTimeout(saveTimer)
      if (useStore.getState().dirty) await useStore.getState().save()
      if (useStore.getState().activePageId !== active) return
      if (next) await useStore.getState().openPage(next, true)
      else {
        pageBase = null
        useStore.setState({ page: null, activePageId: null })
      }
    }
    leave()
  } else if (active) {
    const notebook = pathTo(ws.tree, active)[0]?.id ?? null
    if (notebook !== s.activeNotebookId) useStore.setState({ activeNotebookId: notebook })
    // A rename on the other computer shows in the page title too.
    const node = findNode(ws.tree, active)
    const page = useStore.getState().page
    if (node && page && page.id === active && page.title !== node.title) {
      useStore.setState({ page: { ...page, title: node.title } })
    }
  }
}

function onRemoteWorkspace(data: Workspace, seq: number) {
  if (seq <= wsSeq) return
  if (wsSaving || wsDirty) {
    pendingWsEvent = { data, seq }
    if (!wsSaving) {
      clearTimeout(wsTimer)
      useStore.getState().saveWorkspace()
    }
    return
  }
  wsBase = data
  wsSeq = seq
  if (Sync.sameWorkspaceContent(useStore.getState().workspace, data)) return
  applyWorkspace(withLocal(data))
}

function applySettings(next: Settings) {
  const s = useStore.getState()
  useStore.setState({ settings: next })
  if (s.page && next.gridSize !== s.settings.gridSize) {
    useStore.setState({ page: alignGrid(useStore.getState().page!, next) })
  }
}

function onRemoteSettings(data: Settings, seq: number) {
  if (seq <= settingsSeq) return
  if (settingsSaving || settingsDirty) {
    pendingSettingsEvent = { data, seq }
    if (!settingsSaving) {
      clearTimeout(settingsTimer)
      saveSettings()
    }
    return
  }
  settingsBase = data
  settingsSeq = seq
  const next = { ...DEFAULT_SETTINGS, ...data }
  if (!sameSettings(useStore.getState().settings, next)) applySettings(next)
}

function handleVaultEvent(ev: VaultEvent) {
  switch (ev.type) {
    case 'page':
      onRemotePage(ev.data, ev.seq)
      break
    case 'workspace':
      onRemoteWorkspace(ev.data, ev.seq)
      break
    case 'settings':
      onRemoteSettings(ev.data, ev.seq)
      break
    case 'conflicts':
      useStore.setState({ conflicts: ev.list })
      break
    case 'asset':
      // An image that arrived after the page did: show it now.
      document.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || ''
        if (src.includes(ev.name)) img.src = `${src.split('?')[0]}?r=${Date.now()}`
      })
      break
    case 'page-removed':
      // The tree decides what happens; see applyWorkspace.
      break
  }
}

/** Writes everything pending. The desktop app waits for this before closing. */
export async function flushAll() {
  const s = useStore.getState()
  clearTimeout(saveTimer)
  clearTimeout(wsTimer)
  clearTimeout(settingsTimer)
  clearTimeout(localTimer)
  const jobs: Promise<unknown>[] = []
  if (s.dirty || pageSaving) jobs.push(s.save())
  if (wsDirty || wsSaving) jobs.push(s.saveWorkspace())
  if (settingsDirty || settingsSaving) jobs.push(saveSettings())
  jobs.push(storage.writeLocal(local).catch(() => {}))
  await Promise.all(jobs)
}

;(window as any).notes?.onFlushRequest?.(flushAll)

// Never lose the last keystrokes on close.
window.addEventListener('beforeunload', () => {
  const s = useStore.getState()
  if (s.page && s.dirty) {
    const base = pageBase && pageBase.id === s.page.id ? pageBase : null
    storage.writePage(s.page.id, s.page, base, takeTouched()).catch(() => {})
  }
  if (wsDirty) storage.writeWorkspace(s.workspace, wsBase).catch(() => {})
  if (settingsDirty) storage.writeSettings(s.settings, settingsBase).catch(() => {})
})

// Handy for debugging from the console.
;(window as any).__store = useStore
