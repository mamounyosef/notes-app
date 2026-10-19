/**
 * Everything the agent can do in the app, as tools for the model.
 *
 * Edits to the open page go through the store (so Ctrl+Z works too); other
 * pages are read and written through storage, merged like any other save.
 * Every change is first recorded in a TurnRecorder, so one click undoes
 * everything a reply did.
 */
import { nanoid } from 'nanoid'
import { useStore, findNode, findParent, pathTo, walk } from '../store'
import { storage } from '../lib/storage'
import { DEFAULT_SETTINGS, type Cell, type Page, type Settings, type TreeNode } from '../types'
import { agentInlineToHtml, agentToHtml, htmlToAgent, htmlToText, softenMarks } from './content'
import { buildContext } from './context'
import { agentApi, chatApi, type ChatAttachment } from './api'
import { DEFAULT_MODEL, MODELS } from './models'

const now = () => Date.now()
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

/* ================================================================== *
 * Undo of a whole reply
 * ================================================================== */

export interface TurnSnapshot {
  pages: Record<string, Page | null>
  tree: { tree: TreeNode[]; favorites: string[] } | null
  settings: Settings | null
  openPageId: string | null
}

export class TurnRecorder {
  snap: TurnSnapshot = { pages: {}, tree: null, settings: null, openPageId: useStore.getState().activePageId }
  changed = false

  async page(id: string) {
    this.changed = true
    if (id in this.snap.pages) return
    const st = useStore.getState()
    if (st.page && st.page.id === id) this.snap.pages[id] = clone(st.page)
    else {
      const res = await storage.readPage(id).catch(() => null)
      this.snap.pages[id] = res?.data ? clone(res.data) : null
    }
  }

  tree() {
    this.changed = true
    if (this.snap.tree) return
    const ws = useStore.getState().workspace
    this.snap.tree = { tree: clone(stripLocal(ws.tree)), favorites: [...(ws.favorites || [])] }
  }

  settings() {
    this.changed = true
    if (!this.snap.settings) this.snap.settings = clone(useStore.getState().settings)
  }
}

function stripLocal(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    const { collapsed: _c, ...rest } = n
    return { ...rest, children: stripLocal(n.children || []) }
  })
}

const snapshots = new Map<string, TurnSnapshot>()
const SNAP_KEY = 'agent-undo-v1'

function loadSnaps() {
  try {
    const raw = localStorage.getItem(SNAP_KEY)
    if (raw) for (const [k, v] of JSON.parse(raw)) snapshots.set(k, v)
  } catch {
    /* none */
  }
}
loadSnaps()

export function keepSnapshot(turnId: string, snap: TurnSnapshot) {
  snapshots.set(turnId, snap)
  // Keep the last 15 on this computer.
  while (snapshots.size > 15) snapshots.delete(snapshots.keys().next().value as string)
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify([...snapshots]))
  } catch {
    /* too big: keep in memory only */
  }
}

export function canUndo(turnId: string) {
  return snapshots.has(turnId)
}

/** Puts back everything a reply changed. */
export async function undoTurn(turnId: string): Promise<boolean> {
  const snap = snapshots.get(turnId)
  if (!snap) return false
  const st = useStore.getState()
  if (snap.tree) st.replaceTree(clone(snap.tree.tree), [...snap.tree.favorites])
  if (snap.settings) st.setSettings(clone(snap.settings))
  for (const [id, before] of Object.entries(snap.pages)) {
    const cur = useStore.getState()
    const inTree = Boolean(findNode(cur.workspace.tree, id))
    if (!before) {
      if (!inTree) await storage.deletePage(id).catch(() => {})
      else if (cur.page?.id === id) cur.applyPageEdit((p) => ({ ...p, cells: [], strokes: [] }))
      continue
    }
    if (cur.page && cur.page.id === id) {
      cur.applyPageEdit(() => clone(before))
    } else {
      const res = await storage.readPage(id).catch(() => null)
      await storage.writePage(id, clone(before), res?.data ?? null, { all: true, meta: true })
    }
  }
  const after = useStore.getState()
  if (after.activePageId && !findNode(after.workspace.tree, after.activePageId)) {
    let first: string | null = null
    walk(after.workspace.tree, (n) => {
      if (!first && n.kind === 'page') first = n.id
    })
    if (first) await after.openPage(first)
  }
  snapshots.delete(turnId)
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify([...snapshots]))
  } catch {
    /* ignore */
  }
  return true
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

export interface ToolEnv {
  rec: TurnRecorder
  /** Attachments in this chat, by sha, for insert_image. */
  attachments: Map<string, ChatAttachment>
  /** Asks the user and waits for the answer (ask_user). */
  ask(q: { question: string; options?: string[]; multi?: boolean }): Promise<string>
}

export interface ToolResult {
  /** What the model gets back. */
  content: string
  /** One line for the chat. */
  summary: string
  ok: boolean
  /** Ids to jump to from the chat chip. */
  target?: { pageId?: string; cellId?: string }
}

class ToolError extends Error {}

const ok = (content: unknown, summary: string, target?: ToolResult['target']): ToolResult => ({
  content: typeof content === 'string' ? content : JSON.stringify(content),
  summary,
  ok: true,
  target,
})

function settingsNow() {
  return useStore.getState().settings
}

function pageIdOr(id?: string): string {
  const st = useStore.getState()
  const pid = id && id !== 'current' ? String(id).replace(/^\[|\]$/g, '') : st.activePageId
  if (!pid) throw new ToolError('No page is open. Pass page_id or open a page first.')
  const node = findNode(st.workspace.tree, pid)
  if (!node) throw new ToolError(`No page with id ${pid}. Use list_tree or search_notes to find the right id.`)
  if (node.kind !== 'page') throw new ToolError(`${pid} is a ${node.kind}, not a page.`)
  return pid
}

async function loadPage(id: string): Promise<Page> {
  const st = useStore.getState()
  if (st.page && st.page.id === id) return st.page
  const res = await storage.readPage(id)
  if (res.damaged) throw new ToolError('That page file is damaged and was left untouched.')
  if (res.data) return res.data
  const node = findNode(st.workspace.tree, id)
  return { id, title: node?.title || 'Untitled', cells: [], strokes: [], gridSize: settingsNow().gridSize, createdAt: now(), updatedAt: now() }
}

/** Applies a change to a page, open or not, after recording it for undo. */
async function editPage(env: ToolEnv, id: string, fn: (p: Page) => Page, cells?: string[]) {
  await env.rec.page(id)
  const st = useStore.getState()
  if (st.page && st.page.id === id) {
    st.applyPageEdit(fn, cells)
    return useStore.getState().page!
  }
  const res = await storage.readPage(id)
  if (res.damaged) throw new ToolError('That page file is damaged and was left untouched.')
  const base = res.data
  const cur = base ? clone(base) : await loadPage(id)
  const next = { ...fn(cur), updatedAt: now() }
  await storage.writePage(id, next, base, cells ? { cells, meta: true } : { all: true })
  return next
}

function findCell(page: Page, id: string): Cell {
  const cid = String(id || '').replace(/^\[|\]$/g, '')
  const c = page.cells.find((x) => x.id === cid)
  if (!c) {
    const titled = page.cells.filter((x) => x.title && x.title.toLowerCase() === cid.toLowerCase())
    if (titled.length === 1) return titled[0]
    throw new ToolError(`No cell [${cid}] on page "${page.title}". Its cells are: ${page.cells.map((x) => `[${x.id}] "${x.title}"`).join(', ') || 'none'}`)
  }
  return c
}

/** Which page holds a cell, looking at the open page first. */
async function pageOfCell(cellId: string, pageId?: string): Promise<string> {
  if (pageId) return pageIdOr(pageId)
  const st = useStore.getState()
  if (st.page?.cells.some((c) => c.id === cellId)) return st.page.id
  if (st.page && !st.page.cells.some((c) => c.id === cellId)) {
    throw new ToolError(`Cell [${cellId}] is not on the open page. Pass page_id.`)
  }
  return pageIdOr()
}

