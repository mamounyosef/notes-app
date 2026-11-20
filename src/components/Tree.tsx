import React, { useEffect, useRef, useState } from 'react'
import { useStore, findNode } from '../store'
import type { TreeNode } from '../types'
import { Menu, type MenuItem } from './Menu'
import { askConfirm } from '../lib/confirm'
import { Chevron, File, Folder, Book, Plus, Star, Trash, Copy, Palette, Archive, Download, X } from './Icons'

const NODE_COLORS = ['#7c9cff', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#c678dd', '#f06292', '#a5a5a5']

interface Props {
  /** Which kinds this pane shows. Notebooks pane hides pages, page pane shows only pages. */
  kinds: TreeNode['kind'][]
  roots: TreeNode[]
  activeId: string | null
  onActivate(node: TreeNode): void
  emptyHint?: string
  /**
   * Archive view: shows only archived items, each under copies of its original
   * notebook and sections, so the archive mirrors where things came from.
   */
  archive?: boolean
}

import { pagesUnder } from '../lib/exportDoc'
export { pagesUnder }

/** True when the node or anything below it is archived. */
const holdsArchived = (n: TreeNode): boolean => Boolean(n.archived) || n.children.some(holdsArchived)

const NO_PICKS: string[] = []

export default function Tree({ kinds, roots, activeId, onActivate, emptyHint, archive }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' | 'inside' } | null>(null)
  const dragId = useRef<string | null>(null)
  // The archive keeps its own open/closed state, so folding it never folds the main tree.
  const [archClosed, setArchClosed] = useState<Set<string>>(() => new Set())
  const toggleArch = (id: string) =>
    setArchClosed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const st = useStore
  // Pages ticked for export or print (only the page list ticks them).
  const pickable = kinds.length === 1 && kinds[0] === 'page' && !archive
  const picked = useStore((s) => (pickable ? s.pageSelection : NO_PICKS))
  const anchor = useRef<string | null>(null)
  /** Page rows as shown, top to bottom. */
  const shownPages = () => {
    const out: string[] = []
    const go = (ns: TreeNode[]) =>
      ns.forEach((n) => {
        if (n.archived || !kinds.includes(n.kind)) return
        if (n.kind === 'page') out.push(n.id)
        if (!n.collapsed) go(n.children)
      })
    go(roots)
    return out
  }
  const togglePick = (id: string) => {
    const cur = st.getState().pageSelection
    anchor.current = id
    st.getState().setPageSelection(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  }
  /** Shift+click: every page from the last ticked (or the open one) to this one. */
  const pickRange = (id: string) => {
    const order = shownPages()
    const from = anchor.current && order.includes(anchor.current) ? anchor.current : st.getState().activePageId
    const a = from ? order.indexOf(from) : -1
    const b = order.indexOf(id)
    const range = a < 0 || b < 0 ? [id] : order.slice(Math.min(a, b), Math.max(a, b) + 1)
    st.getState().setPageSelection([...st.getState().pageSelection, ...range])
    anchor.current = id
  }
  const exportPages = (ids: string[]) => st.getState().openExport({ pageIds: ids })
  /** The ticked pages when this one is among them, else just this one. */
  const forPage = (id: string) => {
    const sel = st.getState().pageSelection
    return pickable && sel.includes(id) ? shownPages().filter((x) => sel.includes(x)) : [id]
  }

  // A node just created opens in rename mode, its default name selected, in the tree that shows it.
  const renameNodeId = useStore((s) => s.renameNodeId)
  useEffect(() => {
    if (!renameNodeId || archive) return
    const n = findNode(roots, renameNodeId)
    if (!n || !kinds.includes(n.kind)) return
    st.setState({ renameNodeId: null })
    setRenaming(n.id)
  }, [renameNodeId, roots])

  const nodeMenu = (n: TreeNode): MenuItem[] => {
    const s = st.getState()
    const childLabel = n.kind === 'notebook' ? 'New section' : n.kind === 'section' ? 'New page' : 'New subpage'
    const childKind: TreeNode['kind'] = n.kind === 'notebook' ? 'section' : 'page'
    return [
      { label: childLabel, icon: <Plus />, onClick: () => s.addNode(childKind, n.id) },
      ...(n.kind === 'section'
        ? [{ label: 'New subsection', icon: <Folder />, onClick: () => s.addNode('section', n.id) }]
        : []),
      { separator: true },
      { label: 'Rename', hint: 'F2', onClick: () => setRenaming(n.id) },
      { label: n.archived ? `Unarchive ${n.kind}` : `Archive ${n.kind}`, icon: <Archive />, onClick: () => s.archiveNode(n.id, !n.archived) },
      ...(n.kind === 'page'
        ? [
            { label: 'Open in new tab', hint: 'Ctrl+click', onClick: () => s.newTab(n.id) },
            {
              label: s.workspace.favorites.includes(n.id) ? 'Remove from favorites' : 'Add to favorites',
              icon: <Star />,
              onClick: () => s.toggleFavorite(n.id),
            },
            { separator: true },
            (() => {
              const ids = forPage(n.id)
              return { label: ids.length > 1 ? `Export or print ${ids.length} pages...` : 'Export or print...', hint: 'PDF, Markdown', icon: <Download />, onClick: () => exportPages(ids) }
            })(),
            ...(pickable ? [{ label: picked.includes(n.id) ? 'Untick' : 'Tick for export', hint: 'Shift+click', onClick: () => togglePick(n.id) }] : []),
            { label: 'Copy page as Markdown', icon: <Copy />, onClick: () => copyPageMarkdown(n.id) },
          ]
        : (() => {
            const ids = pagesUnder(n)
            return ids.length
              ? [
                  { separator: true },
                  { label: `Export or print all ${ids.length} page${ids.length === 1 ? '' : 's'}...`, hint: 'PDF, Markdown', icon: <Download />, onClick: () => exportPages(ids) },
                ]
              : []
          })()),
      { separator: true },
      { title: 'Color' },
      {
        icon: (
          <div className="swatches" style={{ padding: 0, gridTemplateColumns: 'repeat(8, 18px)' }}>
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c, width: 18, height: 18 }}
                onClick={(e) => {
                  e.stopPropagation()
                  s.setNodeColor(n.id, c)
                  setMenu(null)
                }}
              />
            ))}
          </div>
        ),
      },
      { separator: true },
      {
        label: `Delete ${n.kind}`,
        danger: true,
        icon: <Trash />,
        onClick: async () => {
          const hasKids = n.children.length > 0
          if (
            !st.getState().settings.confirmDelete ||
            (await askConfirm(`Delete "${n.title}"${hasKids ? ' and everything inside it' : ''}?`, 'Delete'))
          ) {
            s.deleteNode(n.id)
          }
        },
      },
    ]
  }

  const renderNode = (n: TreeNode, depth: number, inArchived = false): React.ReactNode => {
    if (!kinds.includes(n.kind)) return null
    if (!archive && n.archived) return null
    if (archive && !inArchived && !holdsArchived(n)) return null
    const archivedHere = inArchived || Boolean(n.archived)
    const children = n.children.filter((c) => kinds.includes(c.kind))
    const open = archive ? !archClosed.has(n.id) : !n.collapsed
    const toggle = () => (archive ? toggleArch(n.id) : st.getState().toggleCollapse(n.id))
    // In the archive, a row that only stands for the original place is dimmed.
    const pathOnly = archive && !archivedHere
    const isActive = activeId === n.id
    const Icon = n.kind === 'notebook' ? Book : n.kind === 'section' ? Folder : File
    const fav = st.getState().workspace.favorites.includes(n.id)

    return (
      <div key={n.id}>
        <div
          className={[
            'row',
            n.kind,
            isActive ? 'active' : '',
            dropTarget?.id === n.id ? `drop-${dropTarget.pos}` : '',
            pickable && picked.includes(n.id) ? 'picked' : '',
            pathOnly ? 'arch-path' : '',
          ].join(' ')}
          style={{ paddingLeft: 6 + depth * 13, ['--node-color' as any]: n.color || 'var(--accent)' }}
          onClick={(e) => {
            // Shift click ticks pages for export or print, a range from the last one.
            if (pickable && n.kind === 'page' && e.shiftKey && !e.ctrlKey && !e.metaKey) return void pickRange(n.id)
            // Ctrl click opens a page in a new tab, behind this one.
            if (n.kind === 'page' && (e.ctrlKey || e.metaKey)) return void useStore.getState().newTab(n.id, { background: !e.shiftKey })
            if (archive && n.kind !== 'page') toggle()
            else onActivate(n)
          }}
          onMouseDown={(e) => n.kind === 'page' && e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => {
            if (n.kind !== 'page' || e.button !== 1) return
            e.preventDefault()
            useStore.getState().newTab(n.id, { background: true })
          }}
          onDoubleClick={() => !pathOnly && setRenaming(n.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n) })
          }}
          draggable={!archive && renaming !== n.id}
          onDragStart={(e) => {
            dragId.current = n.id
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            if (!dragId.current || dragId.current === n.id) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            const rel = (e.clientY - r.top) / r.height
            const canNest = n.kind !== 'page' || true
            setDropTarget({ id: n.id, pos: rel < 0.26 ? 'before' : rel > 0.74 ? 'after' : canNest ? 'inside' : 'after' })
          }}
          onDragLeave={() => setDropTarget((d) => (d?.id === n.id ? null : d))}
          onDrop={(e) => {
            e.preventDefault()
            if (dragId.current && dropTarget) st.getState().moveNode(dragId.current, dropTarget.id, dropTarget.pos)
            dragId.current = null
            setDropTarget(null)
          }}
        >
          {children.length > 0 ? (
            <span
              className={`twisty ${open ? 'open' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                toggle()
              }}
            >
              <Chevron size={13} />
            </span>
          ) : (
            <span className="twisty" />
          )}

          {pickable && n.kind === 'page' && picked.length > 0 ? (
            <input
              type="checkbox"
              className="row-check"
              checked={picked.includes(n.id)}
              title="Tick for export or print (Shift+click picks a range)"
              onClick={(e) => e.stopPropagation()}
              onChange={() => togglePick(n.id)}
            />
          ) : n.kind === 'notebook' ? (
            <span className="dot" />
          ) : (
            <Icon size={14} />
          )}

          <span className="label">
            {renaming === n.id ? (
              <RenameInput
                value={n.title}
                onDone={(v) => {
                  if (v.trim()) st.getState().renameNode(n.id, v.trim())
                  setRenaming(null)
                }}
              />
            ) : (
              n.title
            )}
          </span>

          {fav && <Star size={12} />}

          {n.kind === 'page' && <CellCount pageId={n.id} />}


          {archive && n.archived ? (
            <button
              className="row-btn"
              title={`Unarchive ${n.kind}`}
              onClick={(e) => {
                e.stopPropagation()
                st.getState().archiveNode(n.id, false)
              }}
            >
              <Archive size={13} />
            </button>
          ) : archive ? null : (
          <>
          {n.kind === 'page' && (
            <button
              className="row-btn"
              title={forPage(n.id).length > 1 ? `Export or print the ${forPage(n.id).length} ticked pages` : 'Export or print this page (PDF, Markdown)'}
              onClick={(e) => {
                e.stopPropagation()
                exportPages(forPage(n.id))
              }}
            >
              <Download size={13} />
            </button>
          )}
          <button
            className="row-btn"
            title="Add inside"
            onClick={(e) => {
              e.stopPropagation()
              st.getState().addNode(n.kind === 'notebook' ? 'section' : 'page', n.id)
            }}
          >
            <Plus size={13} />
          </button>
          </>
          )}
        </div>

        {open && children.map((c) => renderNode(c, depth + 1, archivedHere))}
      </div>
    )
  }

  const visible = roots.filter((r) => kinds.includes(r.kind) && (archive ? holdsArchived(r) : !r.archived))

  const pickedShown = pickable && picked.length ? shownPages().filter((id) => picked.includes(id)) : NO_PICKS
  return (
    <>
      {pickable && picked.length > 0 && (
        <div className="page-pick-bar">
          <span className="n">{picked.length} ticked</span>
          <button className="go" title="Export or print the ticked pages" onClick={() => exportPages(pickedShown.length === picked.length ? pickedShown : [...pickedShown, ...picked.filter((x) => !pickedShown.includes(x))])}>
            <Download size={12} /> Export
          </button>
          <button title="Tick every page here" onClick={() => st.getState().setPageSelection([...picked, ...shownPages()])}>
            All
          </button>
          <button title="Untick all" onClick={() => st.getState().setPageSelection([])}>
            <X size={12} />
          </button>
        </div>
      )}
      {visible.length === 0 && emptyHint && <div className="empty-hint">{emptyHint}</div>}
      {visible.map((n) => renderNode(n, 0))}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  )
}

function RenameInput({ value, onDone }: { value: string; onDone(v: string): void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone((e.target as HTMLInputElement).value)
        if (e.key === 'Escape') onDone(value)
      }}
    />
  )
}

async function pageMarkdown(pageId: string) {
  const { storage } = await import('../lib/storage')
  const { htmlToMarkdown } = await import('../editor/markdown')
  const page = (await storage.readPage(pageId)).data
  if (!page) return ''
  const body = [...page.cells]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((c) => `${c.title ? `## ${c.title}\n\n` : ''}${htmlToMarkdown(c.html)}`)
    .join('\n\n')
  return `# ${page.title}\n\n${body}\n`
}

async function copyPageMarkdown(pageId: string) {
  await navigator.clipboard.writeText(await pageMarkdown(pageId))
}

export function CellCount({ pageId }: { pageId: string }) {
  // Narrow picks: every page row has one of these, and subscribing to the whole page
  // or the whole count table redrew every row on each keystroke and page switch.
  const stored = useStore((s) => s.pageCellCounts[pageId])
  const isActive = useStore((s) => s.activePageId === pageId)
  const liveCount = useStore((s) => (s.activePageId === pageId && s.page ? s.page.cells.length : undefined))
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isActive && liveCount !== undefined) {
      useStore.getState().setPageCellCount(pageId, liveCount)
      return
    }
    if (stored === undefined) {
      let cancelled = false
      setLoading(true)
      import('../lib/storage').then(({ storage }) =>
        storage
          .readPage(pageId)
          .then((res) => {
            if (cancelled) return
            useStore.getState().setPageCellCount(pageId, res.data?.cells?.length ?? 0)
            setLoading(false)
          })
          .catch(() => {
            if (!cancelled) {
              useStore.getState().setPageCellCount(pageId, 0)
              setLoading(false)
            }
          }),
      )
      return () => {
        cancelled = true
      }
    }
  }, [pageId, isActive, liveCount, stored])

  const known = isActive && liveCount !== undefined ? liveCount : stored
  if (known === undefined) {
    return <span className="cell-count pending">{loading ? '...' : ''}</span>
  }
  return <span className="cell-count">{known}</span>
}
