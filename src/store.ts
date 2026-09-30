import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { pickBackend, storage } from './lib/storage'
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
  updateCell(id: string, patch: Partial<Cell>, record?: boolean, reflow?: boolean): void
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
let gridScaleTimer: any = null

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

  async init() {
    await pickBackend()
    const [ws, st, vault] = await Promise.all([
      storage.readWorkspace(),
      storage.readSettings(),
      storage.vaultPath(),
    ])
    const workspace = ws && ws.tree?.length ? ws : emptyWorkspace()
    const settings = { ...DEFAULT_SETTINGS, ...(st || {}) }
    set({ workspace, settings, vaultPath: vault, ready: true })
    if (!ws) await storage.writeWorkspace(workspace)

    const firstPage = (() => {
      let found: string | null = null
      walk(workspace.tree, (n) => {
        if (!found && n.kind === 'page') found = n.id
      })
      return found
    })()
    const target = workspace.lastOpenPageId && findNode(workspace.tree, workspace.lastOpenPageId)
      ? workspace.lastOpenPageId
      : firstPage
    if (target) await get().openPage(target)
  },

  async save() {
    const { page } = get()
    if (!page) return
    await storage.writePage(page.id, page)
    set({ dirty: false })
  },

  async saveWorkspace() {
    await storage.writeWorkspace(get().workspace)
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

    clearTimeout(wsTimer)
    wsTimer = setTimeout(() => storage.writeSettings(settings), 250)
  },

  async openPage(id, fromNav = false) {
    const prevId = get().activePageId
    if (!fromNav && prevId && prevId !== id && isPage(get().workspace.tree, prevId)) {
      set({ navBack: [...get().navBack, prevId].slice(-100), navForward: [] })
    }
    clearTimeout(gridScaleTimer)
    gridScaleBase = null

    const cur = get().page
    if (cur && get().dirty) await storage.writePage(cur.id, cur)
    const node = findNode(get().workspace.tree, id)
    let page = await storage.readPage(id)
    if (!page) {
      page = emptyPage(id, node?.title || 'Untitled', get().settings.gridSize)
      await storage.writePage(id, page)
    }
    if (node && page.title !== node.title) page.title = node.title

    const currentGridSize = get().settings.gridSize || 20
    const snapToGrid = get().settings.snapToGrid !== false

    if (page.gridSize !== undefined && page.gridSize !== currentGridSize && page.gridSize > 0) {
      page = interpolatePage(page, page.gridSize, currentGridSize, snapToGrid)
      await storage.writePage(page.id, page)
    } else if (page.gridSize === undefined) {
      page = { ...page, gridSize: currentGridSize }
      await storage.writePage(page.id, page)
    } else if (snapToGrid) {
      const needsSnap = page.cells.some(
        (c) => c.x % currentGridSize !== 0 || c.y % currentGridSize !== 0 || c.w % currentGridSize !== 0 || c.h % currentGridSize !== 0
      )
      if (needsSnap) {
        page = {
          ...page,
          cells: page.cells.map((c) => ({
            ...c,
            x: Math.round(c.x / currentGridSize) * currentGridSize,
            y: Math.round(c.y / currentGridSize) * currentGridSize,
            w: Math.max(currentGridSize * 2, Math.ceil(c.w / currentGridSize) * currentGridSize),
            h: Math.max(currentGridSize * 2, Math.ceil(c.h / currentGridSize) * currentGridSize),
            updatedAt: now(),
          })),
          updatedAt: now(),
        }
        await storage.writePage(page.id, page)
      }
    }

    const notebook = pathTo(get().workspace.tree, id)[0]?.id ?? null
    const ws = { ...get().workspace }
    ws.lastOpenPageId = id
    ws.recent = [id, ...ws.recent.filter((r) => r !== id)].slice(0, 25)
    set({
      page,
      activePageId: id,
      activeNotebookId: notebook,
      workspace: ws,
      selection: [],
      editingCellId: null,
      history: [],
      future: [],
      dirty: false,
    })
    get().saveWorkspace()
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
    await storage.writeWorkspace(ws)
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
    if (get().activePageId === id && get().page) {
      const page = { ...get().page!, title, updatedAt: now() }
      set({ page })
      storage.writePage(page.id, page)
    }
    clearTimeout(wsTimer)
    wsTimer = setTimeout(() => storage.writeWorkspace(get().workspace), 200)
  },

  archiveNode(id, archived) {
    const ws = clone(get().workspace)
    const n = findNode(ws.tree, id)
    if (!n) return
    n.archived = archived
    n.updatedAt = now()
    set({ workspace: ws })
    clearTimeout(wsTimer)
    wsTimer = setTimeout(() => storage.writeWorkspace(get().workspace), 200)
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
    set({
      workspace: ws,
      navBack: get().navBack.filter((r) => !pageIds.includes(r)),
      navForward: get().navForward.filter((r) => !pageIds.includes(r)),
    })
    await storage.writeWorkspace(ws)
    for (const pid of pageIds) await storage.deletePage(pid)
    if (get().activePageId && pageIds.includes(get().activePageId!)) {
      let next: string | null = null
      walk(ws.tree, (n) => {
        if (!next && n.kind === 'page') next = n.id
      })
      if (next) await get().openPage(next)
      else set({ page: null, activePageId: null })
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
    storage.writeWorkspace(ws)
  },

  toggleCollapse(id) {
    const ws = clone(get().workspace)
    const n = findNode(ws.tree, id)
    if (!n) return
    n.collapsed = !n.collapsed
    set({ workspace: ws })
    storage.writeWorkspace(ws)
  },

  setNodeColor(id, color) {
    const ws = clone(get().workspace)
    const n = findNode(ws.tree, id)
    if (!n) return
    n.color = color
    set({ workspace: ws })
    storage.writeWorkspace(ws)
  },

  toggleFavorite(id) {
    const ws = clone(get().workspace)
    ws.favorites = ws.favorites.includes(id) ? ws.favorites.filter((f) => f !== id) : [...ws.favorites, id]
    set({ workspace: ws })
    storage.writeWorkspace(ws)
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
    scheduleSave(get)
  },

  redo() {
    clearTimeout(gridScaleTimer)
    gridScaleBase = null
    const { future, page } = get()
    if (!future.length || !page) return
    const next = future[0]
    set({ future: future.slice(1), history: [...get().history, clone(page!)], page: next, dirty: true })
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

  updateCell(id, patch, record = false, reflow = true) {
    const { page } = get()
    if (!page) return
    if (record) get().pushHistory()
    const cells = page.cells.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: now() } : c))
    set({ page: { ...page, cells, updatedAt: now() }, dirty: true })
    if (reflow && ('w' in patch || 'h' in patch || 'x' in patch || 'y' in patch)) get().reflowOverlaps(false)
    scheduleSave(get)
  },

  updateCells(ids, patch, reflow = true) {
    const { page } = get()
    if (!page) return
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
    get().renameNode(page.id, title)
    scheduleSave(get)
  },

  /** OneNote's "insert space": everything below `atY` shifts by `amount`. */
  insertSpace(atY, amount) {
    const { page } = get()
    if (!page || !amount) return
    get().pushHistory()
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

// Never lose the last keystrokes on close.
window.addEventListener('beforeunload', () => {
  const s = useStore.getState()
  if (s.page && s.dirty) storage.writePage(s.page.id, s.page)
})

// Handy for debugging from the console.
;(window as any).__store = useStore
