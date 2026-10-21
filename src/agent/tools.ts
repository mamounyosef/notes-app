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
import { DEFAULT_MODEL, VISION_MODEL, modelInfo } from './models'
import { buildWidgetDoc, currentTheme, FENCE_OF, fromBase64, kindOf, type WidgetKind } from '../widgets/widget'

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
  /** The chat model running this turn. */
  model: string
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
  target?: { pageId?: string; cellId?: string; anchor?: string; loc?: { x?: number; y?: number } }
  /** When another model did the looking: who, how long, and what it said. */
  helper?: { model: string; ms: number; text: string }
  /** Pictures for a model that can see ("sha:<hash>"): sent to it as real image input with this result. */
  images?: string[]
}

class ToolError extends Error {}

/** Who looks at a picture: the chat model when it can see, otherwise the vision helper. */
export const eyesFor = (chatModel: string) => (modelInfo(chatModel).vision ? chatModel : VISION_MODEL)

/** Stores pictures as chat blobs, so the chat keeps a small reference instead of the bytes. */
async function toRefs(refs: string[]) {
  const out: string[] = []
  for (const r of refs) out.push(r.startsWith('sha:') ? r : `sha:${await chatApi.saveBlob(r)}`)
  return out
}

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

/* ---------------- drawings (HTML blocks) ---------------- */

interface Drawing {
  index: number
  kind: WidgetKind
  src: string
  width: number | null
}

/** The HTML blocks in a cell, in order (index starts at 1). */
function drawingsIn(html: string): Drawing[] {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
  return [...doc.querySelectorAll('div[data-html-embed]')].map((el, i) => ({
    index: i + 1,
    kind: kindOf(el.getAttribute('data-kind')),
    src: fromBase64(el.getAttribute('data-html-src') || ''),
    width: Number(el.getAttribute('data-width')) || null,
  }))
}

/** Draws one block off screen, the way the user sees it. */
async function shootDrawing(d: Drawing, cellWidth: number) {
  const html = await buildWidgetDoc(d.kind, d.src, currentTheme(document.querySelector('.cell')), { opaque: true })
  return agentApi.renderWidget({ html, width: Math.max(260, Math.round(d.width || cellWidth - 28)) })
}

/**
 * After a cell with drawings is written: draw each one and report errors, so
 * the agent fixes a broken diagram before it says it is done.
 */
async function drawingReport(cells: { id: string; html: string; w: number }[]): Promise<string[] | undefined> {
  const out: string[] = []
  for (const c of cells) {
    for (const d of drawingsIn(c.html)) {
      const shot = await shootDrawing(d, c.w).catch((e) => ({ ok: false, error: String(e?.message || e) }) as any)
      const where = `cell ${c.id} drawing ${d.index} (${FENCE_OF[d.kind]})`
      if (!shot.ok) out.push(`${where}: not checked (${shot.error || 'no renderer'})`)
      else if (shot.errors?.length) out.push(`${where}: FAILED to draw: ${shot.errors.slice(0, 3).join(' | ').slice(0, 600)}. Fix the source and update the cell.`)
      else out.push(`${where}: drawn OK, ${shot.width}x${shot.height}px. Call check_drawing to see it.`)
    }
  }
  return out.length ? out : undefined
}

const DRAWING_CHECK = `You are checking a diagram or widget that an assistant just drew into a note. The picture shows it exactly as the user sees it.
Answer in two parts:
WHAT IT SHOWS: describe it precisely: every box, node, gate, signal, bar or element with its exact label, every arrow or wire as "A -> B" with its label, and the overall layout. For charts give axes, series and values. For logic circuits give each gate type and its inputs and output.
PROBLEMS: list every visible problem: overlapping or cut off text or shapes, labels outside their boxes, unreadable contrast (dark on dark, light on light), lines crossing through labels, tangled or ambiguous wiring, odd empty space, tiny unreadable text, error messages, or anything missing compared with the intended content. If there are none, write "PROBLEMS: none".`

/**
 * Models often rewrite a whole cell from an older copy and silently drop the
 * colors, highlights and sizes added since. Put back each style whose text is
 * still there but now plain, when every occurrence of that text had it before.
 */
