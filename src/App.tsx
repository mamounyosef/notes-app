import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Canvas from './components/Canvas'
import { useActiveEditor } from './editor/activeEditor'
import ErrorBoundary from './components/ErrorBoundary'
import Toolbar from './components/Toolbar'
import Tree from './components/Tree'
import SearchModal from './components/SearchModal'
import SettingsModal from './components/SettingsModal'
import { findNode, pathTo, useStore, walk } from './store'
import { setPasteMode } from './editor/extensions'
import { isDesktop } from './lib/storage'
import type { TreeNode } from './types'
import {
  Book, File as FileIcon, Folder, Gear, Max, Min, PanelLeft, PanelMid, Plus, Search as SearchIcon,
  Star, X, ZoomIn, ZoomOut, Archive, Chevron
} from './components/Icons'

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const workspace = useStore((s) => s.workspace)
  const page = useStore((s) => s.page)
  const activePageId = useStore((s) => s.activePageId)
  const zoom = useStore((s) => s.zoom)
  const dirty = useStore((s) => s.dirty)

  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [showArchive, setShowArchive] = useState(false)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)

  useEffect(() => {
    init()
  }, [init])

  /* ---------- theme + typography as CSS variables ---------- */
  useEffect(() => {
    const root = document.documentElement
    const theme =
      settings.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : settings.theme
    root.dataset.theme = theme
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--font-body', settings.bodyFont)
    root.style.setProperty('--font-heading', settings.headingFont)
    root.style.setProperty('--font-mono', settings.monoFont)
    setPasteMode(settings.markdownPaste)
  }, [settings])

  /* ---------- keep the section pane in step with the open page ---------- */
  useEffect(() => {
    if (!activePageId) return
    const path = pathTo(workspace.tree, activePageId)
    const section = [...path].reverse().find((n) => n.kind === 'section')
    if (section) setActiveSectionId(section.id)
  }, [activePageId, workspace.tree])

  const activeSection = activeSectionId ? findNode(workspace.tree, activeSectionId) : null
  const pageRoots = useMemo(() => activeSection?.children.filter((c) => c.kind === 'page') ?? [], [activeSection])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 1700)
  }, [])

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const typing = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) ||
        (e.target as HTMLElement)?.isContentEditable

      if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setShowSearch(true); return }
      if (e.ctrlKey && e.key.toLowerCase() === 'p' && e.shiftKey) { e.preventDefault(); setShowSearch(true); return }
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); setShowSettings(true); return }
      if (e.key === 'F1') { e.preventDefault(); setShowKeys(true); return }
      if (e.ctrlKey && e.key === '1') { e.preventDefault(); setSettings({ sidebarVisible: !st.settings.sidebarVisible }); return }
      if (e.ctrlKey && e.key === '2') { e.preventDefault(); setSettings({ pagelistVisible: !st.settings.pagelistVisible }); return }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); st.setZoom(1); return }
      if (e.ctrlKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); st.setZoom(st.zoom + st.settings.zoomStep); return }
      if (e.ctrlKey && e.key === '-') { e.preventDefault(); st.setZoom(st.zoom - st.settings.zoomStep); return }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); st.save().then(() => flash('Saved')); return }
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); st.addCell(nextCellSpot()); return }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        st.addNode('page', activeSectionId)
        return
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'd' && !typing) { e.preventDefault(); st.duplicateCells(st.selection); return }

      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (typing) {
          const editor = useActiveEditor.getState().editor
          if (editor && editor.can().undo()) {
            editor.chain().undo().run()
            return
          }
        }
        st.undo()
        return
      }
      if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault()
        if (typing) {
          const editor = useActiveEditor.getState().editor
          if (editor && editor.can().redo()) {
            editor.chain().redo().run()
            return
          }
        }
        st.redo()
        return
      }

      if (typing) return

      if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); st.setSelection((st.page?.cells || []).map((c) => c.id)); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selection.length) { e.preventDefault(); st.deleteCells(st.selection); return }
      if (e.key === 'Escape') { st.setSelection([]); st.setTool('select'); return }

      if (!e.ctrlKey && !e.altKey) {
        const map: Record<string, () => void> = {
          v: () => st.setTool('select'),
          p: () => st.setTool(st.tool === 'pen' ? 'select' : 'pen'),
          h: () => st.setTool(st.tool === 'highlighter' ? 'select' : 'highlighter'),
          e: () => st.setTool(st.tool === 'eraser' ? 'select' : 'eraser'),
          s: () => st.setTool(st.tool === 'space' ? 'select' : 'space'),
        }
        const fn = map[e.key.toLowerCase()]
        if (fn) { fn(); return }
      }

      // Nudge the selected cells with the arrow keys.
      if (st.selection.length && e.key.startsWith('Arrow')) {
        e.preventDefault()
        const step = e.shiftKey ? st.settings.gridSize * 5 : st.settings.gridSize
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        st.updateCells(st.selection, (c) => ({ x: Math.max(0, c.x + dx), y: Math.max(0, c.y + dy) }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeSectionId, setSettings, flash])

  if (!ready) {
    return <div className="app" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)' }}>Loading your notes...</div>
  }

  const favoritePages = workspace.favorites
    .map((id) => findNode(workspace.tree, id))
    .filter(Boolean) as TreeNode[]

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">Notes</span>
        <button className="tb-btn" title="Show or hide the notebooks pane (Ctrl+1)" onClick={() => setSettings({ sidebarVisible: !settings.sidebarVisible })}><PanelLeft /></button>
        <button className="tb-btn" title="Show or hide the pages pane (Ctrl+2)" onClick={() => setSettings({ pagelistVisible: !settings.pagelistVisible })}><PanelMid /></button>
        <button className="tb-btn" title="Search (Ctrl+F)" onClick={() => setShowSearch(true)}><SearchIcon /> Search</button>
        <div className="spacer" />
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          {page ? pathTo(workspace.tree, page.id).map((n) => n.title).join('  /  ') : ''}
        </span>
        <div className="spacer" />
        <button className="tb-btn" title="Settings (Ctrl+,)" onClick={() => setShowSettings(true)}><Gear /></button>
        {isDesktop && (
          <>
            <button className="win-btn" onClick={() => (window as any).notes.win.minimize()}><Min /></button>
            <button className="win-btn" onClick={() => (window as any).notes.win.maximize()}><Max /></button>
            <button className="win-btn close" onClick={() => (window as any).notes.win.close()}><X /></button>
          </>
        )}
      </div>

      <div className="body">
        {settings.sidebarVisible && (
          <>
            <div className="pane" style={{ width: settings.sidebarWidth }}>
              <div className="pane-head">
                <Book size={13} /> Notebooks
                <div className="spacer" />
                <button className="tb-btn" title="New notebook" onClick={() => useStore.getState().addNode('notebook', null)}><Plus size={14} /></button>
              </div>
              <div className="pane-body">
                {favoritePages.length > 0 && (
                  <>
                    <div className="pane-head" style={{ padding: '4px 6px' }}><Star size={12} /> Favorites</div>
                    {favoritePages.map((p) => (
                      <div key={p.id} className={`row page ${activePageId === p.id ? 'active' : ''}`} onClick={() => useStore.getState().openPage(p.id)}>
                        <span className="twisty" />
                        <FileIcon size={14} />
                        <span className="label">{p.title}</span>
                      </div>
                    ))}
                    <div style={{ height: 8 }} />
                  </>
                )}
                {(() => {
                  const activeNotebooks = workspace.tree.filter((n) => !n.archived)
                  const archivedNotebooks = workspace.tree.filter((n) => n.archived)
                  return (
                    <>
                      <Tree
                        kinds={['notebook', 'section']}
                        roots={activeNotebooks}
                        activeId={activeSectionId}
                        onActivate={(n) => {
                          if (n.kind === 'section') {
                            setActiveSectionId(n.id)
                            const firstPage = n.children.find((c) => c.kind === 'page')
                            if (firstPage) useStore.getState().openPage(firstPage.id)
                          } else {
                            useStore.getState().toggleCollapse(n.id)
                          }
                        }}
                        emptyHint="No notebooks yet. Use the plus button above to make one."
                      />
                      <button className="add-row" onClick={() => useStore.getState().addNode('notebook', null)}>
                        <Plus size={14} /> New notebook
                      </button>
                      
                      {archivedNotebooks.length > 0 && (
                        <div style={{ marginTop: 24, borderTop: '1px solid var(--bg-3)' }}>
                          <button
                            className="pane-head"
                            style={{ width: '100%', padding: '8px 12px 4px', color: 'var(--text-faint)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', background: 'none', border: 'none', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                            onClick={() => setShowArchive(!showArchive)}
                          >
                            <div style={{ transition: 'transform 0.12s ease', display: 'flex', alignItems: 'center', transform: showArchive ? 'rotate(90deg)' : 'none' }}>
                              <Chevron size={12} />
                            </div>
                            <Archive size={12} />
                            Archived Notebooks
                          </button>
                          {showArchive && (
                            <Tree
                              kinds={['notebook', 'section']}
                              roots={archivedNotebooks}
                              activeId={activeSectionId}
                              onActivate={(n) => {
                                if (n.kind === 'section') {
                                  setActiveSectionId(n.id)
                                  const firstPage = n.children.find((c) => c.kind === 'page')
                                  if (firstPage) useStore.getState().openPage(firstPage.id)
                                } else {
                                  useStore.getState().toggleCollapse(n.id)
                                }
                              }}
                            />
                          )}
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            </div>
            <Resizer
              value={settings.sidebarWidth}
              min={150}
              max={460}
              onChange={(w) => setSettings({ sidebarWidth: w })}
              onDoubleClick={() => setSettings({ sidebarVisible: false })}
            />
          </>
        )}

        {settings.pagelistVisible && (
          <>
            <div className="pane pages" style={{ width: settings.pagelistWidth }}>
              <div className="pane-head">
                <Folder size={13} /> {activeSection?.title || 'Pages'}
                <div className="spacer" />
                <button
                  className="tb-btn"
                  title="New page (Ctrl+Shift+N)"
                  disabled={!activeSectionId}
                  onClick={() => useStore.getState().addNode('page', activeSectionId)}
                >
                  <Plus size={14} />
                </button>
              </div>
              <div className="pane-body">
                <Tree
                  kinds={['page']}
                  roots={pageRoots}
                  activeId={activePageId}
                  onActivate={(n) => useStore.getState().openPage(n.id)}
                  emptyHint={activeSection ? 'No pages in this section yet.' : 'Pick a section on the left.'}
                />
                {activeSectionId && (
                  <button className="add-row" onClick={() => useStore.getState().addNode('page', activeSectionId)}>
                    <Plus size={14} /> New page
                  </button>
                )}
              </div>
            </div>
            <Resizer
              value={settings.pagelistWidth}
              min={160}
              max={520}
              onChange={(w) => setSettings({ pagelistWidth: w })}
              onDoubleClick={() => setSettings({ pagelistVisible: false })}
            />
          </>
        )}

        <div className="main">
          <ErrorBoundary label="the toolbar"><Toolbar /></ErrorBoundary>
          <ErrorBoundary label="the page"><Canvas /></ErrorBoundary>
          {settings.showStatusBar && (
            <div className="statusbar">
              <span>{page ? `${page.cells.length} cells` : 'No page'}</span>
              <span>{dirty ? 'Saving...' : 'Saved'}</span>
              <div className="spacer" />
              <button title="Zoom out (Ctrl and minus)" onClick={() => useStore.getState().setZoom(zoom - settings.zoomStep)}><ZoomOut size={13} /></button>
              <button title="Reset zoom (Ctrl+0)" onClick={() => useStore.getState().setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button title="Zoom in (Ctrl and plus)" onClick={() => useStore.getState().setZoom(zoom + settings.zoomStep)}><ZoomIn size={13} /></button>
              <button title="Keyboard shortcuts (F1)" onClick={() => setShowKeys(true)}>Shortcuts</button>
            </div>
          )}
        </div>
      </div>

      {showSearch && <SearchModal onClose={() => setShowSearch(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showKeys && <ShortcutSheet onClose={() => setShowKeys(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

/** Place a new cell below whatever is already on the page. */
function nextCellSpot() {
  const st = useStore.getState()
  const cells = st.page?.cells || []
  if (!cells.length) return { x: 40, y: 120 }
  const bottom = Math.max(...cells.map((c) => c.y + c.h))
  const left = Math.min(...cells.map((c) => c.x))
  return { x: left, y: bottom + st.settings.cellGap }
}

function Resizer({
  value, min, max, onChange, onDoubleClick,
}: { value: number; min: number; max: number; onChange(v: number): void; onDoubleClick?(): void }) {
  const start = useRef<{ x: number; v: number } | null>(null)
  const [on, setOn] = useState(false)

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!start.current) return
      onChange(Math.min(max, Math.max(min, start.current.v + (e.clientX - start.current.x))))
    }
    const up = () => {
      if (!start.current) return
      start.current = null
      setOn(false)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [min, max, onChange])

  return (
    <div
      className={`resizer ${on ? 'dragging' : ''}`}
      title="Drag to resize. Double click to hide."
      onDoubleClick={onDoubleClick}
      onMouseDown={(e) => {
        start.current = { x: e.clientX, v: value }
        setOn(true)
        document.body.style.cursor = 'col-resize'
        e.preventDefault()
      }}
    />
  )
}

function ShortcutSheet({ onClose }: { onClose(): void }) {
  const rows: [string, string][] = [
    ['Ctrl F', 'Search everything'],
    ['Ctrl ,', 'Settings'],
    ['Ctrl Enter', 'New cell'],
    ['Ctrl Shift N', 'New page'],
    ['Ctrl D', 'Duplicate selected cells'],
    ['Delete', 'Delete selected cells'],
    ['Ctrl A', 'Select all cells'],
    ['Ctrl Z / Ctrl Y', 'Undo and redo'],
    ['Ctrl S', 'Save now'],
    ['Ctrl 1 / Ctrl 2', 'Show or hide the side panes'],
    ['Ctrl 0 / Ctrl + / Ctrl -', 'Zoom reset, in, out'],
    ['Ctrl wheel', 'Zoom the page'],
    ['Right mouse drag', 'Pan the page'],
    ['Arrow keys', 'Nudge selected cells by one grid step'],
    ['Shift arrows', 'Nudge by five grid steps'],
    ['V P H E S', 'Select, pen, highlighter, eraser, insert space'],
    ['Double click empty space', 'New cell there'],
    ['F2', 'Rename in the side panes'],
    ['$x$ or $$x$$', 'LaTeX while typing'],
    ['- or 1. or [] then space', 'Bullet, numbered and check lists'],
    ['# then space', 'Heading'],
  ]
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Keyboard and mouse</h2>
          <div className="spacer" />
          <button className="tb-btn" onClick={onClose}><X /></button>
        </div>
        <div className="modal-body">
          <div className="kbd-list">
            {rows.map(([k, v]) => (
              <div key={k}>
                <span>{v}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
