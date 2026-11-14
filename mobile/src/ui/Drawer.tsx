/**
 * The navigator: notebooks, sections and pages in one tree, recent pages and
 * favorites on top. Swipe in from the left edge or tap the menu button.
 * Long press any row for its actions.
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { findNode, pathTo, useStore, walk } from '../../../src/store'
import type { TreeNode } from '../../../src/types'
import { Archive, Book, Chevron, Copy, File, Folder, Gear, Palette, Pencil, Plus, Search, Star, Trash, X } from '../../../src/components/Icons'
import { onBack, tick } from '../platform'
import { askConfirm, askText, showSheet, toast } from './overlays'
import { usePress } from './gestures'
import { useUi } from './state'
import { SyncDot } from './SyncDot'

export function notebookColor(tree: TreeNode[], id: string | null): string | undefined {
  if (!id) return undefined
  const path = pathTo(tree, id)
  for (let i = path.length - 1; i >= 0; i--) if (path[i].color) return path[i].color
  return undefined
}

export function Drawer() {
  const open = useUi((s) => s.drawer)
  const showArchived = useUi((s) => s.showArchived)
  const tree = useStore((s) => s.workspace.tree)
  const favorites = useStore((s) => s.workspace.favorites)
  const recent = useStore((s) => s.workspace.recent)
  const activePageId = useStore((s) => s.activePageId)
  const panel = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)

  const close = () => useUi.setState({ drawer: false })

  useEffect(() => {
    if (!open) return
    const off = onBack(() => {
      close()
      return true
    })
    // The open page's row comes into view.
    requestAnimationFrame(() => {
      const row = body.current?.querySelector('.m-row.active') as HTMLElement | null
      row?.scrollIntoView({ block: 'center' })
    })
    return off
  }, [open])

  // Swipe the drawer closed.
  const drag = useRef<{ x: number; y: number; dx: number; on: boolean } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    drag.current = { x: t.clientX, y: t.clientY, dx: 0, on: false }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current
    if (!d) return
    const t = e.touches[0]
    const dx = t.clientX - d.x
    if (!d.on && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(t.clientY - d.y) * 1.3 && dx < 0) {
      d.on = true
      panel.current?.classList.add('dragging')
    }
    if (d.on) {
      d.dx = Math.min(0, dx)
      if (panel.current) panel.current.style.transform = `translateX(${d.dx}px)`
    }
  }
  const onTouchEnd = () => {
    const d = drag.current
    drag.current = null
    if (!d?.on || !panel.current) return
    panel.current.classList.remove('dragging')
    panel.current.style.transform = ''
    if (d.dx < -70) close()
  }

  const openPath = useMemo(() => new Set(activePageId ? pathTo(tree, activePageId).map((n) => n.id) : []), [tree, activePageId])
  // Opening the drawer unfolds the way to the open page.
  useEffect(() => {
    if (!open || !activePageId) return
    for (const n of pathTo(useStore.getState().workspace.tree, activePageId).slice(0, -1)) if (n.collapsed) useStore.getState().toggleCollapse(n.id)
  }, [open, activePageId])

  const recents = useMemo(
    () =>
      (recent || [])
        .filter((id) => id !== activePageId)
        .map((id) => findNode(tree, id))
        .filter((n): n is TreeNode => Boolean(n && n.kind === 'page' && !n.archived))
        .slice(0, 10),
    [recent, tree, activePageId],
  )
  const favs = useMemo(
    () => (favorites || []).map((id) => findNode(tree, id)).filter((n): n is TreeNode => Boolean(n)),
    [favorites, tree],
  )

  return (
    <>
      <div className={`m-scrim ${open ? 'open' : ''}`} onClick={close} />
      <aside ref={panel} className={`m-drawer ${open ? 'open' : ''}`} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} aria-hidden={!open}>
        <div className="m-drawer-head">
          <h1>Notes</h1>
          <SyncDot asButton />
          <button className="m-icon" aria-label="Settings" onClick={() => useUi.setState({ screen: 'settings', drawer: false })}>
            <Gear />
          </button>
        </div>
        <button className="m-searchbox" onClick={() => useUi.setState({ screen: 'search', drawer: false })}>
          <Search />
          <span>Search all notes</span>
        </button>
        <div className="m-drawer-body" ref={body}>
          {recents.length > 0 && (
            <>
              <div className="m-label">Recent</div>
              <div className="m-recents">
                {recents.map((n) => (
                  <RecentChip key={n.id} node={n} tree={tree} />
                ))}
              </div>
            </>
          )}
          {favs.length > 0 && (
            <>
              <div className="m-label">Favorites</div>
              {favs.map((n) => (
                <Row key={'f' + n.id} node={n} depth={0} tree={tree} openPath={openPath} activePageId={activePageId} favorites={favorites} flat />
              ))}
            </>
          )}
          <div className="m-label">
            Notebooks
            <span className="spacer" />
            <button onClick={() => useUi.getState().setPrefs({ showArchived: !showArchived })}>{showArchived ? 'Hide archived' : 'Show archived'}</button>
          </div>
          {tree
            .filter((n) => showArchived || !n.archived)
            .map((n) => (
              <Row key={n.id} node={n} depth={0} tree={tree} openPath={openPath} activePageId={activePageId} favorites={favorites} />
            ))}
        </div>
        <div className="m-drawer-foot">
          <button
            onClick={() =>
              askText({
                title: 'New notebook',
                value: '',
                placeholder: 'Notebook name',
                ok: 'Create',
                onOk: async (name) => {
                  const id = await useStore.getState().addNode('notebook', null)
                  useStore.getState().renameNode(id, name)
                  useStore.setState({ renameNodeId: null })
                },
              })
            }
          >
            <Plus /> Notebook
          </button>
          <button onClick={() => newPageHere()}>
            <File /> New page
          </button>
        </div>
      </aside>
    </>
  )
}

function RecentChip({ node, tree }: { node: TreeNode; tree: TreeNode[] }) {
  const path = pathTo(tree, node.id)
  return (
    <button
      className="m-recent"
      style={{ ['--nb' as any]: notebookColor(tree, node.id) }}
      onClick={() => {
        useUi.setState({ drawer: false })
        useStore.getState().openPage(node.id)
      }}
    >
      <div>{node.title || 'Untitled'}</div>
      <small>{path.slice(0, -1).map((p) => p.title).join(' / ')}</small>
    </button>
  )
}

/** A new page in the section of the open page (or the first section). */
export async function newPageHere() {
  const st = useStore.getState()
  let parent: string | null = null
  if (st.activePageId) {
    const path = pathTo(st.workspace.tree, st.activePageId)
    parent = [...path].reverse().find((n) => n.kind === 'section')?.id ?? path[0]?.id ?? null
  }
  if (!parent) walk(st.workspace.tree, (n) => void (!parent && n.kind === 'section' && (parent = n.id)))
  useUi.setState({ drawer: false })
  const id = await st.addNode('page', parent)
  useStore.setState({ renameNodeId: null })
  return id
}

