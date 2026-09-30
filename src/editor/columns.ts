/**
 * Side by side columns inside a cell.
 *
 *  - Double-click empty space to the right of a block: that block becomes the
 *    left column and a new text column opens exactly where you clicked.
 *  - Alt+A (vertical line): same split, but with a thick divider between the
 *    columns. Inside existing columns it toggles the divider.
 *  - Drag the gap between columns to resize, double-click it to reset widths.
 *  - Backspace in an empty column removes it; a single column unwraps itself.
 */
import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import { ReplaceAroundStep } from '@tiptap/pm/transform'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { GapCursor } from '@tiptap/pm/gapcursor'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { useStore } from '../store'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      /** Split the current block(s) into columns, or toggle the divider when already inside columns. */
      setThickVerticalRule: () => ReturnType
      /** Add an empty text column to the right of the current block or column. */
      addColumnRight: () => ReturnType
      toggleColumnDivider: () => ReturnType
      removeColumns: () => ReturnType
      exitColumns: () => ReturnType
    }
  }
}

/** Space between columns in CSS px. Keep in sync with --col-gap in index.css. */
export const COL_GAP = 28
const MIN_COL = 48
/** How far past the end of a block's content a double-click must land to open a side column. */
const SIDE_SLACK = COL_GAP + 6
const SIDE_TYPES = new Set(['paragraph', 'heading', 'image', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'blockMath', 'table'])

// ------------------------------------------------------------------ nodes

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  addAttributes() {
    return {
      divider: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-divider') === 'true',
        renderHTML: (a) => (a.divider ? { 'data-divider': 'true' } : {}),
      },
      // Insets of the vertical line from the row's top/bottom in px; negative extends past the row.
      lineTop: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute('data-line-top')) || 0,
        renderHTML: (a) => (a.lineTop ? { 'data-line-top': String(a.lineTop) } : {}),
      },
      lineBottom: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute('data-line-bottom')) || 0,
        renderHTML: (a) => (a.lineBottom ? { 'data-line-bottom': String(a.lineBottom) } : {}),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="columns"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'columns' }), 0],
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'columns'
      dom.dataset.type = 'columns'
      const apply = (n: PMNode) => {
        dom.classList.toggle('has-divider', !!n.attrs.divider)
        dom.style.setProperty('--line-top', `${n.attrs.lineTop || 0}px`)
        dom.style.setProperty('--line-bottom', `${n.attrs.lineBottom || 0}px`)
        dom.dataset.lineTop = String(n.attrs.lineTop || 0)
        dom.dataset.lineBottom = String(n.attrs.lineBottom || 0)
      }
      apply(node)
      return {
        dom,
        contentDOM: dom,
        update: (n) => {
          if (n.type.name !== 'columns') return false
          apply(n)
          return true
        },
        // Live resize writes styles directly; never let that re-read the doc.
        ignoreMutation: (m) => m.type === 'attributes',
      }
    }
  },
})

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el) => {
          const v = parseFloat(el.getAttribute('data-width') || '')
          return Number.isFinite(v) && v > 0 ? v : null
        },
        renderHTML: (a) => (a.width ? { 'data-width': String(a.width), style: `flex: 0 0 ${a.width}px` } : {}),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-type="column"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'column' }), 0],
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'column'
      dom.dataset.type = 'column'
      const apply = (n: PMNode) => {
        dom.style.flex = n.attrs.width ? `0 0 ${n.attrs.width}px` : ''
      }
      apply(node)
      return {
        dom,
        contentDOM: dom,
        update: (n) => {
          if (n.type.name !== 'column') return false
          apply(n)
          return true
        },
        ignoreMutation: (m) => m.type === 'attributes',
      }
    }
  },
})

// ------------------------------------------------------------------ helpers

function findDepth($pos: ResolvedPos, name: string) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === name) return d
  return -1
}

/** Ratio between on-screen px and CSS px (the canvas is CSS-scaled when zoomed). */
function scaleOf(view: EditorView) {
  const el = view.dom as HTMLElement
  const r = el.getBoundingClientRect()
  return el.offsetWidth ? r.width / el.offsetWidth || 1 : 1
}

/** Rightmost on-screen x of actual content (text, images, math) inside a block. */
function contentRight(dom: HTMLElement): number | null {
  let right = -Infinity
  dom.querySelectorAll('table').forEach((t) => (right = Math.max(right, t.getBoundingClientRect().right)))
  if (dom.tagName === 'TABLE') right = Math.max(right, dom.getBoundingClientRect().right)
  const range = document.createRange()
  const walk = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        const el = n as HTMLElement
        if (el.classList.contains('katex-mathml')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
      return /\S/.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === 3) {
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) if (r.width > 0) right = Math.max(right, r.right)
    } else {
      const el = n as HTMLElement
      if (el.tagName === 'IMG' || el.tagName === 'svg' || el.classList.contains('thick-hr')) {
        right = Math.max(right, el.getBoundingClientRect().right)
      } else if (el.tagName === 'LI') {
        // Bullets and checkboxes count as content too.
        right = Math.max(right, el.getBoundingClientRect().left)
      }
    }
  }
  return right === -Infinity ? null : right
}

function widestImage(dom: HTMLElement, scale: number) {
  let w = 0
  dom.querySelectorAll('img').forEach((img) => (w = Math.max(w, img.getBoundingClientRect().width / scale)))
  return w
}

