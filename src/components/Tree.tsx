import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { TreeNode } from '../types'
import { Menu, type MenuItem } from './Menu'
import { Chevron, File, Folder, Book, Plus, Star, Trash, Copy, Palette } from './Icons'

const NODE_COLORS = ['#7c9cff', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#c678dd', '#f06292', '#a5a5a5']

interface Props {
  /** Which kinds this pane shows. Notebooks pane hides pages, page pane shows only pages. */
  kinds: TreeNode['kind'][]
  roots: TreeNode[]
  activeId: string | null
  onActivate(node: TreeNode): void
  emptyHint?: string
}

export default function Tree({ kinds, roots, activeId, onActivate, emptyHint }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' | 'inside' } | null>(null)
  const dragId = useRef<string | null>(null)
  const st = useStore

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
      ...(n.kind === 'page'
        ? [
            {
              label: s.workspace.favorites.includes(n.id) ? 'Remove from favorites' : 'Add to favorites',
              icon: <Star />,
              onClick: () => s.toggleFavorite(n.id),
            },
            { label: 'Copy page as Markdown', icon: <Copy />, onClick: () => copyPageMarkdown(n.id) },
            { label: 'Export page as Markdown file', onClick: () => exportPageMarkdown(n.id, n.title) },
          ]
        : []),
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
        onClick: () => {
          const hasKids = n.children.length > 0
          if (
            !st.getState().settings.confirmDelete ||
            window.confirm(`Delete "${n.title}"${hasKids ? ' and everything inside it' : ''}?`)
          ) {
            s.deleteNode(n.id)
          }
        },
      },
    ]
  }

  const renderNode = (n: TreeNode, depth: number): React.ReactNode => {
    if (!kinds.includes(n.kind)) return null
    const children = n.children.filter((c) => kinds.includes(c.kind))
    const open = !n.collapsed
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
          ].join(' ')}
          style={{ paddingLeft: 6 + depth * 13, ['--node-color' as any]: n.color || 'var(--accent)' }}
          onClick={() => onActivate(n)}
          onDoubleClick={() => setRenaming(n.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n) })
          }}
          draggable={renaming !== n.id}
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
                st.getState().toggleCollapse(n.id)
              }}
            >
              <Chevron size={13} />
            </span>
          ) : (
            <span className="twisty" />
          )}

          {n.kind === 'notebook' ? <span className="dot" /> : <Icon size={14} />}

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
        </div>

        {open && children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const visible = roots.filter((r) => kinds.includes(r.kind))

  return (
    <>
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
  const page = await storage.readPage(pageId)
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

async function exportPageMarkdown(pageId: string, title: string) {
  const { storage } = await import('../lib/storage')
  await storage.exportFile(`${title.replace(/[\\/:*?"<>|]/g, '_')}.md`, await pageMarkdown(pageId))
}
