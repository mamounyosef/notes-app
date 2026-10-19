/**
 * What the user has selected in their notes, kept current for the
 * assistant: the chip next to the model name shows it, and unless they
 * dismiss it, it goes with the next message as context.
 */
import { useStore } from '../store'
import { useActiveEditor } from '../editor/activeEditor'
import { htmlToAgent } from './content'
import { useAgent } from './store'

export interface LiveSelection {
  /** Changes whenever the selection changes, so a dismissal lasts only for that selection. */
  key: string
  kind: 'text' | 'cells'
  text: string
  cellIds: string[]
  label: string
  /** Title of the cell the text is in, when known. */
  cellTitle?: string
}

const lineCount = (t: string) => t.split('\n').filter((l) => l.trim()).length || 1

function cellOf(node: Node | null): string | null {
  const el = (node instanceof Element ? node : node?.parentElement)?.closest?.('[data-cell-id]') as HTMLElement | null
  return el?.dataset.cellId || null
}

/** The selection right now, read from the editor, the page or the cell selection. */
export function readSelection(): LiveSelection | null {
  const st = useStore.getState()
  const ed = useActiveEditor.getState().editor as any
  let text = ''
  let cellId: string | null = null
  if (ed && !ed.isDestroyed) {
    const { from, to } = ed.state.selection
    if (to > from) {
      text = ed.state.doc.textBetween(from, to, '\n')
      cellId = cellOf(ed.view?.dom) || st.editingCellId
    }
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
    return {
      key: `t:${cellId}:${text.length}:${text.slice(0, 60)}`,
      kind: 'text',
      text,
      cellIds: cellId ? [cellId] : [],
      cellTitle: cell?.title || undefined,
      label: `${n} line${n === 1 ? '' : 's'} selected`,
    }
  }
  if (st.selection.length && st.page) {
    const cells = st.page.cells.filter((c) => st.selection.includes(c.id))
    if (!cells.length) return null
    return {
      key: `c:${cells.map((c) => c.id).join(',')}`,
      kind: 'cells',
      text: cells.map((c) => `[cell ${c.id}] ${c.title ? `## ${c.title}\n` : ''}${htmlToAgent(c.html)}`).join('\n\n'),
      cellIds: cells.map((c) => c.id),
      label: cells.length === 1 ? `Cell "${(cells[0].title || 'untitled').slice(0, 24)}"` : `${cells.length} cells selected`,
    }
  }
  return null
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
  const off1 = useStore.subscribe((s, p) => {
    if (s.page?.id !== p.page?.id) update(true)
    else if (s.selection !== p.selection || s.editingCellId !== p.editingCellId) update()
  })
  const off2 = useActiveEditor.subscribe(() => update())
  return () => {
    document.removeEventListener('selectionchange', onDom)
    off1()
    off2()
    cancelAnimationFrame(raf)
  }
}

/** "Ask the assistant about this": opens the panel with the selection attached. */
export function askAboutSelection(cellIds?: string[]) {
  let sel = readSelection()
  const st = useStore.getState()
  if (cellIds?.length && (!sel || sel.kind === 'cells')) {
    const cells = (st.page?.cells || []).filter((c) => cellIds.includes(c.id))
    if (cells.length) {
      sel = {
        key: `c:${cells.map((c) => c.id).join(',')}`,
        kind: 'cells',
        text: cells.map((c) => `[cell ${c.id}] ${c.title ? `## ${c.title}\n` : ''}${htmlToAgent(c.html)}`).join('\n\n'),
        cellIds: cells.map((c) => c.id),
        label: cells.length === 1 ? `Cell "${(cells[0].title || 'untitled').slice(0, 24)}"` : `${cells.length} cells selected`,
      }
    }
  }
  useAgent.setState({ selection: sel, selectionDismissed: null })
  useAgent.getState().prefill(useAgent.getState().draft)
}