type SideTarget =
  | { kind: 'wrap'; from: number; to: number; leftWidth: number; top: number; bottom: number; x: number }
  | { kind: 'append'; columnsPos: number; colIndex: number; leftWidth: number; top: number; bottom: number; x: number }

/** Child of `container` (content starting at `start`) whose box spans screen y. */
function blockAt(view: EditorView, container: PMNode, start: number, y: number) {
  let offset = 0
  for (let i = 0; i < container.childCount; i++) {
    const child = container.child(i)
    const pos = start + offset
    offset += child.nodeSize
    const dom = view.nodeDOM(pos) as HTMLElement | null
    if (!dom || dom.nodeType !== 1) continue
    const r = dom.getBoundingClientRect()
    if (y >= r.top && y <= r.bottom) return { child, pos, dom, r }
  }
  return null
}

/**
 * Works out whether a point sits in empty space to the right of a block.
 * The point may also be in the cell's padding just right of the editor, which
 * is the only free space beside full-width blocks such as tables.
 */
function findSideTarget(view: EditorView, x: number, y: number, target: EventTarget | null): SideTarget | null {
  const root = view.dom as HTMLElement
  const el = target instanceof Element ? target : null
  if (!el) return null
  const inside = root.contains(el)
  const rr = root.getBoundingClientRect()
  if (inside) {
    // Never hijack clicks on controls, images, math, table cells or code.
    if (el.closest('img, [data-drag-handle], .katex, .math-inline, td, th, pre, a, input, label, button')) return null
  } else {
    const cell = root.closest('.cell')
    if (!cell || el.closest('.cell') !== cell) return null
    // The right resize handle overlaps most of that padding, so it counts as free space.
    if (el.closest('.cell-title, .cell-grip, .cell-handle:not(.e), .col-gutter, .ProseMirror')) return null
    if (x < rr.right - 1 || y < rr.top || y > rr.bottom) return null
  }
  const scale = scaleOf(view)
  const doc = view.state.doc

  let container: PMNode = doc
  let start = 0
  let columnsPos = -1
  let colIndex = -1
  const enterLastColumn = (pos: number, columns: PMNode) => {
    columnsPos = pos
    colIndex = columns.childCount - 1
    let p = pos + 1
    for (let i = 0; i < colIndex; i++) p += columns.child(i).nodeSize
    container = columns.child(colIndex)
    start = p + 1
    return p
  }

  const colEl = inside ? (el.closest('.column') as HTMLElement | null) : null
  if (colEl) {
    let at: number
    try {
      at = view.posAtDOM(colEl, 0)
    } catch {
      return null
    }
    const $p = doc.resolve(at)
    const d = findDepth($p, 'column')
    if (d < 0) return null
    const columns = $p.node(d - 1)
    // Only the last column has free space to its right.
    if ($p.index(d - 1) !== columns.childCount - 1) return null
    enterLastColumn($p.before(d - 1), columns)
  }

  let hit = blockAt(view, container, start, y)
  if (!hit) return null
  let dom = hit.dom
  let r = hit.r
  let from = hit.pos
  let to = hit.pos + hit.child.nodeSize
  if (hit.child.type.name === 'columns') {
    // Beside a columns row: add another column after its last one.
    if (inside) return null
    const colPos = enterLastColumn(hit.pos, hit.child)
    const inner = blockAt(view, container, start, y)
    if (inner) {
      if (!SIDE_TYPES.has(inner.child.type.name)) return null
      dom = inner.dom
      r = inner.r
    } else {
      const colDom = view.nodeDOM(colPos) as HTMLElement | null
      if (!colDom) return null
      dom = colDom
      r = colDom.getBoundingClientRect()
    }
  } else if (!SIDE_TYPES.has(hit.child.type.name)) {
    return null
  }

  const cr = contentRight(dom)
  const slack = (inside ? SIDE_SLACK : 2) * scale
  if (cr == null || x < cr + slack) return null
  const left = r.left
  const leftWidth = Math.max(MIN_COL, Math.round((x - left) / scale - COL_GAP), Math.ceil((cr - left) / scale))
  const hx = Math.min(x, rr.right - 2 * scale)
  if (columnsPos >= 0) return { kind: 'append', columnsPos, colIndex, leftWidth, top: r.top, bottom: r.bottom, x: hx }
  return { kind: 'wrap', from, to, leftWidth, top: r.top, bottom: r.bottom, x: hx }
}

function emptyColumn(state: EditorState, width: number | null = null) {
  const { column, paragraph } = state.schema.nodes
  return column.create({ width }, paragraph.create())
}

/** Selection at the start of the column that begins at `colPos`. */
function selectInColumn(tr: Transaction, colPos: number) {
  tr.setSelection(TextSelection.near(tr.doc.resolve(colPos + 1)))
}

