/**
 * Picking a whole table, like picking an equation: hovering a table shows a
 * small handle at its top left corner; a click on it, or on blank space in a
 * cell that has something in it, selects the table (for the assistant, copy,
 * delete). Words stay selectable, and a click anywhere else lets go of it.
 */
import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

const ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/></svg>'

/** The position just before the table that holds a DOM element, or -1. */
function tablePos(view: EditorView, table: HTMLElement) {
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(table.querySelector('td, th') || table, 0))
    for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'table') return $pos.before(d)
  } catch {
    /* the table is being redrawn */
  }
  return -1
}

export function pickTable(view: EditorView, pos: number) {
  const node = view.state.doc.nodeAt(pos)
  if (node?.type.name !== 'table') return
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  view.focus()
}

/** Whether a point is on a cell's words, equations or pictures (rather than the blank space around them). */
function onContent(cell: HTMLElement, x: number, y: number) {
  const hit = (r: DOMRect) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue?.trim()) continue
    range.selectNodeContents(n)
    if ([...range.getClientRects()].some(hit)) return true
  }
  return [...cell.querySelectorAll('img, .math-inline, .math-block, input, label')].some((el) => hit(el.getBoundingClientRect()))
}

export const TablePick = Extension.create({
  name: 'tablePick',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('tablePick'),
        props: {
          // A click on the blank space of a cell that has something in it picks the whole table;
          // words stay selectable as usual, and an empty cell still takes the caret.
          handleClick(view, _pos, event) {
            if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.detail > 1) return false
            const cell = (event.target as HTMLElement).closest?.('td, th') as HTMLElement | null
            if (!cell || !view.dom.contains(cell)) return false
            if (!cell.textContent?.trim() && !cell.querySelector('img, .math-inline, .math-block')) return false
            if (onContent(cell, event.clientX, event.clientY)) return false
            const table = cell.closest('table') as HTMLElement | null
            const pos = table ? tablePos(view, table) : -1
            if (pos < 0) return false
            pickTable(view, pos)
            return true
          },
        },
        view(view) {
          const host = view.dom.parentElement
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'table-pick'
          btn.innerHTML = ICON
          btn.title = 'Select the whole table (for the assistant, copy or delete). A click on blank space in a cell does the same.'
          btn.contentEditable = 'false'
          let table: HTMLElement | null = null
          let hideTimer = 0
          if (host) {
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
            host.appendChild(btn)
          }

          const place = () => {
            if (!table || !host || !table.isConnected) return hide()
            const t = table.getBoundingClientRect()
            const h = host.getBoundingClientRect()
            // On the corner, but never outside the cell, which may clip it.
            btn.style.left = `${Math.max(0, t.left - h.left + host.scrollLeft - 9)}px`
            btn.style.top = `${Math.max(0, t.top - h.top + host.scrollTop - 9)}px`
            btn.classList.add('on')
          }
          const hide = () => {
            table = null
            btn.classList.remove('on')
          }
          const onMove = (e: MouseEvent) => {
            const t = (e.target as HTMLElement).closest?.('table') as HTMLElement | null
            if (t && view.dom.contains(t)) {
              clearTimeout(hideTimer)
              table = t
              place()
            } else if (table && !btn.matches(':hover')) {
              clearTimeout(hideTimer)
              hideTimer = window.setTimeout(hide, 250)
            }
          }
          const onLeave = () => {
            clearTimeout(hideTimer)
            hideTimer = window.setTimeout(() => !btn.matches(':hover') && hide(), 250)
          }
          // Keep the caret where it is until the click lands.
          btn.addEventListener('mousedown', (e) => e.preventDefault())
          btn.addEventListener('click', (e) => {
            e.preventDefault()
            if (!table) return
            const pos = tablePos(view, table)
            if (pos >= 0) pickTable(view, pos)
          })
          btn.addEventListener('mouseleave', onLeave)
          view.dom.addEventListener('mousemove', onMove)
          view.dom.addEventListener('mouseleave', onLeave)

          return {
            update: () => table && place(),
            destroy() {
              clearTimeout(hideTimer)
              view.dom.removeEventListener('mousemove', onMove)
              view.dom.removeEventListener('mouseleave', onLeave)
              btn.remove()
            },
          }
        },
      }),
    ]
  },
})
