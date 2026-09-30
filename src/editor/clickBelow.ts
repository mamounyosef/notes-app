/**
 * Clicking in the empty space just below an image (or any other non-text
 * block such as a table, math block or columns row) puts the caret on a line
 * under it, creating that line when there is none. ArrowDown off such a block
 * does the same, so writing can always continue below it.
 */
import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** Puts the caret on the line under top level block `index`, creating a paragraph if needed. */
function caretBelow(view: EditorView, index: number) {
  const { state } = view
  const doc = state.doc
  let pos = 0
  for (let i = 0; i <= index; i++) pos += doc.child(i).nodeSize
  const next = index + 1 < doc.childCount ? doc.child(index + 1) : null
  const tr = state.tr
  if (!next || !next.isTextblock) tr.insert(pos, state.schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/**
 * Index of the top level non-text block sitting directly above screen y, when
 * y is in empty space (between blocks or below the last one), else -1.
 */
function blockAbove(view: EditorView, y: number) {
  const doc = view.state.doc
  let pos = 0
  let found = -1
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i)
    const dom = view.nodeDOM(pos) as HTMLElement | null
    pos += child.nodeSize
    if (!dom || dom.nodeType !== 1) continue
    const r = dom.getBoundingClientRect()
    if (y >= r.top && y <= r.bottom) return -1
    if (r.bottom < y) found = child.isTextblock ? -1 : i
    else break
  }
  return found
}

function handleDown(view: EditorView, e: MouseEvent) {
  if (!view.editable || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false
  const index = blockAbove(view, e.clientY)
  if (index < 0) return false
  e.preventDefault()
  caretBelow(view, index)
  return true
}

export const ClickBelowBlock = Extension.create({
  name: 'clickBelowBlock',

  addKeyboardShortcuts() {
    return {
      // ArrowDown on a selected image (or other block) at the very end opens a line below it.
      ArrowDown: () => {
        const { state, view } = this.editor
        const sel = state.selection
        if (!(sel instanceof NodeSelection) || sel.$from.depth !== 0 || sel.node.isTextblock) return false
        const index = sel.$from.index(0)
        if (index + 1 < state.doc.childCount) return false
        caretBelow(view, index)
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('clickBelowBlock'),
        props: {
          handleDOMEvents: {
            // Clicks on the editor's own empty space, e.g. the margin under an image.
            mousedown: (view, event) => {
              if (event.target !== view.dom) return false
              return handleDown(view, event)
            },
          },
        },
        view: (view) => {
          // Clicks in the cell below the editor, which ends at the last block's bottom.
          const onDown = (e: MouseEvent) => {
            const t = e.target instanceof Element ? e.target : null
            const root = view.dom as HTMLElement
            const cell = root.closest('.cell')
            if (!t || !cell || t.closest('.cell') !== cell || root.contains(t)) return
            if (t.closest('.cell-title, .cell-grip, .cell-handle, .col-gutter, input, button')) return
            const rr = root.getBoundingClientRect()
            if (e.clientY <= rr.bottom || e.clientX < rr.left || e.clientX > rr.right) return
            handleDown(view, e)
          }
          document.addEventListener('mousedown', onDown, true)
          return { destroy: () => document.removeEventListener('mousedown', onDown, true) }
        },
      }),
    ]
  },
})