function applySideTarget(view: EditorView, t: SideTarget) {
  const { state } = view
  const tr = state.tr
  if (t.kind === 'wrap') {
    const content = state.doc.slice(t.from, t.to).content
    const { columns, column } = state.schema.nodes
    const node = columns.create({ divider: false }, [column.create({ width: t.leftWidth }, content), emptyColumn(state)])
    tr.replaceWith(t.from, t.to, node)
    selectInColumn(tr, t.from + 1 + node.child(0).nodeSize)
  } else {
    const columns = state.doc.nodeAt(t.columnsPos)
    if (!columns) return
    let colPos = t.columnsPos + 1
    for (let i = 0; i < t.colIndex; i++) colPos += columns.child(i).nodeSize
    const last = columns.child(t.colIndex)
    tr.setNodeMarkup(colPos, undefined, { ...last.attrs, width: t.leftWidth })
    const insertAt = colPos + last.nodeSize
    tr.insert(insertAt, emptyColumn(state))
    selectInColumn(tr, insertAt)
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** Blocks the selection covers, lifted to the doc or column level so lists and quotes stay whole. */
function selectedBlockRange(tr: Transaction) {
  const { $from, $to } = tr.selection
  return $from.blockRange($to, (n) => n.type.name === 'doc' || n.type.name === 'column')
}

function splitSelection(tr: Transaction, state: EditorState, view: EditorView | undefined, divider: boolean) {
  const range = selectedBlockRange(tr)
  if (!range) return false
  const { columns, column } = state.schema.nodes
  const content = tr.doc.slice(range.start, range.end).content
  // Equal halves by default, unless an image on the left needs more room.
  let leftWidth: number | null = null
  if (view) {
    const scale = scaleOf(view)
    const half = ((view.dom as HTMLElement).clientWidth - COL_GAP) / 2
    let img = 0
    for (let pos = range.start, i = range.startIndex; i < range.endIndex; i++) {
      const dom = view.nodeDOM(pos) as HTMLElement | null
      if (dom && dom.nodeType === 1) img = Math.max(img, widestImage(dom, scale))
      pos += range.parent.child(i).nodeSize
    }
    if (img > half) leftWidth = Math.ceil(img)
  }
  const node = columns.create({ divider }, [column.create({ width: leftWidth }, content), emptyColumn(state)])
  tr.replaceWith(range.start, range.end, node)
  selectInColumn(tr, range.start + 1 + node.child(0).nodeSize)
  return true
}

// ------------------------------------------------------------------ extension

const sideKey = new PluginKey('columnsUi')

export const ColumnsKit = Extension.create({
  name: 'columnsKit',
  priority: 1000,

  addExtensions() {
    return [Columns, Column]
  },

  addCommands() {
    return {
      setThickVerticalRule:
        () =>
        ({ tr, state, dispatch, view }) => {
          const d = findDepth(tr.selection.$from, 'columns')
          if (d > 0) {
            if (dispatch) {
              const pos = tr.selection.$from.before(d)
              const node = tr.doc.nodeAt(pos)!
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, divider: !node.attrs.divider })
            }
            return true
          }
          if (!dispatch) return !!selectedBlockRange(tr)
          return splitSelection(tr, state, view, true)
        },
      addColumnRight:
        () =>
        ({ tr, state, dispatch, view }) => {
          const $from = tr.selection.$from
          const d = findDepth($from, 'column')
          if (d > 0) {
            if (dispatch) {
              const at = $from.after(d)
              tr.insert(at, emptyColumn(state))
              selectInColumn(tr, at)
            }
            return true
          }
          if (!dispatch) return !!selectedBlockRange(tr)
          return splitSelection(tr, state, view, false)
        },
      toggleColumnDivider:
        () =>
        ({ tr, dispatch }) => {
          const d = findDepth(tr.selection.$from, 'columns')
          if (d < 0) return false
          if (dispatch) {
            const pos = tr.selection.$from.before(d)
            const node = tr.doc.nodeAt(pos)!
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, divider: !node.attrs.divider })
          }
          return true
        },
      removeColumns:
        () =>
        ({ tr, dispatch }) => {
          const d = findDepth(tr.selection.$from, 'columns')
          if (d < 0) return false
          if (dispatch) {
            const pos = tr.selection.$from.before(d)
            const node = tr.doc.nodeAt(pos)!
            const parts: PMNode[] = []
            node.forEach((col) => col.forEach((b) => parts.push(b)))
            tr.replaceWith(pos, pos + node.nodeSize, Fragment.from(parts))
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))))
          }
          return true
        },
      exitColumns:
        () =>
        ({ tr, state, dispatch }) => {
          const d = findDepth(tr.selection.$from, 'columns')
          if (d < 0) return false
          if (dispatch) {
            const after = tr.selection.$from.after(d)
            tr.insert(after, state.schema.nodes.paragraph.create())
            tr.setSelection(TextSelection.create(tr.doc, after + 1))
          }
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    /** Arrow up/down off the first/last line of a column leaves the columns block. */
    const leave = (dir: 1 | -1) => () => {
      const { state, view } = this.editor
      const sel = state.selection
      if (!sel.empty) return false
      const $pos = sel.$from
      const cd = findDepth($pos, 'column')
      if (cd < 0) return false
      const col = $pos.node(cd)
      const idx = $pos.index(cd)
      if (dir > 0 ? idx !== col.childCount - 1 : idx !== 0) return false
      // Nested blocks (lists) must be at their own edge too.
      for (let d = cd + 1; d < $pos.depth; d++) {
        const i = $pos.index(d)
        if (dir > 0 ? i !== $pos.node(d).childCount - 1 : i !== 0) return false
      }
      if (!view.endOfTextblock(dir > 0 ? 'down' : 'up')) return false
      const pos = dir > 0 ? $pos.after(cd - 1) : $pos.before(cd - 1)
      const $out = state.doc.resolve(pos)
      const tr = state.tr
      const near = dir > 0 ? $out.nodeAfter : $out.nodeBefore
      if (near) {
        const found = Selection.findFrom($out, dir, true)
        if (found) tr.setSelection(found)
        else tr.setSelection(new GapCursor($out))
      } else if ((GapCursor as any).valid?.($out)) {
        tr.setSelection(new GapCursor($out))
      } else {
        tr.insert(pos, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, pos + 1))
      }
      view.dispatch(tr.scrollIntoView())
      return true
    }

    return {
      'Mod-Enter': () => this.editor.commands.exitColumns(),
      ArrowDown: leave(1),
      ArrowUp: leave(-1),
      Backspace: () => {
        const { state, view } = this.editor
        const sel = state.selection
        if (!sel.empty || sel.$from.parentOffset !== 0) return false
        const $pos = sel.$from
        const cd = findDepth($pos, 'column')
        if (cd < 0) return false
        // Only when the caret is at the very start of the column.
        for (let d = cd; d < $pos.depth; d++) if ($pos.index(d) !== 0) return false
        const col = $pos.node(cd)
        const colIndex = $pos.index(cd - 1)
        const colPos = $pos.before(cd)
        const isEmpty = col.childCount === 1 && col.firstChild!.isTextblock && col.firstChild!.content.size === 0
        const tr = state.tr
        if (isEmpty) {
          tr.delete(colPos, colPos + col.nodeSize)
          if (colIndex > 0) {
            // Caret to the end of the column on the left.
            tr.setSelection(Selection.near(tr.doc.resolve(colPos - 1), -1))
          } else {
            tr.setSelection(Selection.near(tr.doc.resolve(Math.min(colPos + 1, tr.doc.content.size))))
          }
          view.dispatch(tr)
          return true
        }
        if (colIndex > 0) {
          tr.setSelection(Selection.near(tr.doc.resolve(colPos - 1), -1))
          view.dispatch(tr)
          return true
        }
        // First column: remove an empty line sitting right above the columns, else do nothing.
        const columnsPos = $pos.before(cd - 1)
        const $before = state.doc.resolve(columnsPos)
        const prev = $before.nodeBefore
        if (prev && prev.isTextblock && prev.content.size === 0) {
          view.dispatch(tr.delete(columnsPos - prev.nodeSize, columnsPos))
        }
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      // Keep the structure tidy: a single column unwraps, and the last column always flexes.
      new Plugin({
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.docChanged)) return null
          // Fix one problem per pass; ProseMirror re-runs this until nothing changes.
          const tr = state.tr
          state.doc.descendants((node, pos) => {
            if (tr.docChanged) return false
            if (node.type.name !== 'columns') return true
            if (node.childCount === 1) {
              // Unwrap both levels in place so the caret inside keeps its spot.
              tr.step(new ReplaceAroundStep(pos, pos + node.nodeSize, pos + 2, pos + node.nodeSize - 2, Slice.empty, 0, true))
              return false
            }
            const last = node.lastChild!
            if (last.attrs.width != null) {
              tr.setNodeMarkup(pos + node.nodeSize - 1 - last.nodeSize, undefined, { ...last.attrs, width: null })
              return false
            }
            return true
          })
          return tr.docChanged ? tr : null
        },
      }),
      // Blocks that an extended vertical line runs past get narrowed so their text wraps before the line.
      new Plugin({
        key: wrapKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set: DecorationSet) => {
            const next = tr.getMeta(wrapKey) as DecorationSet | undefined
            return next ?? set.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations: (state) => wrapKey.getState(state),
        },
        view: (view) => {
          // Only width changes matter; height changes are mostly our own narrowing.
          let lastWidth = -1
          const ro = new ResizeObserver(() => {
            const w = (view.dom as HTMLElement).offsetWidth
            if (w === lastWidth) return
            lastWidth = w
            wrapOf.delete(view)
            scheduleWrap(view)
          })
          ro.observe(view.dom)
          scheduleWrap(view)
          return {
            update: (_v, prev) => {
              if (prev.doc !== view.state.doc) wrapOf.delete(view)
              scheduleWrap(view)
            },
            destroy: () => {
              ro.disconnect()
              const w = wrapOf.get(view)
              if (w?.raf) cancelAnimationFrame(w.raf)
              wrapOf.delete(view)
            },
          }
        },
      }),
      new Plugin({
        key: sideKey,
        props: {
          handleDOMEvents: {
            dblclick: (view, event) => {
              if (!view.editable || event.button !== 0) return false
              const t = findSideTarget(view, event.clientX, event.clientY, event.target)
              if (!t) return false
              event.preventDefault()
              applySideTarget(view, t)
              hideHint(view)
              return true
            },
            mousemove: (view, event) => {
              scheduleHover(view, event)
              return false
            },
            mouseleave: (view, event) => {
              const to = event.relatedTarget as Element | null
              if (to && to.closest?.('.col-gutter')) return false
              hideHint(view)
              if (!uiOf.get(view)?.selected) hideGutter(view)
              return false
            },
          },
        },
        view: (view) => {
          const detach = attachGlobal(view)
          return {
            // Keep the line handle glued to the line while the doc changes.
            update: () => refreshGap(view),
            destroy: () => {
              detach()
              const u = uiOf.get(view)
              u?.hint?.remove()
              u?.gutter?.remove()
              if (u?.raf) cancelAnimationFrame(u.raf)
              uiOf.delete(view)
            },
          }
        },
      }),
    ]
  },
})

