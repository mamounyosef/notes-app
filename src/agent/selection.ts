/**
 * What the user has selected in their notes, kept current for the
 * assistant: the chip next to the model name shows it, and unless they
 * dismiss it, it goes with the next message as context.
 */
import { findNode, useStore } from '../store'
import { scrollToCell } from './reveal'
import { useActiveEditor } from '../editor/activeEditor'
import { htmlToAgent } from './content'
import { useAgent } from './store'
import type { PickedNode } from './api'

export interface LiveSelection {
  /** Changes whenever the selection changes, so a dismissal lasts only for that selection. */
  key: string
  kind: 'text' | 'cells' | 'image' | 'math'
  text: string
  cellIds: string[]
  label: string
  /** Title of the cell the text is in, when known. */
  cellTitle?: string
  pageId?: string
  /** The one picture or equation picked, when that is the selection. */
  node?: PickedNode
  /** Note images inside the selection (their src), sent along as pixels. */
  imageSrcs?: string[]
}

const lineCount = (t: string) => t.split('\n').filter((l) => l.trim()).length || 1
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function cellOf(node: Node | null): string | null {
  const el = (node instanceof Element ? node : node?.parentElement)?.closest?.('[data-cell-id]') as HTMLElement | null
  return el?.dataset.cellId || null
}

const isMath = (n: any) => n.type.name === 'inlineMath' || n.type.name === 'blockMath'
const isImage = (n: any) => n.type.name === 'image'

/** How leaf nodes read in selected text: equations as LaTeX, pictures as a marker, instead of nothing. */
const leafText = (n: any) =>
  isImage(n) ? `[image${n.attrs.alt ? ` "${n.attrs.alt}"` : ''}]` : n.type.name === 'inlineMath' ? `$${n.attrs.latex}$` : n.type.name === 'blockMath' ? `\n$$${n.attrs.latex}$$\n` : n.type.name === 'hardBreak' ? '\n' : ''

/** The picked picture or equation: which one it is in the cell, and the words around it. */
function pickedNode(doc: any, pos: number, node: any) {
  const same = isImage(node) ? isImage : isMath
  let nth = 0
  let of = 0
  doc.descendants((n: any, p: number) => {
    if (!same(n)) return
    if (p < pos) nth++
    of++
  })
  const picked: PickedNode = isImage(node)
    ? { type: 'image', nth, of, src: node.attrs.src || '', alt: node.attrs.alt || undefined }
    : { type: 'math', nth, of, latex: node.attrs.latex || '', display: node.type.name === 'blockMath' }
  const before = doc.textBetween(Math.max(0, pos - 240), pos, '\n', leafText).trim()
  const after = doc.textBetween(pos + node.nodeSize, Math.min(doc.content.size, pos + node.nodeSize + 240), '\n', leafText).trim()
  return { picked, before, after }
}

