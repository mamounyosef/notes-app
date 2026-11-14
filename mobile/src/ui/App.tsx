/** The phone app's frame: top bar, tabs, page, drawer and the screens over it. */
import React, { useEffect, useRef, useState } from 'react'
import { flushAll, pathTo, useStore } from '../../../src/store'
import {
  Book,
  Copy,
  DrawI,
  File,
  Folder,
  Layers,
  Pencil,
  Plus,
  Redo,
  Search,
  Star,
  Trash,
  Undo,
  X,
  ArrowLeft,
  ArrowRight,
} from '../../../src/components/Icons'
import { cloud, warmSearch } from '../sync/backend'
import { initPlatform, onBack, themeStatusBar, tick, trackKeyboard } from '../platform'
import { startUpdater, useUpdate } from '../update/updater'
import { Drawer, newPageHere, nodeActions, notebookColor } from './Drawer'
import { FormatBar } from './FormatBar'
import { Overlays, showSheet, toast } from './overlays'
import { PageView, preloadEditor, stopEditing } from './PageView'
import { SearchScreen } from './SearchScreen'
import { SettingsScreen } from './SettingsScreen'
import { useUi } from './state'
import { SyncDot, useCloud } from './SyncDot'
import { FirstSync, LoginScreen, restoreSession, useSession } from './Login'
import * as idb from '../sync/idb'

const MenuI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
)
const DotsI = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="5" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="12" cy="19" r="1.8" />
  </svg>
)
const FlowI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="4" y="3" width="16" height="7" rx="2" />
    <rect x="4" y="14" width="16" height="7" rx="2" />
  </svg>
)
const CanvasI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="3" y="3" width="10" height="8" rx="2" />
    <rect x="15" y="6" width="6" height="12" rx="2" />
    <rect x="3" y="14" width="9" height="7" rx="2" />
  </svg>
)

/* ---------------- theme ---------------- */

function useTheme() {
  const settings = useStore((s) => s.settings)
  const override = useUi((s) => s.theme)
  useEffect(() => {
    const root = document.documentElement
    const want = override || settings.theme
    const theme = want === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : want
    root.dataset.theme = theme
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--font-body', settings.bodyFont)
    root.style.setProperty('--font-heading', settings.headingFont)
    root.style.setProperty('--font-mono', settings.monoFont)
    const bar = getComputedStyle(root).getPropertyValue('--bg-1').trim() || '#202020'
    themeStatusBar(!['light', 'sepia'].includes(theme), bar)
  }, [settings, override])
}

/* ---------------- app ---------------- */

export function App() {
  const session = useSession((s) => s.phase)
  const ready = useStore((s) => s.ready)
  const cloudState = useCloud()
  const [hasLocal, setHasLocal] = useState<boolean | null>(null)
  useTheme()

  useEffect(() => {
    trackKeyboard()
    initPlatform({
      onPause() {
        flushAll().catch(() => {})
        cloud.setActive(false)
      },
      onResume() {
        cloud.setActive(true)
        useUpdate.getState().check()
      },
      fallbackBack() {
        const st = useStore.getState()
        if (st.navBack.length) {
          st.goBack()
          return true
        }
        return false
      },
    })
    idb.persist()
    idb.get('docs', 'workspace:').then((w) => setHasLocal(Boolean(w)))
    restoreSession()
    startUpdater()
  }, [])

  // Open the notes once there is something to show.
  const canOpen = session === 'signed-in' && (hasLocal || cloudState.firstSyncDone)
  useEffect(() => {
    if (canOpen && !useStore.getState().ready) {
      useStore.getState().init().then(() => {
        warmSearch()
        setTimeout(preloadEditor, 1200)
      })
    }
  }, [canOpen])

  useOfflineImages(canOpen)

  if (session === 'checking' || hasLocal === null) return <div className="m-center" />
  if (session === 'signed-out') return <LoginScreen />
  if (!canOpen || !ready) return <FirstSync />
  return <Main />
}