// ------------------------------------------------------------------ line wrap

const wrapKey = new PluginKey<DecorationSet>('columnsLineWrap')
/** Measure passes allowed per doc version; narrowing changes heights, so a few rounds may be needed. */
const MAX_WRAP_PASSES = 6
const wrapOf = new WeakMap<EditorView, { raf?: number; passes: number }>()

function scheduleWrap(view: EditorView) {
  let w = wrapOf.get(view)
  if (!w) wrapOf.set(view, (w = { passes: 0 }))
  if (w.raf) return
  const st = w
  st.raf = requestAnimationFrame(() => {
    st.raf = 0
    if (wrapOf.get(view) !== st || st.passes >= MAX_WRAP_PASSES) return
    const found = measureWrap(view)
    const sig = found.map((f) => `${f.pos}:${f.width}`).join(',')
    const cur = (wrapKey.getState(view.state) ?? DecorationSet.empty)
      .find()
      .map((d) => `${d.from}:${d.spec.width}`)
      .join(',')
    if (sig === cur) return
    st.passes++
    const set = DecorationSet.create(
      view.state.doc,
      found.map((f) => Decoration.node(f.pos, f.pos + f.size, { class: 'line-wrapped', style: `max-width: ${f.width}px` }, { width: f.width })),
    )
    view.dispatch(view.state.tr.setMeta(wrapKey, set).setMeta('addToHistory', false))
  })
}

