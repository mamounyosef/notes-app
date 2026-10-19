/**
 * A fresh picture of what the user is looking at, built right before every
 * message: where they are in the notebooks, which cells are on screen (and
 * which lines of a tall cell), what is selected, where the caret is, plus the
 * full text of the open page.
 */
import { useStore, pathTo, walk, findNode } from '../store'
import { useActiveEditor } from '../editor/activeEditor'
import { htmlToAgent, htmlToText } from './content'
import type { Cell, TreeNode } from '../types'

/** Last place the mouse was over the page, in page coordinates. */
let lastPointer: { x: number; y: number; cellId: string | null; at: number } | null = null

export function trackPointer() {
  const onMove = (e: MouseEvent) => {
    const wrap = document.querySelector('.canvas-wrap') as HTMLElement | null
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
    const zoom = useStore.getState().zoom || 1
    const cellEl = (e.target as HTMLElement)?.closest?.('[data-cell-id]') as HTMLElement | null
    lastPointer = {
      x: Math.round((wrap.scrollLeft + e.clientX - r.left) / zoom),
      y: Math.round((wrap.scrollTop + e.clientY - r.top) / zoom),
      cellId: cellEl?.dataset.cellId || null,
      at: Date.now(),
    }
  }
  window.addEventListener('mousemove', onMove, { passive: true })
  return () => window.removeEventListener('mousemove', onMove)
}

export interface ViewInfo {
  /** Visible part of the page in page coordinates. */
  rect: { x: number; y: number; w: number; h: number }
  cells: Map<string, { state: 'full' | 'partial' | 'off'; where?: string; visibleText?: string; shownPct?: number }>
}