/** The selection right now, read from the editor, the page or the cell selection. */
export function readSelection(): LiveSelection | null {
  const st = useStore.getState()
  const ed = useActiveEditor.getState().editor as any
  let text = ''
  let cellId: string | null = null
  let imageSrcs: string[] = []
  let maths = 0
  if (ed && !ed.isDestroyed) {
    const sel = ed.state.selection
    const { from, to } = sel
    const doc = ed.state.doc
    const node = sel.node
    cellId = cellOf(ed.view?.dom) || st.editingCellId
    const picked = node && (isImage(node) || isMath(node))
    // A picture or equation picked in a cell you have since left is not the selection any more.
    const live = ed.isFocused || cellId === st.editingCellId || !!document.activeElement?.closest('.agent-panel, .math-inline, .math-block')
    if (picked && live) {
      const cell = st.page?.cells.find((c) => c.id === cellId)
      const { picked, before, after } = pickedNode(doc, from, node)
      const where = `${picked.of > 1 ? `${ordinal(picked.nth + 1)} of ${plural(picked.of, picked.type === 'image' ? 'image' : 'equation')} in` : 'in'} cell ${cellId ? `[${cellId}]` : ''}${cell?.title ? ` "${cell.title}"` : ''}`
      const what =
        picked.type === 'image'
          ? `the image ![${picked.alt || 'image'}](${picked.src}), the ${where}.`
          : `the ${picked.display ? 'block' : 'inline'} equation ${picked.display ? `$$${picked.latex}$$` : `$${picked.latex}$`}, the ${where}.`
      return {
        key: `n:${cellId}:${from}:${picked.type}:${(picked.src || picked.latex || '').slice(-80)}`,
        kind: picked.type,
        text: `${what}${before ? `\nRight before it: """${before.slice(-240)}"""` : ''}${after ? `\nRight after it: """${after.slice(0, 240)}"""` : ''}`,
        cellIds: cellId ? [cellId] : [],
        cellTitle: cell?.title || undefined,
        pageId: st.page?.id,
        node: picked,
        imageSrcs: picked.type === 'image' && picked.src ? [picked.src] : [],
        label: picked.type === 'image' ? (picked.alt ? `Image "${picked.alt.slice(0, 20)}"` : 'Image') : picked.display ? 'Equation' : 'Inline equation',
      }
    }
    if (to > from && !picked) {
      text = doc.textBetween(from, to, '\n', leafText)
      doc.nodesBetween(from, to, (n: any) => {
        if (isImage(n) && n.attrs.src) imageSrcs.push(n.attrs.src)
        if (isMath(n)) maths++
      })
      imageSrcs = [...new Set(imageSrcs)].slice(0, 4)
    } else cellId = null
  }
  if (!text) {
    const ws = window.getSelection()
    const t = ws?.toString().trim()
    if (t && ws?.anchorNode && (ws.anchorNode instanceof Element ? ws.anchorNode : ws.anchorNode.parentElement)?.closest('.canvas-wrap')) {
      text = t
      cellId = cellOf(ws.anchorNode)
    }
  }
  if (text.trim()) {
    const cell = st.page?.cells.find((c) => c.id === cellId)
    const n = lineCount(text)
    const extra = [imageSrcs.length ? plural(imageSrcs.length, 'image') : '', maths ? plural(maths, 'equation') : ''].filter(Boolean)
    return {
      key: `t:${cellId}:${text.length}:${text.slice(0, 60)}`,
      kind: 'text',
      text,
      cellIds: cellId ? [cellId] : [],
      cellTitle: cell?.title || undefined,
      pageId: st.page?.id,
      imageSrcs: imageSrcs.length ? imageSrcs : undefined,
      label: `${plural(n, 'line')}${extra.length ? ` + ${extra.join(' + ')}` : ''} selected`,
    }
  }
  if (st.selection.length && st.page) {
    const cells = st.page.cells.filter((c) => st.selection.includes(c.id))
    if (!cells.length) return null
    return cellsSelection(cells, st.page.id)
  }
  return null
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`

function cellsSelection(cells: { id: string; title?: string; html: string }[], pageId?: string): LiveSelection {
  return {
    key: `c:${cells.map((c) => c.id).join(',')}`,
    kind: 'cells',
    text: cells.map((c) => `[cell ${c.id}] ${c.title ? `## ${c.title}\n` : ''}${htmlToAgent(c.html)}`).join('\n\n'),
    cellIds: cells.map((c) => c.id),
    pageId,
    label: cells.length === 1 ? `Cell "${(cells[0].title || 'untitled').slice(0, 24)}"` : `${cells.length} cells selected`,
  }
}

/** Keeps useAgent.selection in step with the notes, ignoring focus moves into the panel. */
export function trackSelection() {
  let raf = 0
  const update = (force = false) => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      // Clicking into the assistant must not lose what was selected in the notes,
      // but opening another page always replaces it.
      if (!force && document.activeElement?.closest('.agent-panel')) return
      const sel = readSelection()
      const cur = useAgent.getState().selection
      if (sel?.key !== cur?.key) useAgent.setState({ selection: sel })
    })
  }
  const onDom = () => update()
  document.addEventListener('selectionchange', onDom)
  // A picked equation or picture stays picked in its editor after the editor loses focus:
  // a click anywhere else (empty canvas, another cell, the toolbar) lets go of it.
  const onDown = (e: PointerEvent) => {
    const ed = useActiveEditor.getState().editor as any
    const node = ed && !ed.isDestroyed ? ed.state.selection.node : null
    if (!node || !(isImage(node) || isMath(node))) return
    const t = e.target as HTMLElement | null
    if (!t || ed.view.dom.contains(t) || t.closest('.agent-panel, .math-inline-popover, .math-block-editor, .popover, .lb')) return
    ed.commands.setTextSelection(ed.state.selection.to)
    update(true)
  }
  document.addEventListener('pointerdown', onDown, true)
  const off1 = useStore.subscribe((s, p) => {
    if (s.page?.id !== p.page?.id) update(true)
    else if (s.selection !== p.selection || s.editingCellId !== p.editingCellId) update()
  })
  const off2 = useActiveEditor.subscribe(() => update())
  return () => {
    document.removeEventListener('selectionchange', onDom)
    document.removeEventListener('pointerdown', onDown, true)
    off1()
    off2()
    cancelAnimationFrame(raf)
  }
}

/** The element of a picked picture or equation in a cell: the same one when it is still there. */
function nodeEl(cell: HTMLElement, node: PickedNode): HTMLElement | null {
  const all = [...cell.querySelectorAll<HTMLElement>(node.type === 'image' ? '.ProseMirror img' : '.math-inline, .math-block')]
  const value = (el: HTMLElement) => (node.type === 'image' ? el.getAttribute('src') : el.dataset.latex) || ''
  const want = node.type === 'image' ? node.src : node.latex
  const same = all.filter((el) => value(el) === want)
  // Several alike: the one nearest the place it had.
  if (same.length) return same.reduce((best, el) => (Math.abs(all.indexOf(el) - node.nth) < Math.abs(all.indexOf(best) - node.nth) ? el : best))
  return all.length === node.of ? all[node.nth] || null : null
}

/** Plain words of a text selection to look for on the page (equations and image markers do not show as text). */
function plainAnchor(text: string) {
  const parts = text.split(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\[image[^\]]*\]/).map((p) => p.trim())
  return parts.reduce((a, b) => (b.length > a.length ? b : a), '')
}

/** Back to what was selected when a message was sent: opens its page, glides there and marks exactly it. */
export async function goToSelection(sel: Pick<LiveSelection, 'kind' | 'text' | 'cellIds' | 'pageId' | 'node'>) {
  let st = useStore.getState()
  const onPage = (p: typeof st.page) => !!p && sel.cellIds.some((id) => p.cells.some((c) => c.id === id))
  // Older messages did not keep the page: the open one, when it has the cell.
  const pageId = sel.pageId || (onPage(st.page) ? st.page!.id : null)
  if (!pageId || !findNode(st.workspace.tree, pageId)) return
  if (st.activePageId !== pageId) await st.openPage(pageId)
  st = useStore.getState()
  const cellId = sel.cellIds.find((id) => st.page?.cells.some((c) => c.id === id))
  if (!cellId) return
  st.setSelection(sel.kind === 'cells' ? sel.cellIds.filter((id) => st.page!.cells.some((c) => c.id === id)) : [cellId])
  const node = sel.node
  if (node) scrollToCell(cellId, { pick: (cell) => nodeEl(cell, node) })
  else if (sel.kind === 'text') scrollToCell(cellId, { anchor: plainAnchor(sel.text) })
  else scrollToCell(cellId)
}

/** "Ask the assistant about this": opens the panel with the selection attached. */
export function askAboutSelection(cellIds?: string[]) {
  let sel = readSelection()
  const st = useStore.getState()
  if (cellIds?.length && (!sel || sel.kind === 'cells')) {
    const cells = (st.page?.cells || []).filter((c) => cellIds.includes(c.id))
    if (cells.length) sel = cellsSelection(cells, st.page?.id)
  }
  useAgent.setState({ selection: sel, selectionDismissed: null })
  useAgent.getState().prefill(useAgent.getState().draft)
}