/** Sibling blocks crossed by the part of a vertical line that extends past its columns row. */
function measureWrap(view: EditorView) {
  const out: { pos: number; size: number; width: number }[] = []
  const seen = new Set<number>()
  const scale = scaleOf(view)
  const { doc } = view.state
  ;(view.dom as HTMLElement).querySelectorAll('.columns.has-divider').forEach((node) => {
    const columnsEl = node as HTMLElement
    const ins = lineInsets(columnsEl)
    if (ins.top >= 0 && ins.bottom >= 0) return
    const pos = columnsPosOf(view, columnsEl)
    if (pos < 0) return
    const cols = colsOf(columnsEl)
    if (cols.length < 2) return
    const cr = columnsEl.getBoundingClientRect()
    const lineTop = cr.top + ins.top * scale
    const lineBottom = cr.bottom - ins.bottom * scale
    // Text beside the line stops where the first column's text stops.
    const stopAt = cols[0].getBoundingClientRect().right
    const $pos = doc.resolve(pos)
    const parent = $pos.parent
    let p = $pos.start()
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i)
      const at = p
      p += child.nodeSize
      if (at === pos || seen.has(at)) continue
      const dom = view.nodeDOM(at) as HTMLElement | null
      if (!dom || dom.nodeType !== 1) continue
      const r = dom.getBoundingClientRect()
      if (r.bottom <= lineTop + 1 || r.top >= lineBottom - 1) continue
      const width = Math.max(MIN_COL, Math.round((stopAt - r.left) / scale))
      seen.add(at)
      out.push({ pos: at, size: child.nodeSize, width })
    }
  })
  return out.sort((a, b) => a.pos - b.pos)
}

// ------------------------------------------------------------------ hover UI

/** The gap between two columns, and where its vertical line is drawn on screen. */
interface Gap {
  columnsEl: HTMLElement
  index: number
  divider: boolean
  mid: number
  top: number
  bottom: number
}

interface Ui {
  hint?: HTMLDivElement
  gutter?: HTMLDivElement
  raf?: number
  last?: MouseEvent
  dragging?: boolean
  /** Gap under the pointer, or the clicked one; Delete and right-click act on it. */
  gap?: Gap | null
  hovering?: boolean
  selected?: boolean
}
const uiOf = new WeakMap<EditorView, Ui>()
const ui = (view: EditorView) => {
  let u = uiOf.get(view)
  if (!u) uiOf.set(view, (u = {}))
  return u
}

/** Overlays live next to the editable element, never inside it. */
function host(view: EditorView) {
  const h = (view.dom as HTMLElement).parentElement
  if (h && getComputedStyle(h).position === 'static') h.style.position = 'relative'
  return h
}

const MAX_LINE_EXTEND = 2000
const MIN_LINE = 12

function lineInsets(columnsEl: HTMLElement) {
  return { top: Number(columnsEl.dataset.lineTop) || 0, bottom: Number(columnsEl.dataset.lineBottom) || 0 }
}

function colsOf(columnsEl: HTMLElement) {
  return Array.from(columnsEl.children).filter((c) => c.classList.contains('column')) as HTMLElement[]
}

/** Finds the column gap (or its possibly extended vertical line) under a point. */
function findGap(view: EditorView, x: number, y: number): Gap | null {
  const scale = scaleOf(view)
  const all = Array.from((view.dom as HTMLElement).querySelectorAll('.columns')) as HTMLElement[]
  // Innermost first, so nested columns win.
  for (let k = all.length - 1; k >= 0; k--) {
    const columnsEl = all[k]
    const divider = columnsEl.classList.contains('has-divider')
    const cr = columnsEl.getBoundingClientRect()
    const ins = lineInsets(columnsEl)
    const top = divider ? cr.top + ins.top * scale : cr.top
    const bottom = divider ? cr.bottom - ins.bottom * scale : cr.bottom
    if (y < top - 6 * scale || y > bottom + 6 * scale) continue
    const cols = colsOf(columnsEl)
    for (let i = 1; i < cols.length; i++) {
      const a = cols[i - 1].getBoundingClientRect()
      const b = cols[i].getBoundingClientRect()
      if (x >= a.right - 3 * scale && x <= b.left + 3 * scale) {
        return { columnsEl, index: i - 1, divider, mid: (a.right + b.left) / 2, top, bottom }
      }
    }
  }
  return null
}