const snap = (v: number, g: number, on: boolean) => (on ? Math.round(v / g) * g : Math.round(v))
const snapUp = (v: number, g: number, on: boolean) => (on ? Math.ceil(v / g) * g : Math.round(v))

/** Rough height a text cell needs before it is drawn (it grows by itself once shown). */
function guessHeight(html: string, w: number, s: Settings) {
  const text = htmlToText(html)
  const perLine = Math.max(20, Math.floor((w - 2 * s.cellPadding) / (s.bodySize * 0.55)))
  const blocks = (html.match(/<(p|li|h[1-6]|tr|div data-latex)/g) || []).length
  const lines = Math.max(1, Math.ceil(text.length / perLine) + blocks)
  const imgs = (html.match(/<img/g) || []).length
  return Math.round(lines * s.bodySize * s.lineHeight + s.titleSize * 1.8 + 2 * s.cellPadding + imgs * 260)
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap = 0) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

/** Moves a box down until it sits on free space. */
function freeSpot(cells: { x: number; y: number; w: number; h: number }[], box: { x: number; y: number; w: number; h: number }, gap: number) {
  const b = { ...box }
  for (let i = 0; i < 400; i++) {
    const hit = cells.find((c) => overlaps(c, b, gap))
    if (!hit) return b
    b.y = hit.y + hit.h + gap
  }
  return b
}

interface Placement {
  x?: number
  y?: number
  placement?: string
  anchor_cell_id?: string
}

function placeBox(page: Page, w: number, h: number, p: Placement, s: Settings, isOpen: boolean) {
  const gap = s.cellGap || 8
  const g = s.gridSize
  const cells = page.cells
  let x = 40
  let y = 120
  const where = (p.placement || '').toLowerCase()
  const anchor = p.anchor_cell_id ? cells.find((c) => c.id === p.anchor_cell_id) : undefined
  if (typeof p.x === 'number' || typeof p.y === 'number') {
    x = p.x ?? 40
    y = p.y ?? 120
    return { x: snap(x, g, s.snapToGrid), y: snap(y, g, s.snapToGrid) }
  }
  if (anchor && where === 'right_of') {
    x = anchor.x + anchor.w + gap * 2
    y = anchor.y
  } else if (anchor && where === 'left_of') {
    x = Math.max(0, anchor.x - w - gap * 2)
    y = anchor.y
  } else if (anchor && where === 'above') {
    x = anchor.x
    y = Math.max(100, anchor.y - h - gap)
  } else if (anchor) {
    x = anchor.x
    y = anchor.y + anchor.h + gap
  } else if (where === 'top') {
    x = cells.length ? Math.min(...cells.map((c) => c.x)) : 40
    y = 120
  } else if (where === 'end' || !isOpen) {
    x = cells.length ? Math.min(...cells.map((c) => c.x)) : 40
    y = cells.length ? Math.max(...cells.map((c) => c.y + c.h)) + gap : 120
  } else {
    // In view: under whatever is on screen, so it shows up where they look.
    const wrap = document.querySelector('.canvas-wrap') as HTMLElement | null
    const zoom = useStore.getState().zoom || 1
    const vx = wrap ? wrap.scrollLeft / zoom : 0
    const vy = wrap ? wrap.scrollTop / zoom : 0
    const vh = wrap ? wrap.clientHeight / zoom : 800
    const inView = cells.filter((c) => c.y < vy + vh && c.y + c.h > vy)
    x = inView.length ? Math.min(...inView.map((c) => c.x)) : Math.max(40, vx + 40)
    y = Math.max(vy + 40, 120)
  }
  const spot = freeSpot(anchor && (where === 'right_of' || where === 'left_of') ? cells.filter((c) => c.id !== anchor.id) : cells, { x, y, w, h }, gap)
  return { x: snap(Math.max(0, spot.x), g, s.snapToGrid), y: snap(Math.max(0, spot.y), g, s.snapToGrid) }
}

/** Replaces or styles text inside cell HTML, one text node at a time. */
function transformText(html: string, find: string, opts: { all?: boolean; wrap?: (text: string) => string; replace?: string; regex?: boolean; caseSensitive?: boolean }) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const flags = (opts.all ? 'g' : '') + (opts.caseSensitive ? '' : 'i')
  const pattern = opts.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch (e) {
    throw new ToolError(`Bad pattern: ${(e as Error).message}`)
  }
  let count = 0
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    if (!opts.all && count) break
    const text = node.data
    const parts: (string | { m: string })[] = []
    let last = 0
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (!m[0]) {
        re.lastIndex++
        continue
      }
      parts.push(text.slice(last, m.index), { m: m[0] })
      last = m.index + m[0].length
      count++
      if (!opts.all) break
    }
    if (!parts.length) continue
    parts.push(text.slice(last))
    const frag = doc.createDocumentFragment()
    for (const p of parts) {
      if (typeof p === 'string') {
        if (p) frag.appendChild(doc.createTextNode(p))
        continue
      }
      const span = doc.createElement('span')
      if (opts.wrap) span.innerHTML = opts.wrap(p.m)
      else if (opts.replace !== undefined) span.innerHTML = opts.regex ? agentInlineToHtml(p.m.replace(new RegExp(pattern, opts.caseSensitive ? '' : 'i'), opts.replace)) : agentInlineToHtml(opts.replace)
      while (span.firstChild) frag.appendChild(span.firstChild)
    }
    node.parentNode!.replaceChild(frag, node)
  }
  return { html: doc.body.innerHTML, count }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function nodeLabel(n: TreeNode) {
  return `${n.kind} "${n.title}"`
}

/* ================================================================== *
 * Tool definitions (JSON schema, as Ollama expects)
 * ================================================================== */

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })
const bool = (description: string) => ({ type: 'boolean', description })

const cellStyleProps = {
  bg: str('Cell background color, CSS color like "#2b3a4a" or "rgba(97,175,239,0.15)". Empty string = default.'),
  border: str('Cell border color. Empty string = default.'),
  show_title: bool('Show the bold title line of the cell.'),
  locked: bool('Lock the cell position.'),
  collapsed: bool('Collapse the cell to its title.'),
  auto_height: bool('Cell height follows its text (default true).'),
}

const fn = (name: string, description: string, properties: Record<string, any>, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
})