interface RowProps {
  node: TreeNode
  depth: number
  tree: TreeNode[]
  openPath: Set<string>
  activePageId: string | null
  favorites: string[]
  flat?: boolean
}

function Row({ node, depth, tree, openPath, activePageId, favorites, flat }: RowProps) {
  const showArchived = useUi((s) => s.showArchived)
  const kids = flat ? [] : (node.children || []).filter((c) => showArchived || !c.archived)
  const expanded = !flat && kids.length > 0 && !node.collapsed
  const isPage = node.kind === 'page'
  const active = isPage && node.id === activePageId
  const color = notebookColor(tree, node.id)
  const fav = favorites.includes(node.id)

  const press = usePress(
    () => {
      if (isPage) {
        useUi.setState({ drawer: false })
        if (!active) useStore.getState().openPage(node.id)
        return
      }
      tick()
      useStore.getState().toggleCollapse(node.id)
    },
    () => nodeActions(node, tree, fav),
  )

  const pageCount = !isPage ? countPages(node) : 0

  return (
    <>
      <button
        className={`m-row ${node.kind} ${active ? 'active' : ''} ${node.archived ? 'archived' : ''}`}
        style={{ ['--depth' as any]: depth, ['--nb' as any]: color }}
        {...press}
      >
        {!flat && (
          <span className={`chev ${expanded ? 'open' : ''}`} style={{ visibility: kids.length ? 'visible' : 'hidden' }}>
            <Chevron />
          </span>
        )}
        <span className="ic">{node.kind === 'notebook' ? <Book /> : node.kind === 'section' ? <Folder /> : <File />}</span>
        <span className="t">{node.title || 'Untitled'}</span>
        {fav && !flat && (
          <span className="fav">
            <Star />
          </span>
        )}
        {!isPage && pageCount > 0 && <span className="n">{pageCount}</span>}
      </button>
      {expanded &&
        kids.map((c) => <Row key={c.id} node={c} depth={depth + 1} tree={tree} openPath={openPath} activePageId={activePageId} favorites={favorites} />)}
    </>
  )
}