function Main() {
  const screen = useUi((s) => s.screen)
  const tabs = useStore((s) => s.tabs)
  const fatal = useStore((s) => s.fatal)
  const syncError = useStore((s) => s.syncError)
  useEdgeSwipe()

  return (
    <div className="m-app">
      <TopBar />
      <UpdateBanner />
      {syncError && <div className="m-banner warn"><span>{syncError}</span></div>}
      {fatal && <div className="m-banner warn"><span>{fatal}</span></div>}
      {tabs.length > 1 && <Tabs />}
      <PageView />
      <FormatBar />
      <Drawer />
      {screen === 'search' && <SearchScreen />}
      {screen === 'settings' && <SettingsScreen />}
      <Overlays />
    </div>
  )
}

/**
 * Swipe right from the left third of the screen opens the drawer. (The very
 * edge belongs to Android's own Back gesture on gesture-navigation phones.)
 */
function useEdgeSwipe() {
  useEffect(() => {
    let start: { x: number; y: number } | null = null
    const down = (e: TouchEvent) => {
      const t = e.touches[0]
      if (e.touches.length === 1 && t.clientX < window.innerWidth * 0.3 && !useStore.getState().editingCellId && !(e.target as HTMLElement).closest?.('.m-cell, .m-drawbar, input, .m-sheet') && !useUi.getState().drawer && !useUi.getState().screen && !useUi.getState().drawing) start = { x: t.clientX, y: t.clientY }
      else start = null
    }
    const move = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0]
      if (t.clientX - start.x > 60 && Math.abs(t.clientY - start.y) < 50) {
        start = null
        tick()
        stopEditing()
        useUi.setState({ drawer: true })
      }
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
    }
  }, [])
}

function TopBar() {
  const page = useStore((s) => s.page)
  const tree = useStore((s) => s.workspace.tree)
  const pageId = useStore((s) => s.activePageId)
  const view = useUi((s) => s.viewOf(pageId))
  const editing = useStore((s) => s.editingCellId)
  const path = pageId ? pathTo(tree, pageId) : []
  const color = notebookColor(tree, pageId)
  const where = path.slice(0, -1)

  return (
    <div className="m-top">
      <button className="m-icon" aria-label="Notebooks and pages" onClick={() => (stopEditing(), useUi.setState({ drawer: true }))}>
        <MenuI />
      </button>
      <button className="m-where" onClick={() => (stopEditing(), useUi.setState({ drawer: true }))} style={{ ['--nb-color' as any]: color, textAlign: 'left' }}>
        <span className="m-where-path">
          {where.map((n, i) => (
            <React.Fragment key={n.id}>
              {i > 0 && '  /  '}
              {i === 0 ? <b>{n.title}</b> : n.title}
            </React.Fragment>
          ))}
        </span>
        <span className="m-where-title">{page?.title || 'Untitled page'}</span>
      </button>
      {!editing && <SyncDot asButton />}
      {pageId && (
        <button
          className="m-icon"
          aria-label={view === 'flow' ? 'Show as on the computer' : 'Show as a list of cells'}
          onClick={() => {
            tick()
            stopEditing()
            useUi.setState({ drawing: false, movingCell: null })
            useUi.getState().setView(pageId, view === 'flow' ? 'canvas' : 'flow')
            toast(view === 'flow' ? 'Page view: laid out like the computer. Pinch to zoom.' : 'Flow view: cells one under another.', undefined, 1800)
          }}
        >
          {view === 'flow' ? <CanvasI /> : <FlowI />}
        </button>
      )}
      <button className="m-icon" aria-label="Search" onClick={() => (stopEditing(), useUi.setState({ screen: 'search' }))}>
        <Search />
      </button>
      <button className="m-icon" aria-label="More" onClick={pageMenu}>
        <DotsI />
      </button>
    </div>
  )
}