export const TOOL_DEFS = [
  fn('get_context', 'Fresh snapshot of what the user sees now (open page, cells on screen, selection, caret, tree). Use after navigating or when unsure the context is current.', {}),
  fn('list_tree', 'List notebooks, sections and pages with ids. Optionally only under one node.', {
    root_id: str('Only list under this node id.'),
    include_archived: bool('Include archived notebooks.'),
  }),
  fn('read_page', 'Read every cell of any page (id, title, position, colors, full content as Markdown).', {
    page_id: str('Page id. Omit for the open page.'),
  }),
  fn('read_cell', 'Read one cell completely. format "html" gives the exact stored HTML (for precise styling work).', {
    cell_id: str('Cell id.'),
    page_id: str('Page id. Omit for the open page.'),
    format: { type: 'string', enum: ['markdown', 'html'], description: 'Default markdown.' },
  }, ['cell_id']),
  fn('search_notes', 'Ranked search across every page, cell, notebook and section name, archived ones included. Forgives typos and matches word starts; "quotes" force an exact phrase. Returns pages best first, each with its path and the matching cells (snippet and a note: link to cite). Search before answering anything about what their notes say or where something is.', {
    query: str('Words to find. Keep it to the key words.'),
    also: { type: 'array', items: { type: 'string' }, description: 'Other phrasings searched at the same time: synonyms, singular or plural, related terms, a likely title, another language.' },
    max_results: { type: 'number', description: 'Pages to return, default 12, max 30.' },
  }, ['query']),
  fn('recent_notes', 'Cells created or edited recently, newest first, with path, time, a text preview and a note: link. For "what did I write yesterday", "a note I added last week", or finding a lost recent note.', {
    days: { type: 'number', description: 'How far back, in days (0.5 = 12 hours). Default 7.' },
    root_id: str('Only under this notebook, section or page.'),
    limit: { type: 'number', description: 'Default 25, max 60.' },
  }),
  fn('create_cells', 'Create one or more text cells on a page. Content is Markdown with $LaTeX$, tables, task lists, code blocks; inline HTML allowed for colors (<span style="color:#e06c75">x</span>), highlight (<mark data-color="#ffd75e">x</mark>), font size (<span style="font-size:20px">x</span>), underline (<u>), and [columns][column]..[/column][column]..[/column][/columns] for side by side columns. Placement default: in the area the user is looking at, never overlapping.', {
    page_id: str('Page id. Omit for the open page.'),
    cells: {
      type: 'array',
      description: 'Cells to create, in reading order.',
      items: {
        type: 'object',
        properties: {
          title: str('Bold title line of the cell. Can be empty.'),
          content: str('Cell body in Markdown (see tool description).'),
          w: num('Width in px. Default from settings (usually 560).'),
          h: num('Height in px, only matters when auto_height is false.'),
          x: num('Exact x position (page px). Overrides placement.'),
          y: num('Exact y position (page px). Overrides placement.'),
          placement: { type: 'string', enum: ['in_view', 'below', 'right_of', 'left_of', 'above', 'end', 'top'], description: 'Where to put it. below/right_of/left_of/above need anchor_cell_id. Later cells in the same call default to below the previous one.' },
          anchor_cell_id: str('Cell to place relative to.'),
          ...cellStyleProps,
        },
      },
    },
  }, ['cells']),
  fn('update_cell', 'Change a cell: its title, content (replace, append or prepend Markdown), colors, position, size, flags. Only given fields change.', {
    cell_id: str('Cell id.'),
    page_id: str('Page id. Omit for the open page.'),
    title: str('New title.'),
    content: str('New content in Markdown (see create_cells).'),
    content_mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'How to use content. Default replace.' },
    x: num('New x.'),
    y: num('New y.'),
    w: num('New width.'),
    h: num('New height.'),
    ...cellStyleProps,
  }, ['cell_id']),
  fn('edit_cell_text', 'Precise find and replace of plain text inside a cell, keeping all other formatting. Prefer this over rewriting a whole cell for small text fixes. It cannot match or move math formulas, images or tables: for those, rewrite the cell with update_cell, copying the existing LaTeX exactly.', {
    cell_id: str('Cell id.'),
    page_id: str('Page id. Omit for the open page.'),
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          find: str('Exact text to find (as shown on screen, not Markdown).'),
          replace: str('Replacement; inline Markdown/LaTeX allowed. Empty string deletes.'),
          all: bool('Replace every occurrence (default first only).'),
          regex: bool('find is a JavaScript regex; replace may use $1.'),
        },
        required: ['find', 'replace'],
      },
    },
  }, ['cell_id', 'edits']),
  fn('format_text', 'Style words or phrases inside cells, or all text of a cell (whole_cell), keeping lists, tables and math intact: text color, highlight, bold, italic, underline, strike, font size. Use cell_id "*" for every cell on the page.', {
    cell_id: str('Cell id, or "*" for all cells on the page.'),
    page_id: str('Page id. Omit for the open page.'),
    find: str('Text to style (exact, case-insensitive unless case_sensitive). Omit with whole_cell.'),
    whole_cell: bool('Style all text in the cell(s) instead of a phrase.'),
    all: bool('Style every occurrence (default true).'),
    case_sensitive: bool('Match case.'),
    color: str('Text color, CSS color.'),
    highlight: str('Highlight color, CSS color.'),
    bold: bool('Bold.'),
    italic: bool('Italic.'),
    underline: bool('Underline.'),
    strike: bool('Strikethrough.'),
    font_size: num('Font size in px.'),
  }, ['cell_id']),
  fn('delete_cells', 'Delete cells from a page.', {
    cell_ids: { type: 'array', items: { type: 'string' }, description: 'Cell ids.' },
    page_id: str('Page id. Omit for the open page.'),
  }, ['cell_ids']),
  fn('arrange_cells', 'Lay cells out: tidy removes overlaps; stack puts them in one column; row puts them side by side; grid in columns; align_left/align_top line them up; same_width sets one width; front/back changes stacking.', {
    action: { type: 'string', enum: ['tidy', 'stack', 'row', 'grid', 'align_left', 'align_top', 'same_width', 'front', 'back'] },
    cell_ids: { type: 'array', items: { type: 'string' }, description: 'Cells to arrange. Omit for all cells (tidy, stack, grid).' },
    page_id: str('Page id. Omit for the open page.'),
    columns: num('For grid: number of columns (default 2).'),
    gap: num('Space between cells in px.'),
    width: num('For same_width.'),
    x: num('Left edge for stack/row/grid (default: leftmost cell).'),
    y: num('Top edge for stack/row/grid (default: topmost cell).'),
  }, ['action']),
  fn('duplicate_cells', 'Copy cells, optionally to another page.', {
    cell_ids: { type: 'array', items: { type: 'string' } },
    page_id: str('Source page. Omit for the open page.'),
    to_page_id: str('Copy onto this page instead (placed at its end).'),
    move: bool('Move instead of copy (removes them from the source).'),
  }, ['cell_ids']),
  fn('view_image', 'Look at an image with a vision model and get back text: a faithful transcription (default, with Markdown and LaTeX), a description, or the answer to a question about it. Works whatever model you are, for images the user attached (source "attachment:<sha>") and images inside cells (cell_id, optionally index). Use it before transcribing, replacing or answering about any image you cannot see yourself.', {
    source: str('"attachment:<sha>", an "asset://local/..." image, or a URL.'),
    cell_id: str('Read the images inside this cell instead.'),
    page_id: str('Page of cell_id. Omit for the open page.'),
    index: { type: 'number', description: 'Which image in the cell, from 1. Default: all (up to 4).' },
    task: { type: 'string', enum: ['transcribe', 'describe'], description: 'Default transcribe.' },
    question: str('A specific question about the image, instead of task.'),
  }),
  fn('insert_image','Put an image into a cell or a new cell: an image the user attached in this chat (source "attachment:<sha>"), a rendered PDF page ("attachment:<sha>" of the page image), an image already in the notes ("asset://local/..."), or a web URL.', {
    source: str('attachment:<sha>, asset://local/<name> or https URL.'),
    page_id: str('Page id. Omit for the open page.'),
    cell_id: str('Add to this existing cell (at the end). Omit to create a new cell.'),
    title: str('Title for the new cell.'),
    width: num('Image display width in px.'),
    caption: str('Optional text under the image.'),
    placement: { type: 'string', enum: ['in_view', 'below', 'right_of', 'end', 'top'] },
    anchor_cell_id: str('Cell to place the new cell relative to.'),
  }, ['source']),
  fn('focus', 'Scroll the user\'s view to a cell (and select it), or open a page. Use to show them what you changed.', {
    page_id: str('Page to open (if not open).'),
    cell_id: str('Cell to scroll to and select.'),
    zoom: num('Optional zoom, 0.3 to 3.'),
  }),
  fn('page_edit', 'Page level changes: rename the page, insert vertical space (shift everything below y), clear page ink.', {
    page_id: str('Page id. Omit for the open page.'),
    title: str('New page title.'),
    insert_space_at_y: num('Shift everything at or below this y.'),
    insert_space_amount: num('How far (px, negative pulls up).'),
    clear_ink: bool('Remove all freehand ink on the page.'),
  }),
  fn('create_node', 'Create a notebook, section (inside a notebook or section) or page (inside a section or under another page). Pages can get initial cells.', {
    kind: { type: 'string', enum: ['notebook', 'section', 'page'] },
    title: str('Title.'),
    parent_id: str('Parent id (notebook/section for sections; section or page for pages). Omit for a notebook.'),
    color: str('Optional color for the node.'),
    open: bool('Open the new page for the user (default false).'),
    cells: { type: 'array', description: 'For pages: cells to create, same shape as create_cells.cells.', items: { type: 'object' } },
  }, ['kind', 'title']),
  fn('update_node', 'Rename, recolor, archive/unarchive, favorite/unfavorite or move a notebook, section or page.', {
    id: str('Node id.'),
    title: str('New title.'),
    color: str('New color (CSS) or "" to clear.'),
    archived: bool('Archive (notebooks).'),
    favorite: bool('Favorite (pages).'),
    move_to: str('Target node id to move next to or into.'),
    position: { type: 'string', enum: ['before', 'after', 'inside'], description: 'With move_to.' },
  }, ['id']),
  fn('delete_node', 'Delete a notebook, section or page with everything inside (pages go to the notes folder trash).', {
    id: str('Node id.'),
  }, ['id']),
  fn('get_settings', 'Read all app settings (theme, colors, fonts, sizes, grid, defaults).', {}),
  fn('update_settings', 'Change app settings. Keys: theme (dark|light|sepia|midnight|nord|system), accent, pageBackground (none|grid|dots|lines), gridSize, snapToGrid, bodyFont, headingFont, monoFont, bodySize, titleSize, pageTitleSize, lineHeight, bodyColor, titleColor, defaultCellWidth, defaultCellHeight, cellPadding, cellRadius, cellBorder, cellBg, cellGap, cellAutoHeight, penColor, penSize, highlighterColor, highlighterSize, spellcheck, showStatusBar, showPageDate, confirmDelete, maxImageWidth, markdownPaste, autoMath, smartQuotes, sidebarVisible, pagelistVisible.', {
    changes: { type: 'object', description: 'Setting names to new values.' },
  }, ['changes']),
  fn('web_search', 'Search the web for current or outside information (facts, explanations, definitions, docs, news). Returns titles, URLs and snippets. Use web_fetch to read a page in full.', {
    query: str('Search query, specific and in the language most likely to find good sources.'),
    max_results: num('1 to 10, default 5.'),
  }, ['query']),
  fn('web_fetch', 'Read a web page (from web_search or a URL the user gave) as text.', {
    url: str('The page URL.'),
  }, ['url']),
  fn('ask_user', 'Ask the user a question and wait for the answer. Use when the request is ambiguous and a wrong guess would cost them work. Offer short options when you can; they can always type their own answer.', {
    question: str('The question, short and specific.'),
    options: { type: 'array', items: { type: 'string' }, description: '2 to 5 short answer options.' },
    multi: bool('Allow picking several options.'),
  }, ['question']),
]