export function keepDroppedStyles(oldHtml: string, newHtml: string) {
  const parse = (h: string) => new DOMParser().parseFromString(`<body>${h}</body>`, 'text/html').body
  const styled = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('span[style], mark[data-color]')].filter((el) => {
    const s = el.style
    return el.tagName === 'MARK' || s.color || s.fontSize || s.backgroundColor
  })
  const keyOf = (el: HTMLElement) => `${el.tagName}|${el.getAttribute('data-color') || ''}|${el.style.color}|${el.style.fontSize}|${el.style.backgroundColor}`
  const textOf = (root: HTMLElement) => root.textContent || ''
  const count = (hay: string, t: string) => hay.split(t).length - 1
  const oldRoot = parse(oldHtml)
  const runs = new Map<string, { text: string; el: HTMLElement; styledCount: number }>()
  for (const el of styled(oldRoot)) {
    const text = (el.textContent || '').trim()
    if (!text || text.length > 200) continue
    const id = `${keyOf(el)}\n${text}`
    const run = runs.get(id)
    // Nested copies of one style around the same text count once.
    if (run) { if (!run.el.contains(el)) run.styledCount++ } else runs.set(id, { text, el, styledCount: 1 })
  }
  let html = newHtml
  const kept: string[] = []
  for (const [id, run] of runs) {
    const key = id.split('\n')[0]
    if (run.styledCount < count(textOf(oldRoot), run.text)) continue
    const newRoot = parse(html)
    if (!count(textOf(newRoot), run.text)) continue
    if (styled(newRoot).some((el) => keyOf(el) === key && (el.textContent || '').includes(run.text))) continue
    const shell = run.el.cloneNode(false) as HTMLElement
    const outer = shell.outerHTML
    const close = `</${shell.tagName.toLowerCase()}>`
    const open = outer.slice(0, outer.length - close.length)
    const word = (c: string) => /\w/.test(c)
    const pattern = `${word(run.text[0]) ? '\\b' : ''}${run.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${word(run.text.slice(-1)) ? '\\b' : ''}`
    const r = transformText(html, pattern, { all: true, regex: true, caseSensitive: true, wrap: (t) => `${open}${esc(t)}${close}` })
    if (r.count) {
      html = r.html
      kept.push(`"${run.text}"`)
    }
  }
  return { html, kept }
}

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
  fn('create_cells', 'Create one or more text cells on a page. Content is Markdown with $LaTeX$, tables, task lists, code blocks; inline HTML allowed for colors (<span style="color:#e06c75">x</span>), highlight (<mark data-color="#ffd75e">x</mark>), font size (<span style="font-size:20px">x</span>), underline (<u>), and [columns][column]..[/column][column]..[/column][/columns] for side by side columns ([columns divider] adds a thick vertical line between them). Placement default: in the area the user is looking at, never overlapping.', {
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
    content: str('New content in Markdown (see create_cells). When replacing, start from the cell as it is NOW (read_cell if it changed since you last saw it) and keep its colors, highlights and sizes as inline HTML.'),
    content_mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'How to use content. Default replace.' },
    drop_styles: { type: 'boolean', description: 'Only when the user asked to remove colors/highlights: lets a replace drop them. By default styled text whose style your content left out keeps it.' },
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
  fn('view_image', 'Look at an image with a vision model and get back text: a faithful transcription (default: text in Markdown and LaTeX, plus a detailed [Figure] block for every diagram or chart: elements, labeled arrows A -> B, structure, axes and values), a full description (task describe, best for diagrams and charts), or the answer to a question about it. Ask follow-up questions when a detail matters. Works whatever model you are, for images the user attached (source "attachment:<sha>") and images inside cells (cell_id, optionally index). Use it before transcribing, replacing or answering about any image you cannot see yourself. If you can see images, an image attached to a message is already in front of you: do not call this to look at it again; call it with region to zoom into a small or hard to read part (you get that part enlarged).', {
    source: str('"attachment:<sha>", an "asset://local/..." image, or a URL.'),
    cell_id: str('Read the images inside this cell instead.'),
    page_id: str('Page of cell_id. Omit for the open page.'),
    index: { type: 'number', description: 'Which image in the cell, from 1. Default: all (up to 4).' },
    task: { type: 'string', enum: ['transcribe', 'describe'], description: 'Default transcribe.' },
    question: str('A specific question about the image, instead of task.'),
    region: {
      type: 'object',
      description: 'Zoom: only this part of the image, enlarged. Fractions of the width and height from 0 to 1, x and y at the top left. Example {"x":0,"y":0.5,"w":0.5,"h":0.5} is the bottom left quarter.',
      properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
    },
  }),
  fn('check_drawing', 'See a drawing (mermaid, wavedrom, chart or widget block) exactly as the user sees it: it is rendered and a vision model describes what it shows and lists visible problems (overlaps, cut off or unreadable text, tangled lines, drawing errors). Use it once after making or changing a non-trivial drawing, then fix real problems.', {
    cell_id: str('Cell with the drawing.'),
    page_id: str('Page of the cell. Omit for the open page.'),
    index: { type: 'number', description: 'Which drawing in the cell, from 1. Default 1.' },
    intended: str('What the drawing should show, in a sentence or two, so missing parts are noticed.'),
  }, ['cell_id']),
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
    const drawings = await drawingReport(made)
    return ok(
      { created: made.map((c) => ({ id: c.id, title: c.title, x: c.x, y: c.y, w: c.w })), ...(drawings ? { drawings } : {}) },
      made.length === 1 ? `Added cell "${names[0]}"` : `Added ${made.length} cells`,
      { pageId: id, cellId: made[0]?.id },
    )
  },

  async update_cell(a, env) {
    const pid = await pageOfCell(a.cell_id, a.page_id)
    let title = ''
    let cid = ''
    const changes: string[] = []
    let kept: string[] = []
    let after = null as { id: string; html: string; w: number } | null
    let anchor: string | undefined
    const s = settingsNow()
    await editPage(env, pid, (p) => {
      const c = findCell(p, a.cell_id)
      cid = c.id
      const patch: Partial<Cell> = applyStyle(c, a)
      if (a.title !== undefined) { patch.title = String(a.title); changes.push('title'); anchor = anchor || String(a.title) }
      if (a.content !== undefined) {
        let html = agentToHtml(String(a.content))
        anchor = htmlToText(html)
        const mode = a.content_mode || 'replace'
        if (mode === 'replace' && !a.drop_styles) {
          const r = keepDroppedStyles(c.html || '', html)
          html = r.html
          kept = r.kept
        }
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
      if (patch.html !== undefined) after = { id: c.id, html: patch.html, w: patch.w ?? c.w }
      return { ...p, cells: p.cells.map((x) => (x.id === c.id ? { ...x, ...patch, updatedAt: now() } : x)) }
    }, [String(a.cell_id)])
    const note = kept.length
      ? `Your content dropped the color/highlight/size on ${kept.join(', ')}; it was kept. To really remove it, call again with drop_styles: true.`
      : undefined
    const drawings = after ? await drawingReport([after]) : undefined
    return ok({ updated: cid, changed: changes, ...(note ? { note } : {}), ...(drawings ? { drawings } : {}) }, `Updated "${title || 'cell'}"${changes.length ? ` (${changes.join(', ')})` : ''}`, { pageId: pid, cellId: cid, anchor })
  },

  async edit_cell_text(a, env) {
    const pid = await pageOfCell(a.cell_id, a.page_id)
    const edits: Args[] = Array.isArray(a.edits) ? a.edits : []
    const report: string[] = []
    let title = ''
    let cid = ''
    let anchor: string | undefined
    await editPage(env, pid, (p) => {
      const c = findCell(p, a.cell_id)
      cid = c.id
      title = c.title
      let html = c.html
      for (const e of edits) {
        if (e.replace !== undefined && String(e.replace).trim()) anchor = anchor || String(e.replace)
        else if (e.find !== undefined) anchor = anchor || String(e.find)
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
    return { ...ok(report.join('\n'), `Edited text in "${title || 'cell'}"`, { pageId: pid, cellId: cid, anchor }), ok: failed < edits.length }
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
    return ok(`Styled ${total} occurrence(s) in ${touched.length} cell(s).`, a.whole_cell || !a.find ? `Styled ${touched.length === 1 ? "the cell" : `${touched.length} cells`}` : `Styled "${a.find}" (${total}x)`, { pageId: pid, cellId: touched[0], anchor: a.find ? String(a.find) : undefined })
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

  async view_image(a, env) {
    const refs: string[] = []
    const source = String(a.source || '')
    if (source.startsWith('attachment:')) refs.push(`sha:${attachmentSha(source.slice('attachment:'.length), env)}`)
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
    const region = a.region && typeof a.region === 'object' ? a.region : null
    if (region) for (let i = 0; i < refs.length; i++) refs[i] = await cropImage(refs[i], region)
    const zoomed = region ? ` (zoomed: x ${pct(region.x)}, y ${pct(region.y)}, ${pct(region.w)} wide, ${pct(region.h)} high)` : ''
    const task = a.question
      ? `Answer from the image(s) only: ${a.question}\nBe specific (exact labels, values, positions, arrow directions). If the image does not show the answer, say so.\n\n${FIGURE_RULES}`
      : a.task === 'describe'
        ? `Describe the image(s) completely and precisely, for someone who cannot see it and must rebuild it from your words.\nStart with one line: what kind of image it is and what it is about. Then give every visible text exactly, and describe every figure as below.\n\n${FIGURE_RULES}`
        : `Transcribe everything in the image(s) exactly as written, in reading order, as Markdown: headings, bullet and numbered lists, tables as Markdown tables, every formula as LaTeX ($...$ inline, $$...$$ for display). Keep the original wording, symbols and order. Do not add, explain, summarize or correct text.\nWhere the image has a diagram, chart, drawing or other figure, do not skip it: at that point in the reading order write a block starting with "[Figure]" that describes it as below.\nOutput only the transcription.\n\n${FIGURE_RULES}`
    const what = a.question ? 'Looked at the image' : a.task === 'describe' ? 'Described the image' : 'Read the image'
    // A model that can see gets the picture itself, in this same conversation.
    if (modelInfo(env.model).vision) {
      const images = await toRefs(refs)
      const many = images.length > 1
      const job = a.question ? `Answer from ${many ? 'them' : 'it'}: ${a.question}` : a.task === 'describe' ? `Describe ${many ? 'them' : 'it'} as needed.` : `Read ${many ? 'them' : 'it'} as needed.`
      return {
        ...ok(`${many ? `${images.length} images are` : 'The image is'} attached right after this result as real image input${zoomed}. Look at ${many ? 'them' : 'it'} yourself. ${job}`, `${region ? 'Zoomed into the image' : what}${many ? ` (${images.length})` : ''}`),
        images,
      }
    }
    const model = eyesFor(env.model)
    const started = Date.now()
    const res = await agentApi.complete({
      model,
      // No thinking: it is much faster, and the figure rules above keep the reading careful.
      think: false,
      // A hard stop and a repeat penalty, so a stuck model cannot loop for minutes.
      options: { temperature: 0.1, num_predict: 3500, repeat_penalty: 1.1 },
      timeout_ms: 150_000,
      messages: [{ role: 'user', content: task, images: refs }],
    })
    if (!res.ok || !res.content?.trim()) throw new ToolError(`Could not read the image (${res.error || 'empty answer'}).`)
    return {
      ...ok(`${model === env.model ? 'What you see in it (your own vision)' : `From ${model}, which looked at the image for you`}:\n${res.content.trim()}`, `${what}${refs.length > 1 ? ` (${refs.length})` : ''}`),
      helper: { model: modelInfo(model).name, ms: Date.now() - started, text: res.content.trim() },
    }
  },

  async check_drawing(a, env) {
    const pid = await pageOfCell(a.cell_id, a.page_id)
    const c = findCell(await loadPage(pid), a.cell_id)
    const all = drawingsIn(c.html)
    if (!all.length) throw new ToolError(`Cell [${c.id}] has no drawing (no mermaid, wavedrom, chart or widget block).`)
    const d = all[(Number(a.index) || 1) - 1]
    if (!d) throw new ToolError(`Cell [${c.id}] has ${all.length} drawing(s); index starts at 1.`)
    const shot = await shootDrawing(d, c.w)
    if (!shot.ok || !shot.png) throw new ToolError(`Could not draw it (${shot.error || 'no picture'}).`)
    const errors = shot.errors?.length ? `\nERRORS while drawing: ${shot.errors.join(' | ')}` : ''
    const intent = a.intended ? `\nIntended content: ${String(a.intended).slice(0, 1500)}` : ''
    // A model that can see looks at the rendered picture itself.
    if (modelInfo(env.model).vision) {
      return {
        ...ok(
          `Drawing ${d.index} (${FENCE_OF[d.kind]}) in cell [${c.id}] is rendered (${shot.width}x${shot.height}px) and attached right after this result, exactly as the user sees it. Look at it yourself: check that it shows what you meant${intent ? ' (below)' : ''}, and look for overlapping or cut off text, labels outside their boxes, unreadable contrast, lines through labels, tangled wiring, tiny text or error messages.${errors}${intent}\nFix real problems by updating the source (at most two rounds); ignore nitpicks.`,
          `Checked the drawing`,
          { pageId: pid, cellId: c.id },
        ),
        images: await toRefs([shot.png]),
      }
    }
    const model = eyesFor(env.model)
    const started = Date.now()
    const res = await agentApi.complete({
      model,
      think: false,
      options: { temperature: 0.1, num_predict: 1800, repeat_penalty: 1.1 },
      timeout_ms: 120_000,
      messages: [{ role: 'user', content: `${DRAWING_CHECK}${intent}`, images: [shot.png] }],
    })
    if (!res.ok || !res.content?.trim()) throw new ToolError(`Could not look at it (${res.error || 'empty answer'}).${errors}`)
    return {
      ...ok(
        `Drawing ${d.index} (${FENCE_OF[d.kind]}) in cell [${c.id}], ${shot.width}x${shot.height}px, as seen by ${model}:${errors}\n${res.content.trim()}\nFix real problems by updating the source (at most two rounds); ignore nitpicks.`,
        `Checked the drawing`,
        { pageId: pid, cellId: c.id },
      ),
      helper: { model: modelInfo(model).name, ms: Date.now() - started, text: res.content.trim() },
    }
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

/**
 * How the vision model must describe figures, so a model that cannot see the
 * image gets everything it would need to redraw it.
 */
const FIGURE_RULES = `How to describe a figure:
- Kind: flowchart, architecture or block diagram, graph or tree, sequence or timeline, mind map, table drawn by hand, plot or chart, geometry sketch, circuit, or other. One line on what it shows.
- Elements: list every box, node, shape, icon and region with its exact label (word for word), shape, color if meaningful, and where it sits (top left, center, second row...). Give each one a short name you reuse below.
- Connections: list every arrow and line as "A -> B" (or "A <-> B", "A - B" when undirected), with the label written on it, and its style when it carries meaning (dashed, thick, colored). Read arrow heads carefully; if a direction is unclear, say so instead of guessing.
- Structure: grouping and containment (what is inside which box or region), layers or stages, loops and feedback paths, and the order of the flow from start to end.
- Charts and plots: chart type, title, each axis (label, units, range, scale, tick values), legend entries, and every series with its values as read from the chart (mark estimates with ~). Then the visible trends, peaks, crossings and outliers. Give the data as a Markdown table when there are discrete values.
- Math in a figure (labels, equations, annotations) as LaTeX.
- Handwritten marks, highlights, circles or ticks that point at something: say what they point at.
- Only what is visible: no outside knowledge, no interpretation presented as content. Mark unreadable text as [unclear] and anything you are unsure of as (uncertain).`

/** An image src from the notes (data:, asset://, or a web URL) as plain base64 for the model. */
/** A chat attachment id; models sometimes garble the long hash, so one that starts and ends the same is taken. */
function attachmentSha(id: string, env: ToolEnv) {
  if (env.attachments.has(id)) return id
  const near = [...env.attachments.keys()].filter((k) => k.slice(0, 12) === id.slice(0, 12) && k.slice(-12) === id.slice(-12))
  return near.length === 1 ? near[0] : id
}

const pct = (v: unknown) => `${Math.round((Number(v) || 0) * 100)}%`

/** Bytes of an image reference ("sha:<hash>" or base64). */
async function refBytes(ref: string) {
  if (!ref.startsWith('sha:')) return ref
  const b64 = await chatApi.getBlob(ref.slice(4))
  if (!b64) throw new ToolError('That image is not on this computer.')
  return b64
}

/** One part of an image (fractions of its size), enlarged so small writing becomes readable. */
async function cropImage(ref: string, r: { x?: number; y?: number; w?: number; h?: number }) {
  const b64 = await refBytes(ref)
  const img = new Image()
  img.src = `data:image/${b64.startsWith('/9j/') ? 'jpeg' : 'png'};base64,${b64}`
  try {
    await img.decode()
  } catch {
    throw new ToolError('Could not open the image to zoom in.')
  }
  const W = img.naturalWidth
  const H = img.naturalHeight
  const f = (v: unknown, d: number) => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : d))
  const x = f(r.x, 0)
  const y = f(r.y, 0)
  const sw = Math.max(8, Math.round(f(r.w, 1 - x) * W))
  const sh = Math.max(8, Math.round(f(r.h, 1 - y) * H))
  const sx = Math.min(W - sw, Math.round(x * W))
  const sy = Math.min(H - sh, Math.round(y * H))
  // Up to 3x, at most 1600 px on the long side.
  const k = Math.min(3, 1600 / Math.max(sw, sh))
  const c = document.createElement('canvas')
  c.width = Math.round(sw * k)
  c.height = Math.round(sh * k)
  const g = c.getContext('2d')!
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, Math.max(0, sx), Math.max(0, sy), sw, sh, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.92).split(',')[1]
}

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

/** Whitespace-collapsed, lowercased text of an element with each character mapped back to its text node. */
function indexText(root: HTMLElement) {
  const nodes: Text[] = []
  const map: { n: number; o: number }[] = []
  let text = ''
  let lastSpace = true
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement as HTMLElement | null)?.closest('.katex-mathml, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const ni = nodes.push(node) - 1
    const v = node.nodeValue || ''
    for (let o = 0; o < v.length; o++) {
      const ch = v[o]
      if (/\s/.test(ch)) {
        if (lastSpace) continue
        text += ' '
        lastSpace = true
      } else {
        text += ch.toLowerCase()
        lastSpace = false
      }
      map.push({ n: ni, o })
    }
  }
  return { nodes, map, text }
}

/** The exact text the agent wrote, as a DOM range (it may span several formatted runs). */
function findAnchorRange(root: HTMLElement, anchor: string): Range | null {
  const needleFull = anchor.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!needleFull) return null
  const { nodes, map, text } = indexText(root)
  for (const len of [400, 200, 100, 50, 25, 12]) {
    const needle = needleFull.slice(0, len).trim()
    if (!needle) continue
    const at = text.indexOf(needle)
    if (at < 0) continue
    const first = map[at]
    const last = map[at + needle.length - 1]
    if (!first || !last) continue
    const range = document.createRange()
    range.setStart(nodes[first.n], first.o)
    range.setEnd(nodes[last.n], last.o + 1)
    return range
  }
  return null
}

/** Merges a range's client rects into one box per text line. */
function lineBoxes(range: Range) {
  const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
  rects.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: { left: number; top: number; right: number; bottom: number }[] = []
  for (const r of rects) {
    const prev = lines[lines.length - 1]
    const overlap = prev ? Math.min(prev.bottom, r.bottom) - Math.max(prev.top, r.top) : 0
    if (prev && overlap > Math.min(prev.bottom - prev.top, r.height) * 0.5) {
      prev.left = Math.min(prev.left, r.left)
      prev.right = Math.max(prev.right, r.right)
      prev.top = Math.min(prev.top, r.top)
      prev.bottom = Math.max(prev.bottom, r.bottom)
    } else {
      lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
  }
  return lines
}

let revealToken = 0

/**
 * Scrolls the canvas so exactly what the agent wrote or changed sits at the
 * center of the view (smoothly, tracking layout shifts), then marks it with a
 * short highlight that lives inside the page so it never drifts while moving.
 */
export function scrollToCell(cellId: string, anchor?: string) {
  const token = ++revealToken
  const wrap = document.querySelector('.canvas-wrap') as HTMLElement | null
  if (!wrap) return
  const stale = () => token !== revealToken

  // Where the change is right now: the matched text, or else the whole cell.
  const locate = () => {
    const el = wrap.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null
    if (!el) return null
    const range = anchor && anchor.trim() ? findAnchorRange(el, anchor) : null
    const lines = range ? lineBoxes(range) : []
    if (lines.length) {
      const box = lines.reduce((m, l) => ({ left: Math.min(m.left, l.left), top: Math.min(m.top, l.top), right: Math.max(m.right, l.right), bottom: Math.max(m.bottom, l.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity })
      return { lines, box, text: true }
    }
    const r = el.getBoundingClientRect()
    return { lines: [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom }], box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, text: false }
  }

  // Scroll offset that puts the change in the middle (or its start, if taller than the view).
  const goal = (box: { left: number; top: number; right: number; bottom: number }) => {
    const w = wrap.getBoundingClientRect()
    const h = box.bottom - box.top
    const wd = box.right - box.left
    const pad = 72
    const dy = h > wrap.clientHeight - pad * 2 ? box.top - w.top - pad : box.top - w.top - (wrap.clientHeight - h) / 2
    const dx = wd > wrap.clientWidth - pad * 2 ? box.left - w.left - pad : box.left - w.left - (wrap.clientWidth - wd) / 2
    return {
      top: Math.min(Math.max(0, wrap.scrollTop + dy), Math.max(0, wrap.scrollHeight - wrap.clientHeight)),
      left: Math.min(Math.max(0, wrap.scrollLeft + dx), Math.max(0, wrap.scrollWidth - wrap.clientWidth)),
    }
  }

  const mark = () => {
    const found = locate()
    const host = wrap.firstElementChild as HTMLElement | null
    if (!found || !host || stale()) return
    const hr = host.getBoundingClientRect()
    const layer = document.createElement('div')
    layer.className = 'agent-reveal'
    const lines = found.text ? found.lines.slice(0, 40) : found.lines
    lines.forEach((l, i) => {
      const bit = document.createElement('div')
      bit.className = found.text ? 'agent-reveal-line' : 'agent-reveal-cell'
      const padX = found.text ? 4 : 6
      const padY = found.text ? 2 : 6
      bit.style.left = `${l.left - hr.left - padX}px`
      bit.style.top = `${l.top - hr.top - padY}px`
      bit.style.width = `${l.right - l.left + padX * 2}px`
      bit.style.height = `${l.bottom - l.top + padY * 2}px`
      bit.style.animationDelay = `${Math.min(i, 12) * 45}ms`
      layer.appendChild(bit)
    })
    host.appendChild(layer)
    setTimeout(() => layer.remove(), 2200)
  }

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const frame = (fn: FrameRequestCallback) => requestAnimationFrame(fn)

  const start = () => {
    if (stale()) return
    document.querySelectorAll('.agent-reveal').forEach((n) => n.remove())
    const first = locate()
    if (!first) return
    let found = first
    const from = { top: wrap.scrollTop, left: wrap.scrollLeft }
    const far = Math.hypot(goal(found.box).top - from.top, goal(found.box).left - from.left)
    const duration = reduced ? 0 : Math.min(750, 280 + far * 0.35)
    const t0 = performance.now()
    let stop = false
    const cancel = () => { stop = true }
    // The user taking over the scroll ends the animation.
    wrap.addEventListener('wheel', cancel, { once: true, passive: true })
    wrap.addEventListener('pointerdown', cancel, { once: true })
    const done = () => {
      wrap.removeEventListener('wheel', cancel)
      wrap.removeEventListener('pointerdown', cancel)
    }
    const tick = (now: number) => {
      if (stale() || stop) return done()
      found = locate() || found
      const to = goal(found.box)
      const k = duration ? Math.min(1, (now - t0) / duration) : 1
      const e = 1 - Math.pow(1 - k, 3)
      wrap.scrollTo({ top: from.top + (to.top - from.top) * e, left: from.left + (to.left - from.left) * e, behavior: 'instant' as ScrollBehavior })
      if (k < 1) return void frame(tick)
      done()
      // Let the layout settle one more frame, then mark the spot.
      frame(() => frame(() => {
        if (stale()) return
        const to2 = goal((locate() || found).box)
        wrap.scrollTo({ top: to2.top, left: to2.left, behavior: 'instant' as ScrollBehavior })
        frame(mark)
      }))
    }
    frame(tick)
  }

  // Wait for the edited cell to render before measuring.
  frame(() => frame(() => frame(start)))
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
export const READ_ONLY = new Set(['view_image', 'check_drawing', 'web_search', 'web_fetch', 'get_context', 'list_tree', 'read_page', 'read_cell', 'search_notes', 'recent_notes', 'get_settings', 'ask_user', 'focus'])