/** Which cells, and which lines of them, are on screen right now. */
export function readView(): ViewInfo | null {
  const st = useStore.getState()
  const wrap = document.querySelector('.canvas-wrap') as HTMLElement | null
  if (!wrap || !st.page) return null
  const zoom = st.zoom || 1
  const wr = wrap.getBoundingClientRect()
  const rect = {
    x: Math.round(wrap.scrollLeft / zoom),
    y: Math.round(wrap.scrollTop / zoom),
    w: Math.round(wrap.clientWidth / zoom),
    h: Math.round(wrap.clientHeight / zoom),
  }
  const cells: ViewInfo['cells'] = new Map()
  for (const c of st.page.cells) {
    const el = wrap.querySelector(`[data-cell-id="${CSS.escape(c.id)}"]`) as HTMLElement | null
    const box = el?.getBoundingClientRect()
    if (!el || !box) {
      cells.set(c.id, { state: 'off' })
      continue
    }
    const top = Math.max(box.top, wr.top)
    const bottom = Math.min(box.bottom, wr.bottom)
    const left = Math.max(box.left, wr.left)
    const right = Math.min(box.right, wr.right)
    if (bottom <= top || right <= left) {
      const where =
        box.bottom <= wr.top ? 'above the view' : box.top >= wr.bottom ? 'below the view' : box.right <= wr.left ? 'left of the view' : 'right of the view'
      cells.set(c.id, { state: 'off', where })
      continue
    }
    const shown = ((bottom - top) * (right - left)) / Math.max(1, box.height * box.width)
    if (shown > 0.97) {
      cells.set(c.id, { state: 'full' })
      continue
    }
    // Partly on screen: collect the lines that are visible.
    const blocks = el.querySelectorAll('.ProseMirror > *, .ProseMirror li, .ProseMirror tr')
    const seen: string[] = []
    blocks.forEach((b) => {
      const r = (b as HTMLElement).getBoundingClientRect()
      if (r.bottom > wr.top + 2 && r.top < wr.bottom - 2 && r.height > 0) {
        // Skip containers whose children are listed on their own.
        if ((b as HTMLElement).querySelector('li, tr')) return
        const t = ((b as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim()
        if (t) seen.push(t)
      }
    })
    let where = ''
    if (box.top < wr.top) where += 'top is scrolled off; '
    if (box.bottom > wr.bottom) where += 'bottom continues below the view; '
    if (box.left < wr.left || box.right > wr.right) where += 'cut off at the side; '
    cells.set(c.id, {
      state: 'partial',
      where: where.trim().replace(/;$/, ''),
      visibleText: seen.join('\n').slice(0, 2500),
      shownPct: Math.round(shown * 100),
    })
  }
  return { rect, cells }
}

const fmtTime = (t: number) => (t ? new Date(t).toLocaleString() : '')

function outline(nodes: TreeNode[], activeId: string | null, depth = 0, out: string[] = [], budget = { n: 600 }) {
  for (const n of nodes) {
    if (budget.n-- <= 0) {
      out.push(`${'  '.repeat(depth)}... (more, use list_tree)`)
      return out
    }
    const flags = [n.archived ? 'archived' : '', n.color ? `color ${n.color}` : '', n.id === activeId ? 'OPEN NOW' : '']
      .filter(Boolean)
      .join(', ')
    out.push(`${'  '.repeat(depth)}- ${n.kind} "${n.title}" [${n.id}]${flags ? ` (${flags})` : ''}`)
    if (n.children?.length) outline(n.children, activeId, depth + 1, out, budget)
  }
  return out
}

function cellLine(c: Cell) {
  const flags = [
    c.bg ? `bg ${c.bg}` : '',
    c.border ? `border ${c.border}` : '',
    c.locked ? 'locked' : '',
    c.collapsed ? 'collapsed' : '',
    c.showTitle === false ? 'title hidden' : '',
    c.kind === 'ink' ? 'ink drawing' : '',
    c.strokes?.length ? `${c.strokes.length} ink strokes` : '',
    c.conflict ? 'SYNC CONFLICT COPY' : '',
  ]
    .filter(Boolean)
    .join(', ')
  return `x=${Math.round(c.x)} y=${Math.round(c.y)} w=${Math.round(c.w)} h=${Math.round(c.h)} z=${c.z}${flags ? `, ${flags}` : ''}`
}

/** The editor caret and selected text, if the user is typing in a cell. */
function caretInfo(ignoreSelection = false): string[] {
  const out: string[] = []
  const st = useStore.getState()
  const ed = useActiveEditor.getState().editor as any
  if (st.editingCellId && ed && !ed.isDestroyed) {
    try {
      const { from, to, $from } = ed.state.selection
      const parentText: string = $from.parent.textContent || ''
      const off = $from.parentOffset
      out.push(`The user is typing in cell [${st.editingCellId}].`)
      if (to > from && !ignoreSelection) {
        const sel = ed.state.doc.textBetween(from, to, '\n')
        out.push(`Selected text in that cell: """${sel.slice(0, 4000)}"""`)
      } else if (to === from) {
        out.push(`Caret is in the line: """${parentText.slice(Math.max(0, off - 300), off)}|CARET|${parentText.slice(off, off + 300)}"""`)
      }
    } catch {
      /* editor busy */
    }
  }
  const ws = ignoreSelection ? '' : window.getSelection()?.toString().trim()
  if (ws && !out.some((l) => l.includes('Selected text'))) out.push(`Text selected on screen: """${ws.slice(0, 4000)}"""`)
  return out
}

export interface BuiltContext {
  full: string
  brief: string
}

/** Everything the agent should know about the app right now. */
export function buildContext(opts: { mentions?: { id: string; kind: string }[]; mentionPages?: Record<string, any>; ignoreSelection?: boolean } = {}): BuiltContext {
  const st = useStore.getState()
  const { workspace, page, settings } = st
  const lines: string[] = []
  const brief: string[] = []
  const nowStr = new Date().toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  lines.push(`Local time: ${nowStr}`)

  if (page) {
    const path = pathTo(workspace.tree, page.id)
    const where = path.map((n) => `${n.kind} "${n.title}" [${n.id}]`).join(' > ')
    lines.push(`OPEN PAGE: "${page.title}" [${page.id}]`)
    lines.push(`Location: ${where || 'page not found in the tree'}`)
    brief.push(`Open page: "${page.title}" [${page.id}] in ${path.slice(0, -1).map((n) => n.title).join(' > ')}`)
    lines.push(`Page created ${fmtTime(page.createdAt)}, last changed ${fmtTime(page.updatedAt)}. ${page.cells.length} cells, ${page.strokes?.length || 0} page ink strokes.`)
    lines.push(`Zoom ${Math.round(st.zoom * 100)}%. Tool: ${st.tool}. Grid ${settings.gridSize}px, snap ${settings.snapToGrid ? 'on' : 'off'}. Default new cell size ${settings.defaultCellWidth}x${settings.defaultCellHeight}.`)

    const view = readView()
    if (view) {
      const r = view.rect
      lines.push(`SCREEN: the user sees the page area x ${r.x} to ${r.x + r.w}, y ${r.y} to ${r.y + r.h} (page coordinates, y grows downward; the page title sits above y=100).`)
    }
    if (lastPointer && Date.now() - lastPointer.at < 120_000) {
      lines.push(`Mouse last over the page at x=${lastPointer.x} y=${lastPointer.y}${lastPointer.cellId ? `, over cell [${lastPointer.cellId}]` : ', over empty space'}.`)
    }
    if (st.selection.length && !opts.ignoreSelection) lines.push(`Selected cells: ${st.selection.map((id) => `[${id}]`).join(', ')}`)
    lines.push(...caretInfo(opts.ignoreSelection))

    const order = [...page.cells].sort((a, b) => a.y - b.y || a.x - b.x)
    const visible: string[] = []
    const all: string[] = []
    for (const c of order) {
      const v = view?.cells.get(c.id)
      const md = c.kind === 'ink' ? '(ink drawing)' : htmlToAgent(c.html)
      const state = v?.state === 'full' ? 'ON SCREEN' : v?.state === 'partial' ? `PARTLY ON SCREEN (${v.shownPct}% shown; ${v.where})` : `off screen${v?.where ? `, ${v.where}` : ''}`
      const head = `### Cell [${c.id}] "${c.title || ''}" - ${state}\n${cellLine(c)}`
      const long = md.length > 12000
      const body = long ? `${md.slice(0, 12000)}\n...(cut, ${md.length} chars; use read_cell for all of it)` : md
      all.push(`${head}\n${body || '(empty)'}`)
      if (v?.state === 'full') visible.push(`[${c.id}] "${c.title || htmlToText(c.html).slice(0, 50)}"`)
      if (v?.state === 'partial') {
        visible.push(`[${c.id}] "${c.title || ''}" (partly)`)
        if (v.visibleText) all.push(`Lines of [${c.id}] visible on screen now:\n"""${v.visibleText}"""`)
      }
    }
    lines.push(`Cells on screen: ${visible.length ? visible.join(', ') : 'none (empty area of the page)'}`)
    brief.push(`On screen: ${visible.join(', ') || 'nothing'}`)
    lines.push('')
    lines.push('PAGE CONTENT (top to bottom, all cells):')
    lines.push(all.join('\n\n') || '(the page is empty)')
  } else {
    lines.push('No page is open.')
    brief.push('No page open')
  }

  if (opts.mentions?.length) {
    lines.push('')
    lines.push('THE USER POINTED AT THESE WITH @:')
    for (const m of opts.mentions) {
      const node = findNode(workspace.tree, m.id)
      if (!node) continue
      const p = opts.mentionPages?.[m.id]
      if (node.kind === 'page' && p) {
        const cells = [...(p.cells || [])].sort((a: Cell, b: Cell) => a.y - b.y || a.x - b.x)
        lines.push(`## Page "${node.title}" [${node.id}] (${cells.length} cells)`)
        for (const c of cells) lines.push(`### Cell [${c.id}] "${c.title || ''}" ${cellLine(c)}\n${htmlToAgent(c.html).slice(0, 8000) || '(empty)'}`)
      } else {
        lines.push(`## ${node.kind} "${node.title}" [${node.id}]:`)
        lines.push(outline(node.children || [], st.activePageId).join('\n'))
      }
    }
  }

  lines.push('')
  lines.push('NOTEBOOK TREE (notebook > section > page; ids in brackets):')
  lines.push(outline(workspace.tree, st.activePageId).join('\n') || '(empty)')
  const recent = (workspace.recent || []).slice(0, 8).map((id) => findNode(workspace.tree, id)).filter(Boolean) as TreeNode[]
  if (recent.length) lines.push(`Recently opened pages: ${recent.map((n) => `"${n.title}" [${n.id}]`).join(', ')}`)
  const favs = (workspace.favorites || []).map((id) => findNode(workspace.tree, id)).filter(Boolean) as TreeNode[]
  if (favs.length) lines.push(`Favorites: ${favs.map((n) => `"${n.title}" [${n.id}]`).join(', ')}`)
  let pages = 0
  walk(workspace.tree, (n) => {
    if (n.kind === 'page') pages++
  })
  lines.push(`Total pages: ${pages}.`)
  lines.push(`Look: theme ${settings.theme}, accent ${settings.accent}, body font ${settings.bodyFont} ${settings.bodySize}px, text color ${settings.bodyColor}, title color ${settings.titleColor}, cell background ${settings.cellBg || 'default'}.`)

  return { full: lines.join('\n'), brief: brief.join('. ') }
}