function scheduleHover(view: EditorView, e: MouseEvent) {
  const u = ui(view)
  u.last = e
  if (u.raf || u.dragging) return
  u.raf = requestAnimationFrame(() => {
    u.raf = 0
    const ev = u.last
    if (!ev || ev.buttons || !view.editable) return
    const gap = findGap(view, ev.clientX, ev.clientY)
    if (gap) {
      u.hovering = true
      placeGutter(view, gap)
      hideHint(view)
      return
    }
    u.hovering = false
    if (!u.selected) hideGutter(view)
    const t = findSideTarget(view, ev.clientX, ev.clientY, ev.target)
    if (t) showHint(view, t, ev.clientY)
    else hideHint(view)
  })
}

const HINT_H = 18

function showHint(view: EditorView, t: SideTarget, y: number) {
  const h = host(view)
  if (!h) return
  const u = ui(view)
  if (!u.hint) {
    u.hint = document.createElement('div')
    u.hint.className = 'side-write-hint'
  }
  if (u.hint.parentElement !== h) h.appendChild(u.hint)
  const scale = scaleOf(view)
  const hr = h.getBoundingClientRect()
  // Three short dashes next to the pointer, kept inside the block's height.
  const cy = Math.min(Math.max(y, t.top + (HINT_H / 2) * scale), Math.max(t.top + (HINT_H / 2) * scale, t.bottom - (HINT_H / 2) * scale))
  u.hint.style.left = `${(t.x - hr.left) / scale}px`
  u.hint.style.top = `${(cy - hr.top) / scale - HINT_H / 2}px`
  u.hint.classList.add('on')
}

function hideHint(view: EditorView) {
  uiOf.get(view)?.hint?.classList.remove('on')
}

function hideGutter(view: EditorView, force = false) {
  const u = uiOf.get(view)
  if (!u?.gutter || u.dragging) return
  if (u.selected && !force) return
  u.gutter.classList.remove('on', 'selected')
  u.selected = false
  u.hovering = false
  u.gap = null
}

function positionGutter(view: EditorView, g: HTMLDivElement, gap: Gap) {
  const h = host(view)
  if (!h) return
  if (g.parentElement !== h) h.appendChild(g)
  const scale = scaleOf(view)
  const hr = h.getBoundingClientRect()
  g.style.left = `${(gap.mid - hr.left) / scale}px`
  g.style.top = `${(gap.top - hr.top) / scale}px`
  g.style.height = `${Math.max(MIN_LINE, (gap.bottom - gap.top) / scale)}px`
}

function placeGutter(view: EditorView, gap: Gap) {
  const u = ui(view)
  if (u.selected && u.gap && u.gap.columnsEl !== gap.columnsEl) {
    u.selected = false
    u.gutter?.classList.remove('selected')
  }
  if (!u.gutter) {
    const g = document.createElement('div')
    g.className = 'col-gutter'
    g.innerHTML = '<div class="col-gutter-bar"></div><div class="col-end col-end-top"></div><div class="col-end col-end-bottom"></div>'
    g.addEventListener('mouseleave', () => {
      u.hovering = false
      if (!u.dragging && !u.selected) hideGutter(view)
    })
    g.addEventListener('mouseenter', () => (u.hovering = true))
    g.addEventListener('pointerdown', (ev) => startGutterDrag(view, ev))
    g.addEventListener('dblclick', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if ((ev.target as Element).closest('.col-end')) resetLine(view)
      else resetWidths(view)
    })
    ;(g as any)._view = view
    u.gutter = g
  }
  u.gap = gap
  const g = u.gutter
  g.classList.toggle('has-line', gap.divider)
  g.title = gap.divider
    ? 'Drag to resize columns, drag the ends to change the line length. Click, then Delete to remove. Right-click for options.'
    : 'Drag to resize columns. Double-click to reset. Right-click for options.'
  positionGutter(view, g, gap)
  g.classList.add('on')
}

function refreshGap(view: EditorView) {
  const u = ui(view)
  if (!u.gap || !u.gutter) return
  const { columnsEl, index } = u.gap
  const cols = colsOf(columnsEl)
  if (!columnsEl.isConnected || !cols[index + 1]) return hideGutter(view, true)
  const scale = scaleOf(view)
  const cr = columnsEl.getBoundingClientRect()
  const ins = lineInsets(columnsEl)
  const divider = columnsEl.classList.contains('has-divider')
  const a = cols[index].getBoundingClientRect()
  const b = cols[index + 1].getBoundingClientRect()
  u.gap = {
    columnsEl,
    index,
    divider,
    mid: (a.right + b.left) / 2,
    top: divider ? cr.top + ins.top * scale : cr.top,
    bottom: divider ? cr.bottom - ins.bottom * scale : cr.bottom,
  }
  u.gutter.classList.toggle('has-line', divider)
  positionGutter(view, u.gutter, u.gap)
}

function columnsPosOf(view: EditorView, columnsEl: HTMLElement) {
  try {
    const $p = view.state.doc.resolve(view.posAtDOM(columnsEl, 0))
    const d = findDepth($p, 'columns')
    return d > 0 ? $p.before(d) : -1
  } catch {
    return -1
  }
}