/* ================================================================== *
 * Tool implementations
 * ================================================================== */

type Args = Record<string, any>

function cellSummary(c: Cell) {
  return { id: c.id, title: c.title, x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h), bg: c.bg || undefined, border: c.border || undefined, locked: c.locked || undefined, collapsed: c.collapsed || undefined }
}

function buildCells(page: Page, specs: Args[], s: Settings, isOpen: boolean) {
  const made: Cell[] = []
  let maxZ = page.cells.reduce((m, c) => Math.max(m, c.z), 0)
  const work = { ...page, cells: [...page.cells] }
  let prev: Cell | null = null
  for (const spec of specs) {
    const html = agentToHtml(spec.content ?? '')
    const w = snapUp(Number(spec.w) || s.defaultCellWidth, s.gridSize, s.snapToGrid)
    const auto = spec.auto_height !== false
    const h = snapUp(auto ? Math.max(guessHeight(html, w, s), s.gridSize * 3) : Number(spec.h) || s.defaultCellHeight, s.gridSize, s.snapToGrid)
    const placement: Placement = { x: spec.x, y: spec.y, placement: spec.placement, anchor_cell_id: spec.anchor_cell_id }
    if (prev && !spec.placement && spec.x === undefined && spec.y === undefined) {
      placement.placement = 'below'
      placement.anchor_cell_id = prev.id
    }
    const pos = placeBox(work, w, h, placement, s, isOpen)
    const cell: Cell = {
      id: nanoid(12),
      kind: 'text',
      x: pos.x,
      y: pos.y,
      w,
      h,
      z: ++maxZ,
      title: String(spec.title ?? ''),
      showTitle: spec.show_title !== false,
      html,
      autoHeight: auto,
      createdAt: now(),
      updatedAt: now(),
    }
    if (spec.bg) cell.bg = String(spec.bg)
    if (spec.border) cell.border = String(spec.border)
    if (spec.locked) cell.locked = true
    if (spec.collapsed) cell.collapsed = true
    made.push(cell)
    work.cells.push(cell)
    prev = cell
  }
  return made
}

function applyStyle(c: Cell, a: Args): Partial<Cell> {
  const p: Partial<Cell> = {}
  if (a.bg !== undefined) p.bg = String(a.bg)
  if (a.border !== undefined) p.border = String(a.border)
  if (a.show_title !== undefined) p.showTitle = Boolean(a.show_title)
  if (a.locked !== undefined) p.locked = Boolean(a.locked)
  if (a.collapsed !== undefined) p.collapsed = Boolean(a.collapsed)
  if (a.auto_height !== undefined) p.autoHeight = Boolean(a.auto_height)
  void c
  return p
}

async function insertImageSource(src: string, env: ToolEnv): Promise<string> {
  const s = String(src || '').trim()
  if (s.startsWith('attachment:')) {
    const sha = s.slice('attachment:'.length)
    const att = env.attachments.get(sha)
    const url = await chatApi.blobToAsset(sha, att?.mime?.startsWith('image/') ? att.mime : 'image/png')
    if (!url) throw new ToolError('That attachment could not be read.')
    return url
  }
  if (/^(asset:\/\/|https?:\/\/|data:image\/)/.test(s)) return s
  throw new ToolError('source must be attachment:<sha>, asset://local/<name> or an https URL.')
}

