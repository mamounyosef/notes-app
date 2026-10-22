import React, { useEffect, useMemo, useRef, useState } from 'react'
import { findNode, pathTo, useStore, type PageTab } from '../store'
import { Menu, type MenuItem } from './Menu'
import { Chevron, Copy, Plus, Star, X } from './Icons'

/** Colors for notebooks that have none of their own, picked by notebook so it never changes. */
/** Colors offered for a tab (the same as for notebooks). */
const TAB_COLORS = ['#7c9cff', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#c678dd', '#f06292', '#a5a5a5']

const PALETTE = ['#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#e06c75', '#d19a66', '#7aa2f7']

function hashColor(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

interface TabView {
  tab: PageTab
  title: string
  path: string
  notebookId: string
  color: string
}

/**
 * Page tabs, like a browser's. Tabs from the same notebook share its color
 * and sit joined by one colored line, so groups are easy to spot. Each tab
 * keeps its own back/forward history and the exact spot it was scrolled to.
 *
 * Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+PageDown / PageUp) move between tabs,
 * Ctrl+T opens a page in a new tab, Ctrl+W closes, Ctrl+Shift+T reopens.
 * Middle click closes; drag to reorder; right click for more.
 */
export default function TabStrip({ onNewTab }: { onNewTab(): void }) {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const tree = useStore((s) => s.workspace.tree)
  const picking = useStore((s) => s.pickingTab)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const strip = useRef<HTMLDivElement>(null)

  const views: TabView[] = useMemo(
    () =>
      tabs.map((tab) => {
        const path = pathTo(tree, tab.pageId)
        const notebook = path[0]
        const page = findNode(tree, tab.pageId)
        return {
          tab,
          title: page?.title || 'Untitled',
          path: path.map((n) => n.title).join('  ›  '),
          notebookId: notebook?.id || '',
          color: tab.color || notebook?.color || (notebook ? hashColor(notebook.id) : 'var(--accent)'),
        }
      }),
    [tabs, tree],
  )

  /* ---------- keys ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      if (e.key === 'Escape' && st.pickingTab) {
        st.openNextInNewTab(false)
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (e.key === 'Tab') st.cycleTab(e.shiftKey ? -1 : 1)
      else if (e.key === 'PageDown' && !e.shiftKey) st.cycleTab(1)
      else if (e.key === 'PageUp' && !e.shiftKey) st.cycleTab(-1)
      else if (k === 't' && e.shiftKey) st.reopenClosedTab()
      else if (k === 't') onNewTab()
      else if (k === 'w' && !e.shiftKey) st.closeTab(st.activeTab)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onNewTab])

  /* ---------- keep the active tab in view ---------- */
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-tab="${activeTab}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [activeTab, tabs.length])

  /* ---------- the wheel scrolls a crowded strip sideways ---------- */
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY || e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const st = () => useStore.getState()
  const tabMenu = (v: TabView, i: number): MenuItem[] => {
    const id = v.tab.id
    const only = tabs.length < 2
    return [
      { label: 'New tab', hint: 'Ctrl+T', icon: <Plus />, onClick: onNewTab },
      { label: 'Duplicate tab', icon: <Copy />, onClick: () => st().duplicateTab(id) },
      { label: v.tab.pinned ? 'Unpin tab' : 'Pin tab', icon: <Star />, onClick: () => st().pinTab(id, !v.tab.pinned) },
      { separator: true },
      { title: 'Tab color' },
      {
        icon: (
          <div className="swatches tab-swatches">
            {TAB_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${v.color === c ? 'on' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={(e) => {
                  e.stopPropagation()
                  st().setTabColor(id, c)
                  setMenu(null)
                }}
              />
            ))}
          </div>
        ),
      },
      ...(v.tab.color
        ? [
            { label: 'Back to the notebook color', onClick: () => st().setTabColor(id, null) },
            ...(v.notebookId
              ? [{ label: 'Use this color for the whole notebook', onClick: () => {
                  st().setNodeColor(v.notebookId, v.tab.color!)
                  st().setTabColor(id, null)
                } }]
              : []),
          ]
        : []),
      { separator: true },
      ...(only ? [] : [{ label: 'Close tab', hint: 'Ctrl+W', icon: <X />, onClick: () => st().closeTab(id) }]),
      ...(tabs.some((t) => t.id !== id && !t.pinned) ? [{ label: 'Close other tabs', onClick: () => st().closeOtherTabs(id) }] : []),
      ...(i < tabs.length - 1 ? [{ label: 'Close tabs to the right', onClick: () => st().closeTabsToRight(id) }] : []),
      { separator: true },
      { label: 'Reopen closed tab', hint: 'Ctrl+Shift+T', onClick: () => st().reopenClosedTab() },
    ]
  }

  const allTabsMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: views.map((v) => ({
        label: v.title,
        hint: v.path.split('  ›  ')[0],
        icon: <span className="tab-menu-dot" style={{ background: v.color }} />,
        onClick: () => st().switchTab(v.tab.id),
      })),
    })
  }

  // While a page is being picked for a new tab, it shows where the tab will go.
  const placeholder = (
    <div key="picking" className="tab picking" title="Click a page on the left to open it here (Esc cancels)">
      <span className="tab-dot" />
      <span className="tab-title">Pick a page...</span>
      <button className="tab-x" title="Cancel (Esc)" onClick={() => st().openNextInNewTab(false)}>
        <X size={11} />
      </button>
    </div>
  )

  return (
    <div className="tabbar">
      <div
        ref={strip}
        className="tabs"
        onDoubleClick={(e) => e.target === e.currentTarget && onNewTab()}
        onAuxClick={(e) => e.button === 1 && e.target === e.currentTarget && onNewTab()}
      >
        {views.map((v, i) => {
          const prev = views[i - 1]
          const next = views[i + 1]
          // Neighbors from one notebook, in one color, read as a group.
          const joinL = Boolean(prev && prev.notebookId === v.notebookId && v.notebookId && prev.color === v.color)
          const joinR = Boolean(next && next.notebookId === v.notebookId && v.notebookId && next.color === v.color)
          const active = v.tab.id === activeTab
          return (
            <div
              key={v.tab.id}
              data-tab={v.tab.id}
              className={[
                'tab',
                active ? 'active' : '',
                v.tab.pinned ? 'pinned' : '',
                v.tab.fresh ? 'fresh' : '',
                joinL ? 'join-l' : '',
                joinR ? 'join-r' : '',
                dragId === v.tab.id ? 'dragging' : '',
                drop?.id === v.tab.id ? (drop.after ? 'drop-after' : 'drop-before') : '',
              ].join(' ')}
              style={{ ['--c' as any]: v.color }}
              title={`${v.path}${tabs.length > 1 ? '\nCtrl+Tab next tab, middle click closes' : ''}`}
              draggable
              onPointerDown={(e) => {
                // Pointer down, not click: switching feels instant, like a browser.
                if (e.button === 0) st().switchTab(v.tab.id)
              }}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                st().closeTab(v.tab.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, items: tabMenu(v, i) })
              }}
              onDragStart={(e) => {
                setDragId(v.tab.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/x-notes-tab', v.tab.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setDrop(null)
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === v.tab.id) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const after = e.clientX > r.left + r.width / 2
                if (drop?.id !== v.tab.id || drop.after !== after) setDrop({ id: v.tab.id, after })
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (!dragId || !drop) return
                const from = tabs.findIndex((t) => t.id === dragId)
                let to = tabs.findIndex((t) => t.id === drop.id) + (drop.after ? 1 : 0)
                if (from < to) to--
                st().moveTab(dragId, to)
                setDragId(null)
                setDrop(null)
              }}
            >
              {v.tab.pinned ? (
                <span className="tab-badge">{v.title.trim().charAt(0).toUpperCase() || '·'}</span>
              ) : (
                <>
                  <span className="tab-dot" />
                  <span className="tab-title">{v.title}</span>
                  {tabs.length > 1 && (
                    <button
                      className="tab-x"
                      title="Close tab (Ctrl+W)"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        st().closeTab(v.tab.id)
                      }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </>
              )}
            </div>
          )
        }).flatMap((el, i) => (picking && views[i].tab.id === activeTab ? [el, placeholder] : [el]))}
      </div>
      <button className={`tab-new ${picking ? 'on' : ''}`} title={picking ? 'Cancel the new tab (Esc)' : 'New tab: pick a page on the left (Ctrl+T)'} onClick={onNewTab}>
        <Plus size={14} />
      </button>
      {tabs.length > 2 && (
        <button className="tab-new" title="All tabs" onClick={allTabsMenu}>
          <Chevron size={12} className="tab-all" />
        </button>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