function gapNode(view: EditorView) {
  const gap = uiOf.get(view)?.gap
  if (!gap) return null
  const pos = columnsPosOf(view, gap.columnsEl)
  const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null
  return node && node.type.name === 'columns' ? { pos, node } : null
}

function resetWidths(view: EditorView) {
  const hit = gapNode(view)
  if (!hit) return
  const tr = view.state.tr
  let p = hit.pos + 1
  hit.node.forEach((col) => {
    if (col.attrs.width != null) tr.setNodeMarkup(p, undefined, { ...col.attrs, width: null })
    p += col.nodeSize
  })
  if (tr.docChanged) view.dispatch(tr)
  requestAnimationFrame(() => refreshGap(view))
}

function resetLine(view: EditorView) {
  const hit = gapNode(view)
  if (!hit) return
  view.dispatch(view.state.tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, lineTop: 0, lineBottom: 0 }))
  requestAnimationFrame(() => refreshGap(view))
}

function setDivider(view: EditorView, on: boolean) {
  const hit = gapNode(view)
  if (!hit) return
  view.dispatch(view.state.tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, divider: on, lineTop: 0, lineBottom: 0 }))
  requestAnimationFrame(() => refreshGap(view))
}

function unwrapColumns(view: EditorView) {
  const hit = gapNode(view)
  if (!hit) return
  const parts: PMNode[] = []
  hit.node.forEach((col) => col.forEach((b) => parts.push(b)))
  view.dispatch(view.state.tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, Fragment.from(parts)))
  hideGutter(view, true)
}

const isBlank = (col: PMNode) => {
  let blank = true
  col.forEach((b) => {
    if (!(b.isTextblock && b.content.size === 0)) blank = false
  })
  return blank
}

/** Removes the vertical line. If nothing was written beside it, the columns go too. */
function deleteLine(view: EditorView) {
  const hit = gapNode(view)
  if (!hit) return
  let restBlank = true
  hit.node.forEach((col, _o, i) => {
    if (i > 0 && !isBlank(col)) restBlank = false
  })
  if (restBlank) {
    const tr = view.state.tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, hit.node.child(0).content)
    view.dispatch(tr)
    hideGutter(view, true)
  } else {
    setDivider(view, false)
    hideGutter(view, true)
  }
}

/** Items for right-clicking a column gap or vertical line, or null when the click was elsewhere. */
export function columnLineMenu(target: EventTarget | null): { label: string; danger?: boolean; onClick(): void }[] | null {
  const g = target instanceof Element ? (target.closest('.col-gutter') as HTMLDivElement | null) : null
  const view = g ? ((g as any)._view as EditorView | undefined) : undefined
  const gap = view ? uiOf.get(view)?.gap : null
  if (!view || !gap) return null
  const u = ui(view)
  u.selected = true
  g!.classList.add('selected')
  const items = gap.divider
    ? [
        { label: 'Delete vertical line', danger: true, onClick: () => deleteLine(view) },
        { label: 'Reset line length', onClick: () => resetLine(view) },
      ]
    : [{ label: 'Add vertical line', onClick: () => setDivider(view, true) }]
  return [
    ...items,
    { label: 'Reset column widths', onClick: () => resetWidths(view) },
    { label: 'Remove columns, keep text', onClick: () => unwrapColumns(view) },
  ]
}

function startGutterDrag(view: EditorView, ev: PointerEvent) {
  if (ev.button !== 0) return
  const u = ui(view)
  const g = u.gutter!
  const gap = u.gap
  if (!gap) return
  ev.preventDefault()
  ev.stopPropagation()
  const end = (ev.target as Element).closest('.col-end')
  const scale = scaleOf(view)
  const { columnsEl, index } = gap
  const cols = colsOf(columnsEl)
  const n = cols.length
  const y0 = ev.clientY
  const x0 = ev.clientX
  let moved = false
  u.dragging = true
  g.classList.add('dragging')
  g.setPointerCapture(ev.pointerId)

  // Vertical line length: drag either end, past the row edges too.
  const ins0 = lineInsets(columnsEl)
  const hCss = columnsEl.getBoundingClientRect().height / scale
  let lineTop = ins0.top
  let lineBottom = ins0.bottom
  const isTop = !!end?.classList.contains('col-end-top')

  // Column widths: freeze every non-last column so nothing jumps.
  const start = cols.map((c) => c.getBoundingClientRect().width / scale)
  const mins = cols.map((c) => Math.max(MIN_COL, widestImage(c, scale)))
  const widths = start.slice()
  const apply = () => cols.forEach((c, j) => (c.style.flex = j < n - 1 ? `0 0 ${widths[j]}px` : ''))

  const move = (e: PointerEvent) => {
    const dx = (e.clientX - x0) / scale
    const dy = (e.clientY - y0) / scale
    if (!moved && Math.abs(end ? dy : dx) < 2) return
    if (!moved && !end) apply()
    moved = true
    if (end) {
      if (isTop) lineTop = Math.round(Math.min(hCss - lineBottom - MIN_LINE, Math.max(-MAX_LINE_EXTEND, ins0.top + dy)))
      else lineBottom = Math.round(Math.min(hCss - lineTop - MIN_LINE, Math.max(-MAX_LINE_EXTEND, ins0.bottom - dy)))
      columnsEl.style.setProperty('--line-top', `${lineTop}px`)
      columnsEl.style.setProperty('--line-bottom', `${lineBottom}px`)
      columnsEl.dataset.lineTop = String(lineTop)
      columnsEl.dataset.lineBottom = String(lineBottom)
    } else {
      let a = Math.max(mins[index], start[index] + dx)
      if (index + 1 < n - 1) {
        // Two fixed columns: trade width between them.
        const b = Math.max(mins[index + 1], start[index + 1] - (a - start[index]))
        a = start[index] + (start[index + 1] - b)
        widths[index + 1] = b
      }
      widths[index] = Math.round(a)
      apply()
    }
    refreshGap(view)
    wrapOf.delete(view)
    scheduleWrap(view)
  }
  const up = () => {
    g.removeEventListener('pointermove', move)
    g.removeEventListener('pointerup', up)
    g.removeEventListener('pointercancel', up)
    u.dragging = false
    g.classList.remove('dragging')
    const hit = gapNode(view)
    if (!hit || hit.node.childCount !== n) return
    if (!moved) {
      // A plain click selects the line so Delete removes it.
      if (gap.divider) {
        u.selected = true
        g.classList.add('selected')
      }
      return
    }
    const tr = view.state.tr
    if (end) {
      tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, lineTop, lineBottom })
    } else {
      let p = hit.pos + 1
      hit.node.forEach((col, _o, j) => {
        const w = j < n - 1 ? Math.round(widths[j]) : null
        if (col.attrs.width !== w) tr.setNodeMarkup(p, undefined, { ...col.attrs, width: w })
        p += col.nodeSize
      })
    }
    if (tr.docChanged) view.dispatch(tr)
    requestAnimationFrame(() => refreshGap(view))
  }
  g.addEventListener('pointermove', move)
  g.addEventListener('pointerup', up)
  g.addEventListener('pointercancel', up)
}