const IMPL: Record<string, (a: Args, env: ToolEnv) => Promise<ToolResult>> = {
  async get_context() {
    return ok(buildContext().full, 'Looked at the screen')
  },

  async list_tree(a) {
    const st = useStore.getState()
    const roots = a.root_id ? findNode(st.workspace.tree, a.root_id)?.children : st.workspace.tree
    if (!roots) throw new ToolError(`No node ${a.root_id}`)
    const lines: string[] = []
    const visit = (ns: TreeNode[], d: number) => {
      for (const n of ns) {
        if (n.archived && !a.include_archived && d === 0 && !a.root_id) continue
        lines.push(`${'  '.repeat(d)}- ${n.kind} "${n.title}" [${n.id}]${n.archived ? ' (archived)' : ''}${n.color ? ` color ${n.color}` : ''}${n.id === st.activePageId ? ' OPEN NOW' : ''}`)
        visit(n.children || [], d + 1)
      }
    }
    visit(roots, 0)
    return ok(lines.join('\n') || '(nothing)', 'Listed notebooks')
  },

  async read_page(a) {
    const id = pageIdOr(a.page_id)
    const p = await loadPage(id)
    const cells = [...p.cells].sort((x, y) => x.y - y.y || x.x - y.x)
    const path = pathTo(useStore.getState().workspace.tree, id).map((n) => n.title).join(' > ')
    const out = [`Page "${p.title}" [${p.id}] in ${path}. ${cells.length} cells.`]
    for (const c of cells) out.push(`### Cell [${c.id}] "${c.title}" ${JSON.stringify(cellSummary(c))}\n${c.kind === 'ink' ? '(ink drawing)' : htmlToAgent(c.html) || '(empty)'}`)
    return ok(out.join('\n\n'), `Read page "${p.title}"`, { pageId: id })
  },

  async read_cell(a) {
    const pid = await pageOfCell(a.cell_id, a.page_id)
    const p = await loadPage(pid)
    const c = findCell(p, a.cell_id)
    const body = a.format === 'html' ? c.html : htmlToAgent(c.html)
    return ok(`Cell [${c.id}] "${c.title}" ${JSON.stringify(cellSummary(c))}\n${body || '(empty)'}`, `Read cell "${c.title || htmlToText(c.html).slice(0, 30)}"`, { pageId: pid, cellId: c.id })
  },

  async search_notes(a) {
    const st = useStore.getState()
    // Search what is on screen too, even if it was edited a moment ago.
    if (st.dirty) await st.save()
    const queries = [a.query, ...(Array.isArray(a.also) ? a.also : [])].map((q) => String(q || '').trim()).filter(Boolean)
    if (!queries.length) throw new ToolError('query is empty.')
    const limit = Math.min(30, Math.max(1, Number(a.max_results) || 12))
    // Several phrasings at once: each page keeps its best score, pages found by more phrasings rank higher.
    const best = new Map<string, { h: Awaited<ReturnType<typeof storage.search>>[number]; score: number; via: string[] }>()
    for (const q of queries) {
      for (const h of await storage.search(q)) {
        const cur = best.get(h.pageId)
        if (!cur) best.set(h.pageId, { h, score: h.score, via: [q] })
        else {
          cur.via.push(q)
          cur.score = Math.max(cur.score, h.score) * 1.15
          if (h.score > cur.h.score) cur.h = h
        }
      }
    }
    const ranked = [...best.values()].sort((x, y) => y.score - x.score).slice(0, limit)
    const out = ranked.map(({ h, via }) => ({
      page: `"${h.title}" [${h.pageId}]`,
      link: `note:${h.pageId}`,
      path: pathTo(st.workspace.tree, h.pageId).map((n) => n.title).join(' > '),
      ...(queries.length > 1 ? { found_by: via } : {}),
      ...(h.partial ? { partial_match: true } : {}),
      ...(h.near?.length ? { near_match: h.near.map((n) => `"${n.term}" matched "${n.word}"`).join(', ') } : {}),
      ...(h.missing?.length ? { missing_words: h.missing } : {}),
      ...(h.archived ? { archived: true } : {}),
      cells: h.hits.slice(0, 6).map((x) => ({ link: `note:${h.pageId}#${x.cellId}`, title: x.cellTitle, snippet: x.snippet })),
    }))
    const summary = `Searched notes for ${queries.map((q) => `"${q}"`).join(', ')} (${best.size} ${best.size === 1 ? 'page' : 'pages'})`
    return ok(out.length ? out : 'No matches. Try other words: synonyms, a shorter word, the likely cell or page title.', summary)
  },

  async recent_notes(a) {
    const st = useStore.getState()
    if (st.dirty) await st.save()
    const days = Math.min(365, Math.max(0.05, Number(a.days) || 7))
    const since = Date.now() - days * 864e5
    const limit = Math.min(60, Math.max(1, Number(a.limit) || 25))
    const under = a.root_id ? findNode(st.workspace.tree, a.root_id) : null
    const ids: string[] = []
    walk(under ? [under] : st.workspace.tree, (n) => {
      if (n.kind === 'page') ids.push(n.id)
    })
    const rows: { at: number; line: string }[] = []
    for (const id of ids) {
      const p = id === st.page?.id ? st.page : (await storage.readPage(id).catch(() => null))?.data
      if (!p) continue
      const path = pathTo(st.workspace.tree, id).map((n) => n.title).join(' > ')
      for (const c of p.cells || []) {
        const at = c.updatedAt || c.createdAt || 0
        if (at < since || c.kind === 'ink') continue
        const text = htmlToText(c.html).replace(/\s+/g, ' ').trim()
        rows.push({ at, line: `${new Date(at).toLocaleString()} | ${path} | cell "${c.title || text.slice(0, 40)}" (note:${id}#${c.id}): ${text.slice(0, 160)}` })
      }
    }
    rows.sort((x, y) => y.at - x.at)
    const out = rows.slice(0, limit).map((r) => r.line)
    return ok(out.length ? out.join('\n') : `No cells changed in the last ${days} days.`, `Listed notes changed in the last ${days < 1 ? `${Math.round(days * 24)} hours` : `${days} days`}`)
  },

  async create_cells(a, env) {
    const id = pageIdOr(a.page_id)
    const specs: Args[] = Array.isArray(a.cells) ? a.cells : a.content !== undefined || a.title !== undefined ? [a] : []
    if (!specs.length) throw new ToolError('cells is empty.')
    const s = settingsNow()
    const isOpen = useStore.getState().activePageId === id
    let made: Cell[] = []
    await editPage(env, id, (p) => {
      made = buildCells(p, specs, s, isOpen)
      return { ...p, cells: [...p.cells, ...made] }
    }, [])
    if (isOpen && made.length) useStore.getState().setSelection(made.map((c) => c.id))
    const names = made.map((c) => c.title || htmlToText(c.html).slice(0, 30) || 'cell')
    return ok(
      { created: made.map((c) => ({ id: c.id, title: c.title, x: c.x, y: c.y, w: c.w })) },
      made.length === 1 ? `Added cell "${names[0]}"` : `Added ${made.length} cells`,
      { pageId: id, cellId: made[0]?.id },
    )
  },

  async update_cell(a, env) {
    const pid = await pageOfCell(a.cell_id, a.page_id)
    let title = ''
    let cid = ''
    const changes: string[] = []
    const s = settingsNow()
    await editPage(env, pid, (p) => {
      const c = findCell(p, a.cell_id)
      cid = c.id
      const patch: Partial<Cell> = applyStyle(c, a)
      if (a.title !== undefined) { patch.title = String(a.title); changes.push('title') }
      if (a.content !== undefined) {
        const html = agentToHtml(String(a.content))
        const mode = a.content_mode || 'replace'
        patch.html = mode === 'append' ? (c.html || '') + html : mode === 'prepend' ? html + (c.html || '') : html
        changes.push(mode === 'replace' ? 'content' : `${mode}ed text`)
      }
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        if (typeof a[k] === 'number') {
          patch[k] = k === 'x' || k === 'y' ? snap(a[k], s.gridSize, s.snapToGrid) : snapUp(Math.max(s.gridSize * 2, a[k]), s.gridSize, s.snapToGrid)
          if (k === 'h') patch.autoHeight = a.auto_height ?? false
        }
      }
      if (Object.keys(patch).some((k) => ['bg', 'border'].includes(k))) changes.push('colors')
      if (['x', 'y'].some((k) => k in patch)) changes.push('position')
      if (['w', 'h'].some((k) => k in patch)) changes.push('size')
      title = patch.title ?? c.title
      return { ...p, cells: p.cells.map((x) => (x.id === c.id ? { ...x, ...patch, updatedAt: now() } : x)) }
    }, [String(a.cell_id)])
    return ok({ updated: cid, changed: changes }, `Updated "${title || 'cell'}"${changes.length ? ` (${changes.join(', ')})` : ''}`, { pageId: pid, cellId: cid })
  },

  async edit_cell_text(a, env) {
    const pid = await pageOfCell(a.cell_id, a.page_id)
    const edits: Args[] = Array.isArray(a.edits) ? a.edits : []
    const report: string[] = []
    let title = ''
    let cid = ''
    await editPage(env, pid, (p) => {
      const c = findCell(p, a.cell_id)
      cid = c.id
      title = c.title
      let html = c.html
      for (const e of edits) {
        let r = transformText(html, String(e.find ?? ''), { all: Boolean(e.all), replace: String(e.replace ?? ''), regex: Boolean(e.regex), caseSensitive: true })
        if (!r.count) r = transformText(html, String(e.find ?? ''), { all: Boolean(e.all), replace: String(e.replace ?? ''), regex: Boolean(e.regex), caseSensitive: false })
        if (!r.count) {
          // Text split across formatting: fall back to a Markdown round trip.
          const md = htmlToAgent(html)
          if (md.includes(String(e.find))) {
            const next = e.all ? md.split(String(e.find)).join(String(e.replace)) : md.replace(String(e.find), String(e.replace))
            html = agentToHtml(next)
            report.push(`"${e.find}": replaced (via markdown)`)
          } else report.push(`"${e.find}": NOT FOUND`)
          continue
        }
        html = r.html
        report.push(`"${e.find}": ${r.count} replaced`)
      }
      if (title === undefined) title = ''
      return { ...p, cells: p.cells.map((x) => (x.id === c.id ? { ...x, html, updatedAt: now() } : x)) }
    }, [String(a.cell_id)])
    const failed = report.filter((r) => r.includes('NOT FOUND')).length
    return { ...ok(report.join('\n'), `Edited text in "${title || 'cell'}"`, { pageId: pid, cellId: cid }), ok: failed < edits.length }
  },

  async format_text(a, env) {
    const pid = pageIdOr(a.page_id && a.cell_id === '*' ? a.page_id : a.cell_id === '*' ? undefined : await pageOfCell(a.cell_id, a.page_id))
    const styles: string[] = []
    if (a.color) styles.push(`color: ${a.color}`)
    if (a.font_size) styles.push(`font-size: ${Number(a.font_size)}px`)
    const wrap = (t: string) => {
      let h = esc(t)
      if (a.bold) h = `<strong>${h}</strong>`
      if (a.italic) h = `<em>${h}</em>`
      if (a.underline) h = `<u>${h}</u>`
      if (a.strike) h = `<s>${h}</s>`
      if (styles.length) h = `<span style="${styles.join('; ')}">${h}</span>`
      if (a.highlight) h = `<mark data-color="${esc(String(a.highlight))}" style="background-color: ${esc(String(a.highlight))}; color: inherit">${h}</mark>`
      return h
    }
    let total = 0
    const touched: string[] = []
    await editPage(env, pid, (p) => {
      const targets = a.cell_id === '*' ? p.cells.map((c) => c.id) : [findCell(p, a.cell_id).id]
      return {
        ...p,
        cells: p.cells.map((c) => {
          if (!targets.includes(c.id)) return c
          const r = a.whole_cell || !a.find
            ? transformText(c.html, String.raw`\S(?:[\s\S]*\S)?`, { all: true, wrap, regex: true })
            : transformText(c.html, String(a.find), { all: a.all !== false, wrap, caseSensitive: Boolean(a.case_sensitive) })
          if (!r.count) return c
          total += r.count
          touched.push(c.id)
          return { ...c, html: a.highlight ? softenMarks(r.html) : r.html, updatedAt: now() }
        }),
      }
    }, a.cell_id === '*' ? undefined : [String(a.cell_id)])
    if (!total) return { ...ok(`"${a.find}" not found.`, `Could not find "${a.find}"`), ok: false }
    return ok(`Styled ${total} occurrence(s) in ${touched.length} cell(s).`, a.whole_cell || !a.find ? `Styled ${touched.length === 1 ? "the cell" : `${touched.length} cells`}` : `Styled "${a.find}" (${total}x)`, { pageId: pid, cellId: touched[0] })
  },

  async delete_cells(a, env) {
    const ids: string[] = (a.cell_ids || []).map(String)
    if (!ids.length) throw new ToolError('cell_ids is empty.')
    const pid = await pageOfCell(ids[0], a.page_id)
    let names: string[] = []
    await editPage(env, pid, (p) => {
      const found = p.cells.filter((c) => ids.includes(c.id))
      if (!found.length) throw new ToolError(`None of those cells are on page "${p.title}".`)
      names = found.map((c) => c.title || htmlToText(c.html).slice(0, 25))
      return { ...p, cells: p.cells.filter((c) => !ids.includes(c.id)) }
    })
    return ok({ deleted: ids }, names.length === 1 ? `Deleted "${names[0]}"` : `Deleted ${names.length} cells`, { pageId: pid })
  },

  async arrange_cells(a, env) {
    const pid = pageIdOr(a.page_id)
    const s = settingsNow()
    const gap = Number(a.gap) || s.cellGap || 8
    const isOpen = useStore.getState().activePageId === pid
    if (a.action === 'tidy' && isOpen) {
      await env.rec.page(pid)
      useStore.getState().reflowOverlaps(true)
      return ok('Overlaps removed.', 'Tidied the layout', { pageId: pid })
    }
    await editPage(env, pid, (p) => {
      const ids: string[] = a.cell_ids?.length ? a.cell_ids.map(String) : p.cells.map((c) => c.id)
      const sel = p.cells.filter((c) => ids.includes(c.id)).sort((x, y) => x.y - y.y || x.x - y.x)
      if (!sel.length) throw new ToolError('No matching cells.')
      const left = typeof a.x === 'number' ? a.x : Math.min(...sel.map((c) => c.x))
      const top = typeof a.y === 'number' ? a.y : Math.min(...sel.map((c) => c.y))
      const pos = new Map<string, Partial<Cell>>()
      if (a.action === 'stack' || a.action === 'tidy') {
        let y = top
        for (const c of sel) {
          pos.set(c.id, { x: a.action === 'stack' ? left : c.x, y })
          y += c.h + gap
        }
      } else if (a.action === 'row') {
        let x = left
        for (const c of [...sel].sort((p1, p2) => p1.x - p2.x)) {
          pos.set(c.id, { x, y: top })
          x += c.w + gap * 2
        }
      } else if (a.action === 'grid') {
        const cols = Math.max(1, Math.round(Number(a.columns) || 2))
        const colW = Math.max(...sel.map((c) => c.w))
        let rowTop = top
        for (let i = 0; i < sel.length; i += cols) {
          const row = sel.slice(i, i + cols)
          row.forEach((c, j) => pos.set(c.id, { x: left + j * (colW + gap * 2), y: rowTop }))
          rowTop += Math.max(...row.map((c) => c.h)) + gap
        }
      } else if (a.action === 'align_left') {
        for (const c of sel) pos.set(c.id, { x: left })
      } else if (a.action === 'align_top') {
        for (const c of sel) pos.set(c.id, { y: top })
      } else if (a.action === 'same_width') {
        const w = Number(a.width) || Math.max(...sel.map((c) => c.w))
        for (const c of sel) pos.set(c.id, { w })
      } else if (a.action === 'front' || a.action === 'back') {
        let z = a.action === 'front' ? p.cells.reduce((m, c) => Math.max(m, c.z), 0) : p.cells.reduce((m, c) => Math.min(m, c.z), 0)
        for (const c of sel) pos.set(c.id, { z: a.action === 'front' ? ++z : --z })
      }
      return {
        ...p,
        cells: p.cells.map((c) => {
          const q = pos.get(c.id)
          if (!q) return c
          const out = { ...c, ...q, updatedAt: now() }
          out.x = snap(out.x, s.gridSize, s.snapToGrid)
          out.y = snap(out.y, s.gridSize, s.snapToGrid)
          return out
        }),
      }
    })
    if (isOpen && ['stack', 'row', 'grid', 'align_left', 'align_top', 'same_width'].includes(a.action)) useStore.getState().reflowOverlaps(false)
    return ok('Done.', `Arranged cells (${a.action})`, { pageId: pid })
  },

  async duplicate_cells(a, env) {
    const ids: string[] = (a.cell_ids || []).map(String)
    const from = await pageOfCell(ids[0], a.page_id)
    const to = a.to_page_id ? pageIdOr(a.to_page_id) : from
    const src = await loadPage(from)
    const picked = src.cells.filter((c) => ids.includes(c.id))
    if (!picked.length) throw new ToolError('No matching cells.')
    const s = settingsNow()
    const copies: Cell[] = []
    await editPage(env, to, (p) => {
      let maxZ = p.cells.reduce((m, c) => Math.max(m, c.z), 0)
      const bottom = p.cells.length ? Math.max(...p.cells.map((c) => c.y + c.h)) + s.cellGap : 120
      const minY = Math.min(...picked.map((c) => c.y))
      for (const c of picked) {
        copies.push({
          ...clone(c),
          id: nanoid(12),
          x: to === from ? c.x + s.gridSize : c.x,
          y: to === from ? c.y + s.gridSize : bottom + (c.y - minY),
          z: ++maxZ,
          conflict: undefined,
          createdAt: now(),
          updatedAt: now(),
        })
      }
      return { ...p, cells: [...p.cells, ...copies] }
    }, [])
    if (a.move && to !== from) await editPage(env, from, (p) => ({ ...p, cells: p.cells.filter((c) => !ids.includes(c.id)) }))
    return ok({ copies: copies.map((c) => c.id) }, `${a.move ? 'Moved' : 'Copied'} ${copies.length} cell(s)`, { pageId: to, cellId: copies[0]?.id })
  },

  async insert_image(a, env) {
    const src = await insertImageSource(a.source, env)
    const w = Number(a.width) || Math.min(settingsNow().maxImageWidth || 800, 520)
    const img = `<p><img src="${esc(src)}" width="${Math.round(w)}"></p>${a.caption ? agentToHtml(String(a.caption)) : ''}`
    if (a.cell_id) {
      const pid = await pageOfCell(a.cell_id, a.page_id)
      await editPage(env, pid, (p) => {
        const c = findCell(p, a.cell_id)
        return { ...p, cells: p.cells.map((x) => (x.id === c.id ? { ...x, html: (x.html || '') + img, updatedAt: now() } : x)) }
      }, [String(a.cell_id)])
      return ok('Image added to the cell.', 'Added an image', { pageId: pid, cellId: a.cell_id })
    }
    const pid = pageIdOr(a.page_id)
    const s = settingsNow()
    const isOpen = useStore.getState().activePageId === pid
    let made: Cell[] = []
    await editPage(env, pid, (p) => {
      made = buildCells(p, [{ title: a.title ?? '', content: '', w: Math.max(w + 2 * s.cellPadding + 8, 240), placement: a.placement, anchor_cell_id: a.anchor_cell_id }], s, isOpen)
      made[0].html = img
      made[0].h = snapUp(w * 0.75 + 80, s.gridSize, s.snapToGrid)
      return { ...p, cells: [...p.cells, ...made] }
    }, [])
    return ok({ cell: made[0]?.id }, 'Added an image', { pageId: pid, cellId: made[0]?.id })
  },

  async view_image(a) {
    const refs: string[] = []
    const source = String(a.source || '')
    if (source.startsWith('attachment:')) refs.push(`sha:${source.slice('attachment:'.length)}`)
    else if (source) refs.push(await imageAsBase64(source))
    if (a.cell_id) {
      const pid = await pageOfCell(a.cell_id, a.page_id)
      const c = findCell(await loadPage(pid), a.cell_id)
      const srcs = [...(c.html || '').matchAll(/<img[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
      if (!srcs.length) throw new ToolError(`Cell [${c.id}] has no images.`)
      const pick = a.index ? [srcs[Number(a.index) - 1]].filter(Boolean) : srcs.slice(0, 4)
      if (!pick.length) throw new ToolError(`Cell [${c.id}] has ${srcs.length} image(s); index starts at 1.`)
      for (const s of pick) refs.push(await imageAsBase64(s))
    }
    if (!refs.length) throw new ToolError('Give source (attachment:<sha>, asset://..., or a URL) or cell_id.')
    const task = a.question
      ? `Answer from the image(s) only: ${a.question}`
      : a.task === 'describe'
        ? 'Describe the image(s) precisely: what it shows, its layout, all visible text, and anything notable. Do not guess beyond what is visible.'
        : 'Transcribe everything in the image(s) exactly as written, in reading order, as Markdown: headings, bullet and numbered lists, tables as Markdown tables, every formula as LaTeX ($...$ inline, $$...$$ for display). Keep the original wording, symbols and order. Do not add, explain, summarize or correct anything. Mark anything you cannot read as [unclear]. Output only the transcription.'
    const model = MODELS.find((m) => m.vision)?.id || DEFAULT_MODEL
    const res = await agentApi.complete({
      model,
      think: false,
      options: { temperature: 0.1 },
      timeout_ms: 150_000,
      messages: [{ role: 'user', content: task, images: refs }],
    })
    if (!res.ok || !res.content?.trim()) throw new ToolError(`Could not read the image (${res.error || 'empty answer'}).`)
    const what = a.question ? 'Looked at the image' : a.task === 'describe' ? 'Described the image' : 'Read the image'
    return ok(`From ${model}, which looked at the image for you:\n${res.content.trim()}`, `${what}${refs.length > 1 ? ` (${refs.length})` : ''}`)
  },

  async focus(a) {
    const st = useStore.getState()
    if (a.page_id && a.page_id !== st.activePageId) await st.openPage(pageIdOr(a.page_id))
    if (typeof a.zoom === 'number') useStore.getState().setZoom(Math.min(3, Math.max(0.3, a.zoom)))
    if (a.cell_id) {
      const cell = useStore.getState().page?.cells.find((c) => c.id === a.cell_id)
      if (!cell) throw new ToolError(`Cell [${a.cell_id}] is not on the open page.`)
      useStore.getState().setSelection([cell.id])
      scrollToCell(cell.id)
    }
    return ok('Done.', a.cell_id ? 'Showed you the cell' : 'Opened the page', { pageId: useStore.getState().activePageId || undefined, cellId: a.cell_id })
  },

  async page_edit(a, env) {
    const pid = pageIdOr(a.page_id)
    const done: string[] = []
    if (a.title !== undefined) {
      env.rec.tree()
      await env.rec.page(pid)
      const st = useStore.getState()
      if (st.activePageId === pid) st.setPageTitle(String(a.title))
      else {
        st.renameNode(pid, String(a.title))
        await editPage(env, pid, (p) => ({ ...p, title: String(a.title) }), [])
      }
      done.push(`renamed to "${a.title}"`)
    }
    if (typeof a.insert_space_at_y === 'number' && typeof a.insert_space_amount === 'number') {
      const at = a.insert_space_at_y
      const amt = a.insert_space_amount
      await editPage(env, pid, (p) => ({
        ...p,
        cells: p.cells.map((c) => (c.y >= at ? { ...c, y: Math.max(0, c.y + amt), updatedAt: now() } : c)),
        strokes: p.strokes.map((s) => {
          const pts = s.points.slice()
          for (let i = 1; i < pts.length; i += 2) if (pts[i] >= at) pts[i] = Math.max(0, pts[i] + amt)
          return { ...s, points: pts }
        }),
      }))
      done.push('inserted space')
    }
    if (a.clear_ink) {
      await editPage(env, pid, (p) => ({ ...p, strokes: [] }))
      done.push('cleared ink')
    }
    return ok(done.join(', ') || 'Nothing to do.', `Page: ${done.join(', ') || 'no change'}`, { pageId: pid })
  },

  async create_node(a, env) {
    const st = useStore.getState()
    const kind = a.kind as TreeNode['kind']
    if (!['notebook', 'section', 'page'].includes(kind)) throw new ToolError('kind must be notebook, section or page.')
    const parent = a.parent_id ? findNode(st.workspace.tree, a.parent_id) : null
    if (a.parent_id && !parent) throw new ToolError(`No node ${a.parent_id}.`)
    if (kind === 'section' && parent && parent.kind === 'page') throw new ToolError('A section cannot go inside a page.')
    if (kind === 'page' && (!parent || parent.kind === 'notebook')) throw new ToolError('A page needs a section (or a page) as parent_id.')
    if (kind === 'notebook' && parent) throw new ToolError('Notebooks have no parent.')
    env.rec.tree()
    const node: TreeNode = { id: nanoid(12), kind, title: String(a.title || 'Untitled'), children: [], createdAt: now(), updatedAt: now() }
    if (a.color) node.color = String(a.color)
    const tree = clone(stripLocal(st.workspace.tree))
    if (parent) findNode(tree, parent.id)!.children.push(node)
    else tree.push(node)
    st.replaceTree(tree, [...st.workspace.favorites])
    await useStore.getState().saveWorkspace()
    if (kind === 'page') {
      env.rec.snap.pages[node.id] = null
      const page: Page = { id: node.id, title: node.title, cells: [], strokes: [], gridSize: settingsNow().gridSize, createdAt: now(), updatedAt: now() }
      if (Array.isArray(a.cells) && a.cells.length) page.cells = buildCells(page, a.cells, settingsNow(), false)
      await storage.writePage(node.id, page, null, { all: true })
      if (a.open) await useStore.getState().openPage(node.id)
    }
    return ok({ id: node.id }, `Created ${kind} "${node.title}"`, kind === 'page' ? { pageId: node.id } : undefined)
  },

  async update_node(a, env) {
    const st = useStore.getState()
    const node = findNode(st.workspace.tree, a.id)
    if (!node) throw new ToolError(`No node ${a.id}.`)
    env.rec.tree()
    const done: string[] = []
    if (a.title !== undefined) {
      if (node.kind === 'page') await env.rec.page(node.id)
      if (st.activePageId === node.id) st.setPageTitle(String(a.title))
      else st.renameNode(node.id, String(a.title))
      done.push(`renamed to "${a.title}"`)
    }
    if (a.color !== undefined) {
      useStore.getState().setNodeColor(node.id, String(a.color))
      done.push(a.color ? `color ${a.color}` : 'color cleared')
    }
    if (a.archived !== undefined) {
      useStore.getState().archiveNode(node.id, Boolean(a.archived))
      done.push(a.archived ? 'archived' : 'unarchived')
    }
    if (a.favorite !== undefined) {
      const fav = useStore.getState().workspace.favorites.includes(node.id)
      if (fav !== Boolean(a.favorite)) useStore.getState().toggleFavorite(node.id)
      done.push(a.favorite ? 'favorited' : 'unfavorited')
    }
    if (a.move_to) {
      const target = findNode(useStore.getState().workspace.tree, a.move_to)
      if (!target) throw new ToolError(`No node ${a.move_to}.`)
      useStore.getState().moveNode(node.id, target.id, a.position || 'inside')
      const parent = findParent(useStore.getState().workspace.tree, node.id)
      done.push(`moved ${a.position || 'inside'} ${nodeLabel(target)}${parent ? '' : ''}`)
    }
    await useStore.getState().saveWorkspace()
    return ok(done.join(', ') || 'Nothing changed.', `${nodeLabel(node)}: ${done.join(', ') || 'no change'}`)
  },

  async delete_node(a, env) {
    const st = useStore.getState()
    const node = findNode(st.workspace.tree, a.id)
    if (!node) throw new ToolError(`No node ${a.id}.`)
    env.rec.tree()
    const pages: string[] = []
    walk([node], (n) => {
      if (n.kind === 'page') pages.push(n.id)
    })
    for (const pid of pages) await env.rec.page(pid)
    await st.deleteNode(node.id)
    return ok({ deleted: node.id, pages: pages.length }, `Deleted ${nodeLabel(node)}${pages.length > 1 ? ` (${pages.length} pages)` : ''}`)
  },

  async get_settings() {
    const { _t, recentColors, ...rest } = settingsNow() as any
    void _t
    void recentColors
    return ok(rest, 'Read the settings')
  },

  async update_settings(a, env) {
    const changes = a.changes && typeof a.changes === 'object' ? a.changes : {}
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS).filter((k) => !['version', '_t'].includes(k)))
    const patch: Record<string, any> = {}
    const bad: string[] = []
    for (const [k, v] of Object.entries(changes)) {
      if (!allowed.has(k)) {
        bad.push(k)
        continue
      }
      const def = (DEFAULT_SETTINGS as any)[k]
      patch[k] = typeof def === 'number' ? Number(v) : typeof def === 'boolean' ? Boolean(v) : v
    }
    if (!Object.keys(patch).length) throw new ToolError(`No valid settings given${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}.`)
    env.rec.settings()
    useStore.getState().setSettings(patch)
    return ok({ changed: patch, unknown: bad }, `Changed settings: ${Object.keys(patch).join(', ')}`)
  },

  async web_search(a) {
    const r = await agentApi.web('search', { query: a.query, max_results: a.max_results })
    if (!r.ok) throw new ToolError(r.error || 'Web search failed.')
    const results = (r.data?.results || []).map((x: any, i: number) => `[${i + 1}] ${x.title}\n${x.url}\n${String(x.content || '').slice(0, 1500)}`)
    return ok(results.join('\n\n') || 'No results.', `Searched the web: "${String(a.query).slice(0, 60)}"`)
  },

  async web_fetch(a) {
    const r = await agentApi.web('fetch', { url: a.url })
    if (!r.ok) throw new ToolError(r.error || 'Could not read that page.')
    const content = String(r.data?.content || '')
    const host = (() => { try { return new URL(String(a.url)).hostname } catch { return String(a.url) } })()
    const body = content.length > 40000 ? `${content.slice(0, 40000)}\n...(cut)` : content
    return ok(`# ${r.data?.title || ''}\n${a.url}\n\n${body}`, `Read ${host}`)
  },

  async ask_user(a, env) {
    const options = Array.isArray(a.options) ? a.options.map(String).slice(0, 6) : undefined
    const answer = await env.ask({ question: String(a.question || ''), options, multi: Boolean(a.multi) })
    return ok(`The user answered: ${answer}`, 'Asked you a question')
  },
}