function pageMenu() {
  const st = useStore.getState()
  const ui = useUi.getState()
  const id = st.activePageId
  const node = id ? pathTo(st.workspace.tree, id).slice(-1)[0] : null
  const fav = Boolean(id && st.workspace.favorites.includes(id))
  stopEditing()
  showSheet({
    title: node?.title || 'Page',
    items: [
      { label: 'New page in this section', icon: <Plus />, onClick: () => newPageHere() },
      ...(id
        ? [
            {
              label: 'Draw on the page',
              icon: <DrawI />,
              onClick: () => {
                ui.setView(id, 'canvas')
                useUi.setState({ drawing: true })
                toast('One finger draws. Two fingers move and zoom.', undefined, 2500)
              },
            },
            { label: 'Undo', icon: <Undo />, onClick: () => st.undo() },
            { label: 'Redo', icon: <Redo />, onClick: () => st.redo() },
            ...(st.navBack.length ? [{ label: 'Back to the previous page', icon: <ArrowLeft />, onClick: () => st.goBack() }] : []),
            ...(st.navForward.length ? [{ label: 'Forward', icon: <ArrowRight />, onClick: () => st.goForward() }] : []),
            { label: 'Open in a new tab', icon: <Copy />, onClick: () => st.duplicateTab(st.activeTab) },
            { label: fav ? 'Remove from favorites' : 'Add to favorites', icon: <Star />, onClick: () => st.toggleFavorite(id) },
            {
              label: 'Tidy overlapping cells',
              icon: <Layers />,
              onClick: () => {
                st.reflowOverlaps(true)
                toast('Cells tidied', { label: 'Undo', onClick: () => useStore.getState().undo() })
              },
            },
            { label: 'More page actions', icon: <Pencil />, onClick: () => node && nodeActions(node, st.workspace.tree, fav) },
          ]
        : []),
      { label: 'Settings', icon: <Folder />, onClick: () => useUi.setState({ screen: 'settings' }) },
    ],
  })
}

function Tabs() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.activeTab)
  const tree = useStore((s) => s.workspace.tree)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('.m-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [active])
  return (
    <div className="m-tabs" ref={ref}>
      {tabs.map((t) => {
        const n = pathTo(tree, t.pageId).slice(-1)[0]
        return (
          <div
            key={t.id}
            className={`m-tab ${t.id === active ? 'active' : ''}`}
            style={{ ['--tab-color' as any]: t.color || notebookColor(tree, t.pageId) }}
            onClick={() => (stopEditing(), useStore.getState().switchTab(t.id))}
          >
            <span className="m-tab-dot" />
            <span>{n?.title || 'Untitled'}</span>
            <button
              className="x"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().closeTab(t.id)
              }}
            >
              <X />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function UpdateBanner() {
  const ready = useUpdate((s) => s.ready)
  const apk = useUpdate((s) => s.latestApk)
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('notes:banner') || '')
  const key = ready ? `w${ready.version}` : apk ? `a${apk.versionCode}` : ''
  if (!key || hidden === key) return null
  const dismiss = () => {
    sessionStorage.setItem('notes:banner', key)
    setHidden(key)
  }
  return (
    <div className="m-banner">
      <span>{ready ? 'A new version of Notes is ready.' : `App version ${apk!.versionName} is available.`}</span>
      {ready ? (
        <button onClick={() => useUpdate.getState().restartNow()}>Restart</button>
      ) : (
        <button onClick={() => useUi.setState({ screen: 'settings' })}>Install</button>
      )}
      <button onClick={dismiss} aria-label="Later">
        Later
      </button>
    </div>
  )
}

/** "Keep all pictures offline": fetches missing pictures slowly, on Wi-Fi, while the app is open. */
function useOfflineImages(on: boolean) {
  const keep = useUi((s) => s.keepImagesOffline)
  const c = useCloud()
  useEffect(() => {
    if (!on || !keep || c.phase !== 'idle') return
    const conn = (navigator as any).connection
    if (conn && (conn.saveData || (conn.type && !['wifi', 'ethernet', 'unknown'].includes(conn.type)))) return
    let stop = false
    const t = setTimeout(async () => {
      const list = await cloud.missingImages()
      for (const p of list) {
        if (stop || document.hidden) break
        await cloud.download(p)
        await new Promise((r) => setTimeout(r, 250))
      }
    }, 8000)
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [on, keep, c.phase === 'idle'])
}

export { Book, File, Trash, onBack }