function countPages(n: TreeNode): number {
  let k = 0
  walk(n.children || [], (c) => void (c.kind === 'page' && !c.archived && k++))
  return k
}

const KIND_NAME = { notebook: 'notebook', section: 'section', page: 'page' }

export function nodeActions(node: TreeNode, tree: TreeNode[], fav: boolean) {
  const st = useStore.getState()
  const items = []
  if (node.kind === 'page') {
    items.push({
      label: 'Open in a new tab',
      icon: <Copy />,
      onClick: () => {
        useUi.setState({ drawer: false })
        st.newTab(node.id)
      },
    })
  }
  if (node.kind === 'notebook') {
    items.push({
      label: 'New section',
      icon: <Folder />,
      onClick: () =>
        askText({
          title: 'New section',
          value: '',
          placeholder: 'Section name',
          ok: 'Create',
          onOk: async (name) => {
            const id = await useStore.getState().addNode('section', node.id)
            useStore.getState().renameNode(id, name)
            useStore.setState({ renameNodeId: null })
          },
        }),
    })
  }
  if (node.kind !== 'notebook') {
    items.push({
      label: node.kind === 'page' ? 'New subpage' : 'New page here',
      icon: <Plus />,
      onClick: async () => {
        useUi.setState({ drawer: false })
        await useStore.getState().addNode('page', node.id)
        useStore.setState({ renameNodeId: null })
      },
    })
  }
  items.push({
    label: 'Rename',
    icon: <Pencil />,
    onClick: () =>
      askText({
        title: `Rename ${KIND_NAME[node.kind]}`,
        value: node.title,
        ok: 'Rename',
        onOk: (t) => useStore.getState().renameNode(node.id, t),
      }),
  })
  if (node.kind === 'page') {
    items.push({
      label: fav ? 'Remove from favorites' : 'Add to favorites',
      icon: <Star />,
      onClick: () => useStore.getState().toggleFavorite(node.id),
    })
    items.push({
      label: 'Move to another section',
      icon: <Folder />,
      onClick: () => pickSection(tree, node),
    })
  }
  items.push({
    label: node.archived ? 'Unarchive' : 'Archive',
    icon: <Archive />,
    onClick: () => {
      useStore.getState().archiveNode(node.id, !node.archived)
      toast(node.archived ? 'Unarchived' : 'Archived', { label: 'Undo', onClick: () => useStore.getState().archiveNode(node.id, Boolean(node.archived)) })
    },
  })
  items.push({
    label: 'Delete',
    icon: <Trash />,
    danger: true,
    onClick: () =>
      askConfirm({
        title: `Delete "${node.title || 'Untitled'}"?`,
        body:
          node.kind === 'page'
            ? 'The page is removed on every device. Old versions stay in the cloud history for 30 days.'
            : `Everything inside this ${KIND_NAME[node.kind]} is removed on every device. Old versions stay in the cloud history for 30 days.`,
        ok: 'Delete',
        danger: true,
        onOk: () => useStore.getState().deleteNode(node.id),
      }),
  })
  showSheet({
    title: node.title || 'Untitled',
    items,
    colors: node.kind !== 'page' ? { value: node.color || '', label: 'Color', current: node.color, onPick: (c) => useStore.getState().setNodeColor(node.id, c) } : undefined,
  })
}

function pickSection(tree: TreeNode[], page: TreeNode) {
  const sections: { node: TreeNode; path: string }[] = []
  const visit = (nodes: TreeNode[], trail: string[]) => {
    for (const n of nodes) {
      if (n.archived || n.id === page.id) continue
      if (n.kind === 'section') sections.push({ node: n, path: [...trail, n.title].join(' / ') })
      if (n.kind !== 'page') visit(n.children || [], [...trail, n.title])
    }
  }
  visit(tree, [])
  showSheet({
    title: `Move "${page.title}" to`,
    items: sections.map((s) => ({
      label: s.path,
      icon: <Folder />,
      onClick: () => {
        const target = s.node
        const last = (target.children || []).filter((c) => c.kind === 'page').pop()
        if (last) useStore.getState().moveNode(page.id, last.id, 'after')
        else useStore.getState().moveNode(page.id, target.id, 'inside')
        toast(`Moved to ${target.title}`)
      },
    })),
  })
}

export { X }