/** Scrolls the canvas so a cell is in view and flashes it. */
/** An image src from the notes (data:, asset://, or a web URL) as plain base64 for the model. */
async function imageAsBase64(src: string): Promise<string> {
  const data = /^data:image\/[\w.+-]+;base64,(.+)$/i.exec(src)
  if (data) return data[1]
  let res: Response
  try {
    res = await fetch(src)
  } catch {
    throw new ToolError(`Could not load the image ${src.slice(0, 80)}.`)
  }
  if (!res.ok) throw new ToolError(`Could not load the image (${res.status}).`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function scrollToCell(cellId: string) {
  requestAnimationFrame(() => {
    const wrap = document.querySelector('.canvas-wrap') as HTMLElement | null
    const st = useStore.getState()
    const cell = st.page?.cells.find((c) => c.id === cellId)
    if (!wrap || !cell) return
    const z = st.zoom || 1
    // Move only as far as needed: keep what is already in view where it is.
    const vTop = wrap.scrollTop
    const vBottom = vTop + wrap.clientHeight
    const cTop = cell.y * z
    const cBottom = (cell.y + Math.min(cell.h, 400)) * z
    let top = vTop
    if (cTop < vTop + 20 || cBottom > vBottom - 20) top = Math.max(0, cTop - 80)
    const vLeft = wrap.scrollLeft
    const vRight = vLeft + wrap.clientWidth
    const cLeft = cell.x * z
    let left = vLeft
    if (cLeft < vLeft) left = Math.max(0, cLeft - 40)
    else if (cLeft + 160 * z > vRight) left = Math.max(0, cLeft - wrap.clientWidth / 3)
    if (top !== vTop || left !== vLeft) wrap.scrollTo({ top, left, behavior: 'smooth' })
    const el = wrap.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null
    if (el) {
      el.classList.remove('agent-flash')
      void el.offsetWidth
      el.classList.add('agent-flash')
      setTimeout(() => el.classList.remove('agent-flash'), 1600)
    }
  })
}

export async function runTool(name: string, args: Args, env: ToolEnv): Promise<ToolResult> {
  const impl = IMPL[name]
  if (!impl) return { content: `Unknown tool ${name}. Available: ${Object.keys(IMPL).join(', ')}`, summary: `Unknown tool ${name}`, ok: false }
  try {
    return await impl(args || {}, env)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: `Error: ${msg}`, summary: `${name} failed: ${msg.slice(0, 80)}`, ok: false }
  }
}

/** Tools that only read: they never need an undo point. */
export const READ_ONLY = new Set(['view_image', 'web_search', 'web_fetch', 'get_context', 'list_tree', 'read_page', 'read_cell', 'search_notes', 'recent_notes', 'get_settings', 'ask_user', 'focus'])