/** Page-level listeners: the cell padding beside the editor, Delete on a line, click-away. */
function attachGlobal(view: EditorView) {
  const inCell = (t: Element | null) => {
    const cell = (view.dom as HTMLElement).closest('.cell')
    return !!cell && !!t && t.closest('.cell') === cell
  }
  const onMove = (e: MouseEvent) => {
    const t = e.target instanceof Element ? e.target : null
    if (!t || (view.dom as HTMLElement).contains(t) || t.closest('.col-gutter')) return
    if (inCell(t)) scheduleHover(view, e)
    else {
      hideHint(view)
      if (!uiOf.get(view)?.selected) hideGutter(view)
    }
  }
  const onDbl = (e: MouseEvent) => {
    const t = e.target instanceof Element ? e.target : null
    if (!t || (view.dom as HTMLElement).contains(t) || !inCell(t) || !view.editable) return
    const st = findSideTarget(view, e.clientX, e.clientY, t)
    if (!st) return
    e.preventDefault()
    e.stopPropagation()
    applySideTarget(view, st)
    hideHint(view)
  }
  const onKey = (e: KeyboardEvent) => {
    const u = uiOf.get(view)
    if (!u?.gap?.divider || !(u.hovering || u.selected)) return
    if (e.key === 'Delete' || (e.key === 'Backspace' && u.selected)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      deleteLine(view)
    } else if (e.key === 'Escape' && u.selected) {
      e.preventDefault()
      e.stopImmediatePropagation()
      hideGutter(view, true)
    }
  }
  const onDown = (e: PointerEvent) => {
    const u = uiOf.get(view)
    if (!u?.selected) return
    const t = e.target instanceof Element ? e.target : null
    if (t && t.closest('.col-gutter') === u.gutter) return
    if (t && t.closest('.popover')) return
    hideGutter(view, true)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('dblclick', onDbl, true)
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onDown, true)
  return () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('dblclick', onDbl, true)
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onDown, true)
  }
}

// ------------------------------------------------------------------ legacy

/**
 * Old notes stored the vertical line as an inline span with hard-break +
 * spacer hacks for the text beside it. Convert those into real columns.
 */
export function migrateLegacyHtml(html: string): string {
  if (!html || (!html.includes('thick-vr') && !html.includes('align-spacer'))) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  doc.querySelectorAll('span.align-spacer').forEach((s) => s.remove())
  doc.querySelectorAll('span.thick-vr').forEach((vr) => {
    const block = vr.closest('p, h1, h2, h3, h4')
    if (!block || !vr.isConnected) {
      vr.remove()
      return
    }
    const before = doc.createRange()
    before.setStart(block, 0)
    before.setEndBefore(vr)
    const after = doc.createRange()
    after.setStartAfter(vr)
    after.setEnd(block, block.childNodes.length)
    const leftFrag = before.cloneContents()
    const rightFrag = after.cloneContents()

    const left = doc.createElement(block.tagName.toLowerCase())
    left.appendChild(leftFrag)
    const rightCol = doc.createElement('div')
    rightCol.setAttribute('data-type', 'column')
    let p = doc.createElement('p')
    Array.from(rightFrag.childNodes).forEach((n) => {
      if (n.nodeName === 'BR') {
        rightCol.appendChild(p)
        p = doc.createElement('p')
      } else p.appendChild(n)
    })
    rightCol.appendChild(p)

    const leftCol = doc.createElement('div')
    leftCol.setAttribute('data-type', 'column')
    leftCol.appendChild(left)
    const columns = doc.createElement('div')
    columns.setAttribute('data-type', 'columns')
    columns.setAttribute('data-divider', 'true')
    columns.append(leftCol, rightCol)
    block.replaceWith(columns)
  })
  doc.querySelectorAll('span.thick-vr').forEach((s) => s.remove())
  return doc.body.innerHTML
}
