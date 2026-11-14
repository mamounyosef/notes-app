/** Moving between pages. */
import { findParent, useStore } from '../../../src/store'
import { useUi } from './state'
import { toast } from './overlays'

/** The next (1) or previous (-1) page next to the open one, in its section. */
export function siblingPage(dir: 1 | -1): string | null {
  const st = useStore.getState()
  const id = st.activePageId
  if (!id) return null
  const parent = findParent(st.workspace.tree, id)
  const list = (parent ? parent.children : st.workspace.tree).filter((n) => n.kind === 'page' && !n.archived)
  const i = list.findIndex((n) => n.id === id)
  const next = list[i + dir]
  if (!next) {
    toast(dir > 0 ? 'Last page of this section' : 'First page of this section', undefined, 1500)
    return null
  }
  return next.id
}

/** note:PAGE_ID#CELL_ID links (made by the assistants) open that page. */
export function openNoteLink(href: string) {
  const m = /^note:(?:\/\/)?([^#?]+)(?:#(.+))?$/i.exec(href)
  if (!m) return
  const pageId = decodeURIComponent(m[1])
  const cellId = m[2] ? decodeURIComponent(m[2]) : ''
  useStore
    .getState()
    .openPage(pageId)
    .then(() => {
      if (cellId) useUi.setState({ flash: { pageId, cellId, query: '' } })
    })
}
