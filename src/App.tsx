import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Canvas from './components/Canvas'
import { useActiveEditor } from './editor/activeEditor'
import ErrorBoundary from './components/ErrorBoundary'
import Toolbar from './components/Toolbar'
import { nudgeInkSize } from './components/InkSizeControl'
import Tree, { CellCount } from './components/Tree'
import SearchModal from './components/SearchModal'
import TabStrip from './components/TabStrip'
import { useRunsSummary } from './components/agent/Sessions'
import SettingsModal from './components/SettingsModal'
import LinkModal from './components/LinkModal'
import ArtifactModal from './components/ArtifactModal'
import SyncPanel from './components/SyncPanel'
import { useCloudProblem } from './components/CloudSync'
import AgentPanel from './components/agent/AgentPanel'
import VoiceEngineChip from './components/voice/VoiceEngineChip'
import { useAgent } from './agent/store'
import { chatApi } from './agent/api'
import { trackPointer } from './agent/context'
import { askAboutSelection, trackSelection } from './agent/selection'
import { findNode, pathTo, useStore, walk } from './store'
import { setPasteMode } from './editor/extensions'
import { isDesktop, storage } from './lib/storage'
import type { TreeNode } from './types'
import {
  Book, File as FileIcon, Folder, Gear, Max, Min, PanelLeft, PanelMid, Plus, Search as SearchIcon,
  Star, X, ZoomIn, ZoomOut, Archive, Chevron, SidebarPeek, ArrowLeft, ArrowRight, SyncI, AssistantMark
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
  const canGoBack = useStore((s) => s.navBack.length > 0)
  const canGoForward = useStore((s) => s.navForward.length > 0)
  const syncCount = useStore((s) => s.conflicts.cells.length + s.conflicts.orphans.length)
  const cloudProblem = useCloudProblem()
  const chatSync = useAgent((s) => s.syncStatus)
  // Chat sync state, kept fresh even while the assistant panel is closed.
  useEffect(() => {
    chatApi.status().then((s) => useAgent.setState({ syncStatus: s })).catch(() => {})
    return chatApi.onStatus((s) => useAgent.setState({ syncStatus: s }))
  }, [])
  const syncError = useStore((s) => s.syncError)
  const syncProblem = syncError || cloudProblem || (chatSync?.phase === 'error' ? `Chat sync: ${chatSync.error}` : null)
  const showSyncPanel = useStore((s) => s.showSyncPanel)
  const fatal = useStore((s) => s.fatal)
  const agentOpen = useAgent((s) => s.prefs.open)

  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  // Other parts of the app (the voice dock) open Settings on a given tab.
  useEffect(() => {
    const open = (e: Event) => {
      setSettingsTab((e as CustomEvent).detail?.tab)
      setShowSettings(true)
    }
    window.addEventListener('notes:open-settings', open)
    return () => window.removeEventListener('notes:open-settings', open)
  }, [])
  const [showKeys, setShowKeys] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [showArchive, setShowArchive] = useState(false)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 1700)
  }, [])

  const linkModalOpen = useActiveEditor((s) => s.linkModalOpen)
  const setLinkModalOpen = useActiveEditor((s) => s.setLinkModalOpen)
  const artifactModalOpen = useActiveEditor((s) => s.artifactModalOpen)
  const setArtifactModalOpen = useActiveEditor((s) => s.setArtifactModalOpen)

  useEffect(() => {
    const handleAnchorClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest('a')
      if (!a) return
      const href = a.getAttribute('href')
      if (!href || href === '#' || href.startsWith('javascript:')) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      storage.openExternal(href)
    }
    document.addEventListener('click', handleAnchorClick, true)
    return () => document.removeEventListener('click', handleAnchorClick, true)
  }, [])

  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const flyoutOpenRef = useRef(false)
  flyoutOpenRef.current = flyoutOpen
  const flyoutRef = useRef<HTMLDivElement>(null)
  const flyoutCloseTimer = useRef<any>(null)
  const isResizingRef = useRef(false)

  const openFlyout = useCallback(() => {
    if (flyoutCloseTimer.current) {
      clearTimeout(flyoutCloseTimer.current)
      flyoutCloseTimer.current = null
    }
    setFlyoutOpen(true)
  }, [])

  const scheduleCloseFlyout = useCallback((delay = 200) => {
    if (isResizingRef.current) return
    if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current)
    flyoutCloseTimer.current = setTimeout(() => {
      // Picking a page for a new tab keeps the panes out.
      if (!isResizingRef.current && !pickingRef.current) {
        setFlyoutOpen(false)
      }
    }, delay)
  }, [])

  const cancelCloseFlyout = useCallback(() => {
    if (flyoutCloseTimer.current) {
      clearTimeout(flyoutCloseTimer.current)
      flyoutCloseTimer.current = null
    }
  }, [])

  const handleResizerDrag = useCallback((dragging: boolean, e?: MouseEvent) => {
    isResizingRef.current = dragging
    if (dragging) {
      cancelCloseFlyout()
    } else {
      // If cursor is still within the flyout bounds, keep it open!
      if (e && flyoutRef.current) {
        const rect = flyoutRef.current.getBoundingClientRect()
        const isInside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right + 10 &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        if (isInside) {
          cancelCloseFlyout()
          return
        }
      }
      scheduleCloseFlyout(200)
    }
  }, [cancelCloseFlyout, scheduleCloseFlyout])

  const toggleAutoHide = useCallback(() => {
    const next = !settings.autoHidePanes
    if (next && !settings.sidebarVisible && !settings.pagelistVisible) {
      setSettings({ autoHidePanes: true, sidebarVisible: true, pagelistVisible: true })
    } else {
      setSettings({ autoHidePanes: next })
    }
    flash(next ? 'Auto-hide enabled: hover left edge to reveal' : 'Side panes pinned')
  }, [settings.autoHidePanes, settings.sidebarVisible, settings.pagelistVisible, setSettings, flash])

  useEffect(() => {
    if (showSearch || showSettings) {
      setFlyoutOpen(false)
    }
  }, [showSearch, showSettings])

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => trackPointer(), [])
  useEffect(() => trackSelection(), [])

  /* ---------- mouse back / forward side buttons (buttons 3 and 4) ---------- */
  useEffect(() => {
    // Block the default browser history action and the canvas handlers.
    // Navigation runs on pointerup: cancelling pointerdown suppresses the
    // compatibility mouseup, so a mouseup listener would never fire.
    const swallow = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      e.stopPropagation()
      // Over the assistant it moves through the chats opened there, like a browser.
      if ((e.target as Element | null)?.closest?.('.agent-panel')) {
        const ag = useAgent.getState()
        if (e.button === 3) ag.chatBack()
        else ag.chatForward()
        return
      }
      const st = useStore.getState()
      if (e.button === 3) st.goBack()
      else st.goForward()
    }
    window.addEventListener('mousedown', swallow, true)
    window.addEventListener('pointerdown', swallow, true)
    window.addEventListener('auxclick', swallow, true)
    window.addEventListener('mouseup', swallow, true)
    window.addEventListener('pointerup', onUp, true)
    return () => {
      window.removeEventListener('mousedown', swallow, true)
      window.removeEventListener('pointerdown', swallow, true)
      window.removeEventListener('auxclick', swallow, true)
      window.removeEventListener('mouseup', swallow, true)
      window.removeEventListener('pointerup', onUp, true)
    }
  }, [])

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
  // Only when the open page (or the section holding it) changes, so browsing
  // another section is not undone by unrelated tree edits.
  const openPageSection = useMemo(() => {
    if (!activePageId) return null
    const path = pathTo(workspace.tree, activePageId)
    return [...path].reverse().find((n) => n.kind === 'section')?.id ?? null
  }, [activePageId, workspace.tree])
  useEffect(() => {
    if (openPageSection) setActiveSectionId(openPageSection)
  }, [activePageId, openPageSection])

  const activeSection = activeSectionId ? findNode(workspace.tree, activeSectionId) : null
  const pageRoots = useMemo(() => activeSection?.children.filter((c) => c.kind === 'page') ?? [], [activeSection])


  /**
   * New tab: shows the page panes and the next page clicked opens in a new
   * tab (the same page again works too). Panes hidden before go back after.
   */
  const pickingTab = useStore((s) => s.pickingTab)
  const pickingRef = useRef(false)
  pickingRef.current = pickingTab
  const panesBefore = useRef<{ sidebarVisible: boolean; pagelistVisible: boolean } | null>(null)
  const openNewTab = useCallback(() => {
    const st = useStore.getState()
    if (st.pickingTab) return st.openNextInNewTab(false)
    st.openNextInNewTab(true)
    const s = st.settings
    if (s.autoHidePanes) openFlyout()
    else if (!s.sidebarVisible || !s.pagelistVisible) {
      panesBefore.current = { sidebarVisible: s.sidebarVisible, pagelistVisible: s.pagelistVisible }
      st.setSettings({ sidebarVisible: true, pagelistVisible: true })
    }
  }, [openFlyout])
  useEffect(() => {
    if (pickingTab) return
    if (panesBefore.current) {
      useStore.getState().setSettings(panesBefore.current)
      panesBefore.current = null
    }
    if (useStore.getState().settings.autoHidePanes) setFlyoutOpen(false)
  }, [pickingTab])

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const typing = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) ||
        (e.target as HTMLElement)?.isContentEditable

      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); st.goBack(); return }
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); st.goForward(); return }
      if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setShowSearch(true); return }
      if (e.ctrlKey && e.key.toLowerCase() === 'p' && e.shiftKey) { e.preventDefault(); setShowSearch(true); return }
      if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); useActiveEditor.getState().setLinkModalOpen(true); return }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); useActiveEditor.getState().setArtifactModalOpen(true); return }
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); setSettingsTab(undefined); setShowSettings(true); return }
      // Voice mode on or off, from anywhere (opens the assistant).
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'Space' || e.key === ' ')) { e.preventDefault(); useAgent.getState().requestVoice(); return }
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (e.shiftKey) { useAgent.getState().toggle(true); useAgent.getState().newChat() }
        else useAgent.getState().toggle()
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); askAboutSelection(); return }
      if (e.ctrlKey && e.key === '1') { e.preventDefault(); setSettings({ sidebarVisible: !st.settings.sidebarVisible }); return }
      if (e.ctrlKey && e.key === '2') { e.preventDefault(); setSettings({ pagelistVisible: !st.settings.pagelistVisible }); return }
      if (e.ctrlKey && e.key === '3') {
        e.preventDefault()
        const next = !st.settings.autoHidePanes
        if (next && !st.settings.sidebarVisible && !st.settings.pagelistVisible) {
          setSettings({ autoHidePanes: true, sidebarVisible: true, pagelistVisible: true })
        } else {
          setSettings({ autoHidePanes: next })
        }
        flash(next ? 'Auto-hide enabled: hover left edge to reveal' : 'Side panes pinned')
        return
      }
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
      if (e.key === 'Escape') {
        if (flyoutOpenRef.current) {
          setFlyoutOpen(false)
          return
        }
        st.setSelection([])
        st.setTool('select')
        return
      }

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
        if (e.key === '[' || e.key === ']') {
          const size = nudgeInkSize(e.key === ']' ? 1 : -1)
          if (size !== null) { e.preventDefault(); flash(`${st.tool === 'pen' ? 'Pen' : 'Highlighter'} thickness: ${size}px`) }
          return
        }
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
  if (fatal) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', padding: 40, textAlign: 'center', color: 'var(--text)' }}>
        <div style={{ maxWidth: 520 }}>{fatal}</div>
      </div>
    )
  }

  const favoritePages = workspace.favorites
    .map((id) => findNode(workspace.tree, id))
    .filter(Boolean) as TreeNode[]

  const sidePanes = (
    <>
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
                      <CellCount pageId={p.id} />
                    </div>
                  ))}
                  <div style={{ height: 8 }} />
                </>
              )}
              {(() => {
                const activeNotebooks = workspace.tree.filter((n) => !n.archived)
                const holds = (n: TreeNode): boolean => Boolean(n.archived) || n.children.some(holds)
                const archivedNotebooks = workspace.tree.filter(holds)
                return (
                  <>
                    <Tree
                      kinds={['notebook', 'section']}
                      roots={activeNotebooks}
                      activeId={activeSectionId}
                      onActivate={(n) => {
                        if (n.kind === 'section') {
                          setActiveSectionId(n.id)
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
                          Archive
                        </button>
                        {showArchive && (
                          <Tree
                            archive
                            kinds={['notebook', 'section', 'page']}
                            roots={archivedNotebooks}
                            activeId={activePageId}
                            onActivate={(n) => {
                              if (n.kind === 'page') useStore.getState().openPage(n.id)
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
            onDragChange={handleResizerDrag}
          />
        </>
      )}

      {settings.pagelistVisible && (
        <>
          <div className="pane pages" style={{ width: settings.pagelistWidth }}>
            {pickingTab && (
              <div className="pick-hint">
                Click a page to open it in a new tab
                <button onClick={() => useStore.getState().openNextInNewTab(false)}>Cancel (Esc)</button>
              </div>
            )}
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
            <div className={`pane-body${pageRoots.length <= 5 ? ' few-pages' : ''}`}>
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
            onDragChange={handleResizerDrag}
          />
        </>
      )}
    </>
  )

  return (
    <div className={`app ${pickingTab ? 'picking-tab' : ''}`}>
      <div className="titlebar">
        <button className="tb-btn" title="Back (Alt+Left, mouse back button)" disabled={!canGoBack} onClick={() => useStore.getState().goBack()}><ArrowLeft /></button>
        <button className="tb-btn" title="Forward (Alt+Right, mouse forward button)" disabled={!canGoForward} onClick={() => useStore.getState().goForward()}><ArrowRight /></button>
        <span className="brand">Notes</span>
        <button className="tb-btn" title="Show or hide the notebooks pane (Ctrl+1)" onClick={() => setSettings({ sidebarVisible: !settings.sidebarVisible })}><PanelLeft /></button>
        <button className="tb-btn" title="Show or hide the pages pane (Ctrl+2)" onClick={() => setSettings({ pagelistVisible: !settings.pagelistVisible })}><PanelMid /></button>
        <button
          className={`tb-btn ${settings.autoHidePanes ? 'on' : ''}`}
          title={settings.autoHidePanes ? 'Auto-hide side panes is ON (hover left edge to reveal, click to pin) — Ctrl+3' : 'Auto-hide side panes (hover left edge to reveal) — Ctrl+3'}
          onClick={toggleAutoHide}
        >
          <SidebarPeek />
        </button>
        <button className="tb-btn" title="Search (Ctrl+F)" onClick={() => setShowSearch(true)}><SearchIcon /> Search</button>
        <TabStrip onNewTab={openNewTab} />
        <span className="tb-path" title={page ? pathTo(workspace.tree, page.id).map((n) => n.title).join('  /  ') : ''}>
          {page ? pathTo(workspace.tree, page.id).slice(0, -1).map((n) => n.title).join('  /  ') : ''}
        </span>
        {(syncCount > 0 || syncProblem) && (
          <button
            className={`tb-btn sync-alert ${syncProblem ? 'error' : ''}`}
            title={syncProblem || `${syncCount} sync ${syncCount === 1 ? 'item needs' : 'items need'} your attention`}
            onClick={() => useStore.getState().setShowSyncPanel(true)}
          >
            <SyncI />
            {syncCount > 0 && <span className="sync-count">{syncCount}</span>}
          </button>
        )}
        <div className="zoom-pill" title="Page zoom">
          <button title="Zoom out (Ctrl and minus)" onClick={() => useStore.getState().setZoom(zoom - settings.zoomStep)}><ZoomOut size={15} /></button>
          <button className={`zoom-pct ${Math.abs(zoom - 1) < 0.001 ? '' : 'changed'}`} title="Reset to 100% (Ctrl+0)" onClick={() => useStore.getState().setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button title="Zoom in (Ctrl and plus)" onClick={() => useStore.getState().setZoom(zoom + settings.zoomStep)}><ZoomIn size={15} /></button>
        </div>
        <VoiceEngineChip />
        <AssistantButton open={agentOpen} />
        <button className="tb-btn" title="Settings (Ctrl+,)" onClick={() => setShowSettings(true)}><Gear /></button>
        {isDesktop && (
          <>
            <button className="win-btn" onClick={() => (window as any).notes.win.minimize()}><Min /></button>
            <button className="win-btn" onClick={() => (window as any).notes.win.maximize()}><Max /></button>
            <button className="win-btn close" onClick={() => (window as any).notes.win.close()}><X /></button>
          </>
        )}
      </div>

      <div
        className="body"
        onMouseMove={(e) => {
          if (settings.autoHidePanes && !flyoutOpen && e.clientX <= 14) {
            openFlyout()
          }
        }}
      >
        {!settings.autoHidePanes ? (
          sidePanes
        ) : (
          <>
            <div
              className="sidebar-hover-zone"
              title="Move mouse here to reveal Notebook and Pages"
              onMouseEnter={openFlyout}
              onMouseMove={openFlyout}
            />
            <div
              ref={flyoutRef}
              className={`sidebar-flyout ${flyoutOpen ? 'open' : ''}`}
              onMouseEnter={cancelCloseFlyout}
              onMouseLeave={() => scheduleCloseFlyout(200)}
            >
              {sidePanes}
            </div>
          </>
        )}

        <div
          className="main"
          onClick={() => {
            if (settings.autoHidePanes && flyoutOpen) {
              setFlyoutOpen(false)
            }
          }}
        >
          <ErrorBoundary label="the toolbar"><Toolbar /></ErrorBoundary>
          <ErrorBoundary label="the page"><Canvas /></ErrorBoundary>
          {settings.showStatusBar && (
            <div className="statusbar">
              <span>{page ? `${page.cells.length} cells` : 'No page'}</span>
              <span className={syncError ? 'status-error' : ''}>{syncError ? 'Not saved yet, retrying' : dirty ? 'Saving...' : 'Saved'}</span>
              <div className="spacer" />
              <button title="Keyboard shortcuts" onClick={() => setShowKeys(true)}>Shortcuts</button>
            </div>
          )}
        </div>
        {agentOpen && <ErrorBoundary label="the assistant"><AgentPanel /></ErrorBoundary>}
      </div>

      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
        />
      )}
      {showSettings && <SettingsModal initialTab={settingsTab} onClose={() => setShowSettings(false)} />}
      {showSyncPanel && <SyncPanel onClose={() => useStore.getState().setShowSyncPanel(false)} />}
      {showKeys && <ShortcutSheet onClose={() => setShowKeys(false)} />}
      {linkModalOpen && <LinkModal onClose={() => setLinkModalOpen(false)} />}
      {artifactModalOpen && <ArtifactModal onClose={() => setArtifactModalOpen(false)} />}
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
  value, min, max, onChange, onDoubleClick, onDragChange,
}: { value: number; min: number; max: number; onChange(v: number): void; onDoubleClick?(): void; onDragChange?(dragging: boolean, e?: MouseEvent): void }) {
  const start = useRef<{ x: number; v: number } | null>(null)
  const [on, setOn] = useState(false)

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!start.current) return
      onChange(Math.min(max, Math.max(min, start.current.v + (e.clientX - start.current.x))))
    }
    const up = (e: MouseEvent) => {
      if (!start.current) return
      start.current = null
      setOn(false)
      onDragChange?.(false, e)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [min, max, onChange, onDragChange])

  return (
    <div
      className={`resizer ${on ? 'dragging' : ''}`}
      title="Drag to resize. Double click to hide."
      onDoubleClick={onDoubleClick}
      onMouseDown={(e) => {
        start.current = { x: e.clientX, v: value }
        setOn(true)
        onDragChange?.(true, e.nativeEvent)
        document.body.style.cursor = 'col-resize'
        e.preventDefault()
      }}
    />
  )
}

/** The Assistant button, with a count of chats waiting on you and a ring while any chat works. */
function AssistantButton({ open }: { open: boolean }) {
  const { attention, working, asking } = useRunsSummary(!open)
  const parts = [
    asking ? `${asking} with a question for you` : '',
    attention - asking ? `${attention - asking} with news` : '',
    working ? `${working} working` : '',
  ].filter(Boolean)
  return (
    <button
      className={`tb-btn agent-toggle ${open ? 'on' : ''} ${working ? 'working' : ''}`}
      title={`Assistant (Ctrl+J). Ctrl+L asks about the selection.${parts.length ? `\nChats: ${parts.join(', ')}` : ''}`}
      onClick={() => useAgent.getState().toggle()}
    >
      <AssistantMark size={17} /> Assistant
      {attention > 0 && <span className={`agent-badge ${asking ? 'asking' : ''}`}>{attention}</span>}
    </button>
  )
}

function ShortcutSheet({ onClose }: { onClose(): void }) {
  const rows: [string, string][] = [
    ['Alt Left / Alt Right', 'Back and forward between pages (also mouse side buttons)'],
    ['Ctrl F', 'Search everything'],
    ['Ctrl T', 'New tab (pick a page); Ctrl or middle click a page opens it in a new tab'],
    ['Ctrl Tab / Ctrl Shift Tab', 'Next or previous tab (each keeps its scroll spot)'],
    ['Ctrl W / Ctrl Shift T', 'Close the tab / reopen the last closed tab'],
    ['Ctrl K', 'Insert or edit link'],
    ['Ctrl Shift A', 'Insert or edit artifact (folder or file link)'],
    ['Ctrl ,', 'Settings'],
    ['Ctrl J', 'Show or hide the assistant'],
    ['Ctrl Shift J', 'New assistant chat'],
    ['Ctrl L', 'Ask the assistant about the selection'],
    ['Ctrl Enter', 'New cell'],
    ['Ctrl Shift N', 'New page'],
    ['Ctrl D', 'Duplicate selected cells'],
    ['Delete', 'Delete selected cells'],
    ['Ctrl A', 'Select all cells'],
    ['Ctrl Z / Ctrl Y', 'Undo and redo'],
    ['Ctrl S', 'Save now'],
    ['Ctrl 1 / Ctrl 2', 'Show or hide the side panes'],
    ['Ctrl 3', 'Toggle auto-hide side panes (hover to reveal)'],
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
