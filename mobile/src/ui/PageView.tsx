/**
 * The open page, in one of two views:
 *  - Flow: the page's cells as cards, top to bottom, full width. Easiest to
 *    read and type on a phone.
 *  - Page: the cells where they are on the computer, with pinch zoom and
 *    drawing, like the desktop canvas.
 * Cells show as plain HTML until tapped; only the cell being edited runs an
 * editor, which keeps scrolling smooth on a slow phone.
 */
import React, { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { canvasView, findNode, useStore } from '../../../src/store'
import { useActiveEditor } from '../../../src/editor/activeEditor'
import { storage } from '../../../src/lib/storage'
import type { Cell, Page, Settings, Stroke } from '../../../src/types'
import { ArrowLeft, ArrowRight, Check, Copy, DrawI, Eraser, FitI, Highlighter, Layers, Pen, Pencil, Plus, Trash, Undo, X } from '../../../src/components/Icons'
import { StaticHtml, toggleTaskInHtml } from './StaticHtml'
import { showSheet, toast, COLORS } from './overlays'
import { useUi } from './state'
import { onBack, hideKeyboard, tick } from '../platform'
import { usePress } from './gestures'
import { openNoteLink, siblingPage } from './nav'

/** The editor loads on its own, after the page shows (most cells are only read). */
const RichEditor = lazy(() => import('../../../src/components/RichEditor'))
export function preloadEditor() {
  import('../../../src/components/RichEditor')
}

/* ------------------------------------------------------------------ */

export function PageView() {
  const page = useStore((s) => s.page)
  const activePageId = useStore((s) => s.activePageId)
  const view = useUi((s) => s.viewOf(activePageId))
  if (!page) return <div className="m-page"><div className="m-hint">Open a page from the menu.</div></div>
  return view === 'canvas' ? <CanvasView key={page.id} page={page} /> : <FlowView key={page.id} page={page} />
}

/* ---------------- shared bits ---------------- */

function cellStyleVars(settings: Settings, scale: number): React.CSSProperties {
  return {
    ['--body-size' as any]: `${Math.round(settings.bodySize * scale * 10) / 10}px`,
    ['--line-height' as any]: String(settings.lineHeight),
    ['--body-color' as any]: settings.bodyColor,
  }
}

/** Starts editing a cell, with the caret where the finger was. */
export function startEditing(cellId: string, at?: { x: number; y: number }) {
  const st = useStore.getState()
  if (st.editingCellId === cellId && at) return
  // Android shows the keyboard only for focus given during the tap itself: a
  // hidden field takes it now and hands it to the editor once that is ready.
  catchFocus()
  useStore.setState({ editingCellId: cellId, selection: [cellId] })
  tick()
  let tries = 0
  const place = () => {
    const pm = document.querySelector(`[data-cell-id="${cellId}"] .ProseMirror[contenteditable]`) as any
    const editor = pm?.editor
    if (!editor) {
      if (tries++ < 240) requestAnimationFrame(place)
      else releaseCatcher()
      return
    }
    let pos: number | null = null
    if (at) {
      const r = editor.view.posAtCoords({ left: at.x, top: at.y })
      if (r) pos = r.pos
    }
    if (pos === null) editor.commands.focus('end')
    else editor.chain().focus().setTextSelection(pos).run()
    releaseCatcher()
  }
  requestAnimationFrame(place)
}

let catcher: HTMLTextAreaElement | null = null
function catchFocus() {
  if (!catcher) {
    catcher = document.createElement('textarea')
    catcher.setAttribute('aria-hidden', 'true')
    catcher.tabIndex = -1
    Object.assign(catcher.style, { position: 'fixed', left: '0', top: '40%', width: '1px', height: '1px', opacity: '0', fontSize: '16px', pointerEvents: 'none', border: '0', padding: '0' })
    document.body.appendChild(catcher)
  }
  try {
    catcher.focus({ preventScroll: true })
  } catch {
    /* ignore */
  }
}
function releaseCatcher() {
  if (catcher && document.activeElement === catcher) catcher.blur()
}

export function stopEditing() {
  const st = useStore.getState()
  if (!st.editingCellId) return
  hideKeyboard()
  useStore.setState({ editingCellId: null, selection: [] })
}

/** Keeps the caret above the keyboard and the format bar while typing. */
function useCaretFollow(scroller: React.RefObject<HTMLElement>) {
  useEffect(() => {
    let raf = 0
    const follow = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const ed = useActiveEditor.getState().editor
        const el = scroller.current
        if (!ed || ed.isDestroyed || !el || !ed.isFocused) return
        let c
        try {
          c = ed.view.coordsAtPos(ed.state.selection.head)
        } catch {
          return
        }
        const r = el.getBoundingClientRect()
        const bottom = r.bottom - 16
        const top = r.top + 12
        if (c.bottom > bottom) el.scrollTop += c.bottom - bottom
        else if (c.top < top) el.scrollTop -= top - c.top
      })
    }
    const off = useActiveEditor.subscribe((s, p) => s.tick !== p.tick && follow())
    const vv = window.visualViewport
    vv?.addEventListener('resize', follow)
    window.addEventListener('resize', follow)
    return () => {
      off()
      vv?.removeEventListener('resize', follow)
      window.removeEventListener('resize', follow)
      cancelAnimationFrame(raf)
    }
  }, [scroller])
}

/** While editing, the back button closes the editor first. */
function useEditBack() {
  const editing = useStore((s) => s.editingCellId)
  useEffect(() => {
    if (!editing) return
    return onBack(() => {
      stopEditing()
      return true
    })
  }, [editing])
}

function InkLines({ strokes }: { strokes: Stroke[] }) {
  return (
    <>
      {strokes.map((s, i) => (
        <polyline
          key={i}
          points={pairs(s.points)}
          fill="none"
          stroke={s.color}
          strokeWidth={s.size}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={s.size > 10 ? 0.38 : 1}
        />
      ))}
    </>
  )
}

function pairs(pts: number[]) {
  let out = ''
  for (let i = 0; i < pts.length; i += 2) out += `${pts[i]},${pts[i + 1]} `
  return out
}

/** The text of a cell: plain HTML, or the editor while it is being edited. */
const CellContent = memo(function CellContent({ cell, editing, settings }: { cell: Cell; editing: boolean; settings: Settings }) {
  const onChange = useCallback((html: string) => useStore.getState().updateCell(cell.id, { html }), [cell.id])
  if (editing)
    return (
      <Suspense fallback={<StaticHtml html={cell.html} />}>
      <RichEditor
        html={cell.html}
        spellcheck={settings.spellcheck}
        placeholder="Type here"
        onChange={onChange}
        onEmptyBackspace={() => {
          if (!cell.title && !(cell.strokes || []).length) {
            useStore.getState().deleteCells([cell.id])
            hideKeyboard()
            toast('Empty cell removed', { label: 'Undo', onClick: () => useStore.getState().undo() })
          }
        }}
      />
      </Suspense>
    )
  if (!cell.html || cell.html === '<p></p>') return <div className="m-empty-cell">Empty cell, tap to write</div>
  return (
    <StaticHtml
      html={cell.html}
      onToggleTask={(i) => {
        tick()
        useStore.getState().updateCell(cell.id, { html: toggleTaskInHtml(cell.html, i) }, true)
      }}
      onNoteLink={openNoteLink}
    />
  )
})

function CellTitle({ cell, editing, settings, scale }: { cell: Cell; editing: boolean; settings: Settings; scale: number }) {
  const style = { fontSize: settings.titleSize * scale, color: settings.titleColor, lineHeight: 1.3 }
  if (editing && cell.showTitle)
    return (
      <input
        className="m-card-title"
        value={cell.title}
        placeholder="Title"
        style={style}
        enterKeyHint="next"
        onChange={(e) => useStore.getState().updateCell(cell.id, { title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            startEditing(cell.id)
          }
        }}
      />
    )
  if (!cell.showTitle || !cell.title) return null
  return (
    <div className="m-card-title static" style={style}>
      {cell.title}
    </div>
  )
}

/* ---------------- cell actions (long press) ---------------- */

export function cellActions(cell: Cell, view: 'flow' | 'canvas') {
  const st = useStore.getState()
  const page = st.page
  if (!page) return
  const ordered = flowOrder(page.cells)
  const idx = ordered.findIndex((c) => c.id === cell.id)
  const swap = (other: Cell | undefined) => {
    if (!other) return
    st.pushHistory()
    st.updateCells([cell.id, other.id], (c) => (c.id === cell.id ? { x: other.x, y: other.y } : { x: cell.x, y: cell.y }))
  }
  const items = [
    { label: 'Edit', icon: <Pencil />, onClick: () => startEditing(cell.id) },
    {
      label: 'Copy text',
      icon: <Copy />,
      onClick: async () => {
        const { htmlToMarkdown } = await import('../../../src/editor/markdown')
        const md = `${cell.title ? `## ${cell.title}\n\n` : ''}${htmlToMarkdown(cell.html || '')}`
        try {
          await navigator.clipboard.writeText(md)
          toast('Copied')
        } catch {
          toast('Could not copy')
        }
      },
    },
    { label: 'Duplicate', icon: <Layers />, onClick: () => st.duplicateCells([cell.id]) },
    ...(view === 'flow'
      ? [
          ...(idx > 0 ? [{ label: 'Move up', icon: <span style={{ display: 'grid', transform: 'rotate(90deg)' }}><ArrowLeft /></span>, onClick: () => swap(ordered[idx - 1]) }] : []),
          ...(idx < ordered.length - 1 ? [{ label: 'Move down', icon: <span style={{ display: 'grid', transform: 'rotate(90deg)' }}><ArrowRight /></span>, onClick: () => swap(ordered[idx + 1]) }] : []),
        ]
      : [
          {
            label: 'Move or resize',
            icon: <FitI />,
            onClick: () => {
              useStore.setState({ editingCellId: null })
              useUi.setState({ movingCell: cell.id })
              toast('Drag the cell, or its corner to resize. Tap empty space when done.')
            },
          },
        ]),
    {
      label: cell.showTitle ? 'Hide title' : 'Show title',
      icon: <Pencil />,
      onClick: () => st.updateCell(cell.id, { showTitle: !cell.showTitle }, true),
    },
    {
      label: cell.collapsed ? 'Expand' : 'Collapse',
      icon: <Layers />,
      onClick: () => st.updateCell(cell.id, { collapsed: !cell.collapsed }, true),
    },
    { label: 'Move to another page', icon: <ArrowRight />, onClick: () => pickPageFor(cell) },
    {
      label: 'Delete',
      icon: <Trash />,
      danger: true,
      onClick: () => {
        st.deleteCells([cell.id])
        toast('Cell deleted', { label: 'Undo', onClick: () => useStore.getState().undo() }, 5000)
      },
    },
  ]
  showSheet({
    title: cell.title || plain(cell.html).slice(0, 60) || 'Cell',
    items,
    colors: { value: cell.bg || '', label: 'Background', current: cell.bg, onPick: (c) => st.updateCell(cell.id, { bg: c ? `color-mix(in srgb, ${c} 18%, var(--cell-bg))` : '' }, true) },
  })
}

function plain(html: string) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function pickPageFor(cell: Cell) {
  const { workspace, activePageId } = useStore.getState()
  const { pageIndex } = await import('../../../shared/search-core.mjs')
  const info = pageIndex(workspace.tree)
  const recent = (workspace.recent || []).filter((id) => id !== activePageId && info.has(id) && !info.get(id)!.archived)
  const rest = [...info.keys()].filter((id) => id !== activePageId && !recent.includes(id) && !info.get(id)!.archived)
  const ids = [...recent, ...rest].slice(0, 60)
  showSheet({
    title: 'Move the cell to',
    items: ids.map((id) => ({
      label: [...info.get(id)!.path, findNode(workspace.tree, id)?.title || 'Untitled'].join(' / '),
      onClick: () => moveCellToPage(cell, id),
    })),
  })
}

async function moveCellToPage(cell: Cell, pageId: string) {
  const st = useStore.getState()
  await st.save()
  const r = await storage.readPage(pageId)
  const base = r.data
  const target: Page = base ? JSON.parse(JSON.stringify(base)) : { id: pageId, title: '', cells: [], strokes: [], createdAt: Date.now(), updatedAt: Date.now() }
  const bottom = target.cells.length ? Math.max(...target.cells.map((c) => c.y + c.h)) : 80
  const left = target.cells.length ? Math.min(...target.cells.map((c) => c.x)) : 40
  const maxZ = target.cells.reduce((m, c) => Math.max(m, c.z), 0)
  const moved: Cell = { ...cell, x: left, y: bottom + st.settings.cellGap, z: maxZ + 1, updatedAt: Date.now() }
  delete (moved as any).vv
  target.cells.push(moved)
  target.updatedAt = Date.now()
  await storage.writePage(pageId, target, base, { cells: [moved.id] })
  st.deleteCells([cell.id])
  const title = target.title || 'the page'
  toast(`Moved to ${title}`, { label: 'Open', onClick: () => useStore.getState().openPage(pageId) })
}

/** Reading order: top to bottom, then left to right. */
export function flowOrder(cells: Cell[]): Cell[] {
  return [...cells].sort((a, b) => (Math.abs(a.y - b.y) < 20 ? a.x - b.x : a.y - b.y))
}

/** A new cell under everything else, ready to type in. */
export function addCellAtEnd() {
  const st = useStore.getState()
  const cells = st.page?.cells || []
  const x = cells.length ? Math.min(...cells.map((c) => c.x)) : 40
  const y = cells.length ? Math.max(...cells.map((c) => c.y + c.h)) + st.settings.cellGap : 120
  const id = st.addCell({ x, y })
  startEditing(id)
  requestAnimationFrame(() => document.querySelector(`[data-cell-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
}

/* ---------------- page header ---------------- */

function PageHead({ page, settings }: { page: Page; settings: Settings }) {
  const hasInk = (page.strokes || []).length > 0
  const view = useUi((s) => s.viewOf(page.id))
  return (
    <div className="m-page-head">
      <input
        className="m-page-title"
        value={page.title}
        placeholder="Untitled page"
        enterKeyHint="done"
        onChange={(e) => useStore.getState().setPageTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <div className="m-page-date">
        {settings.showPageDate && <span>{new Date(page.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>}
        {hasInk && view === 'flow' && (
          <button className="m-chip" onClick={() => useUi.getState().setView(page.id, 'canvas')}>
            <DrawI /> Has drawings: page view
          </button>
        )}
      </div>
    </div>
  )
}

/* ================================================================== *
 * Flow view
 * ================================================================== */

function FlowView({ page }: { page: Page }) {
  const settings = useStore((s) => s.settings)
  const editing = useStore((s) => s.editingCellId)
  const textScale = useUi((s) => s.textScale)
  const swipe = useUi((s) => s.swipePages)
  const scroller = useRef<HTMLDivElement>(null)
  const cells = useMemo(() => flowOrder(page.cells), [page.cells])
  useCaretFollow(scroller)
  useEditBack()
  useFlash(scroller)

  useLayoutEffect(() => {
    canvasView.el = scroller.current
    const el = scroller.current
    if (!el) return
    const onScroll = () => useStore.getState().noteScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (canvasView.el === el) canvasView.el = null
    }
  }, [])

  // Swipe sideways to the next or previous page of the section.
  const sw = useRef<{ x: number; y: number; t: number } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => {
    if (!swipe || e.touches.length !== 1 || useStore.getState().editingCellId) return (sw.current = null)
    const t = e.touches[0]
    sw.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = sw.current
    sw.current = null
    if (!s) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    // A right swipe from the left third opens the drawer instead (App.tsx).
    if (dx > 0 && s.x < window.innerWidth * 0.3) return
    if (Math.abs(dx) > 90 && Math.abs(dy) < 45 && Date.now() - s.t < 600) {
      const id = siblingPage(dx < 0 ? 1 : -1)
      if (id) {
        tick()
        useStore.getState().openPage(id)
      }
    }
  }

  const vars = cellStyleVars(settings, textScale)
  return (
    <div className="m-page">
      <div className="m-scroll" ref={scroller} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <PageHead page={page} settings={settings} />
        <div className="m-flow" style={vars}>
          {cells.map((c) => (
            <FlowCard key={c.id} cell={c} editing={editing === c.id} settings={settings} scale={textScale} />
          ))}
          {!cells.length && (
            <button className="m-hint" onClick={addCellAtEnd}>
              This page is empty. Tap here or the + button to start writing.
            </button>
          )}
        </div>
      </div>
      {!editing && (
        <button className="m-fab" aria-label="New cell" onClick={addCellAtEnd}>
          <Plus />
        </button>
      )}
    </div>
  )
}

const FlowCard = memo(function FlowCard({ cell, editing, settings, scale }: { cell: Cell; editing: boolean; settings: Settings; scale: number }) {
  const press = usePress(
    (e) => {
      if (editing) return
      const t = e.target as HTMLElement
      if (t.closest('a, input[type="checkbox"], .m-embed-card')) return
      startEditing(cell.id, { x: e.clientX, y: e.clientY })
    },
    () => cellActions(cell, 'flow'),
  )
  const strokes = cell.strokes || []
  return (
    <div
      className={`m-card ${editing ? 'editing' : ''} ${cell.collapsed ? 'collapsed' : ''}`}
      data-cell-id={cell.id}
      style={{ background: cell.bg || settings.cellBg || undefined, borderColor: cell.border || undefined }}
      {...(editing ? {} : press)}
    >
      {cell.conflict && <ConflictBar cell={cell} />}
      <CellTitle cell={cell} editing={editing} settings={settings} scale={scale} />
      {!cell.collapsed && <CellContent cell={cell} editing={editing} settings={settings} />}
      {strokes.length > 0 && !cell.collapsed && (
        <svg className="m-cell-ink" viewBox={`0 0 ${cell.w} ${cell.h}`} preserveAspectRatio="xMinYMin meet">
          <InkLines strokes={strokes} />
        </svg>
      )}
    </div>
  )
})

function ConflictBar({ cell }: { cell: Cell }) {
  const act = (a: 'keep-both' | 'use-this' | 'discard' | 'keep' | 'delete') => useStore.getState().resolveConflict(cell.id, a)
  return (
    <div className="cell-conflict" style={{ margin: '8px 0 0', borderRadius: 8 }} onPointerDown={(e) => e.stopPropagation()}>
      {cell.conflict!.reason === 'deleted-elsewhere' ? (
        <>
          <span>Deleted on another device, edited here.</span>
          <button onClick={() => act('keep')}>Keep</button>
          <button onClick={() => act('delete')}>Delete</button>
        </>
      ) : (
        <>
          <span>Edited on two devices. This is the other version.</span>
          <button onClick={() => act('use-this')}>Use this</button>
          <button onClick={() => act('keep-both')}>Keep both</button>
          <button onClick={() => act('discard')}>Discard</button>
        </>
      )}
    </div>
  )
}

/** After opening a page from search, the found words light up and scroll into view. */
function useFlash(scroller: React.RefObject<HTMLElement>) {
  const flash = useUi((s) => s.flash)
  const pageId = useStore((s) => s.activePageId)
  useEffect(() => {
    if (!flash || flash.pageId !== pageId) return
    const t = setTimeout(() => {
      useUi.setState({ flash: null })
      const root = scroller.current
      if (!root) return
      const cellEl = root.querySelector(`[data-cell-id="${flash.cellId}"]`) as HTMLElement | null
      const mark = cellEl ? markWords(cellEl, flash.query) : null
      ;(mark || cellEl)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 120)
    return () => clearTimeout(t)
  }, [flash, pageId, scroller])
}

function markWords(root: HTMLElement, query: string): HTMLElement | null {
  const words = query
    .toLowerCase()
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !w.includes(':'))
  if (!words.length) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const hits: { node: Text; at: number; len: number }[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const low = (node.data || '').toLowerCase()
    for (const w of words) {
      const at = low.indexOf(w)
      if (at >= 0) {
        hits.push({ node, at, len: w.length })
        break
      }
    }
    if (hits.length > 30) break
  }
  let first: HTMLElement | null = null
  for (const h of hits) {
    try {
      const r = document.createRange()
      r.setStart(h.node, h.at)
      r.setEnd(h.node, h.at + h.len)
      const m = document.createElement('mark')
      m.className = 'm-mark'
      r.surroundContents(m)
      first ??= m
    } catch {
      /* crosses an element: skip */
    }
  }
  return first
}

/* ================================================================== *
 * Page (canvas) view: like the computer, with pinch zoom and ink
 * ================================================================== */

function CanvasView({ page }: { page: Page }) {
  const settings = useStore((s) => s.settings)
  const editing = useStore((s) => s.editingCellId)
  const zoom = useStore((s) => s.zoom)
  const drawing = useUi((s) => s.drawing)
  const moving = useUi((s) => s.movingCell)
  const scroller = useRef<HTMLDivElement>(null)
  const sizer = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [vw, setVw] = useState(() => window.innerWidth)
  useCaretFollow(scroller)
  useEditBack()
  useFlash(scroller)

  const size = useMemo(() => {
    let w = 0
    let h = 0
    for (const c of page.cells) {
      w = Math.max(w, c.x + c.w)
      h = Math.max(h, c.y + c.h)
    }
    for (const s of page.strokes || []) for (let i = 0; i < s.points.length; i += 2) {
      w = Math.max(w, s.points[i])
      h = Math.max(h, s.points[i + 1])
    }
    return { w: Math.max(w + 60, 360), h: Math.max(h + 400, 900) }
  }, [page.cells, page.strokes])

  const fitZoom = Math.max(0.3, Math.min(1, (vw - 8) / size.w))

  useLayoutEffect(() => {
    canvasView.el = scroller.current
    const el = scroller.current
    const onScroll = () => useStore.getState().noteScroll()
    el?.addEventListener('scroll', onScroll, { passive: true })
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    // First time on this page: fit its width.
    const key = `notes:fit:${page.id}`
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1')
      useStore.getState().setZoom(Math.max(0.3, Math.min(1, (window.innerWidth - 8) / size.w)))
    }
    return () => {
      el?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      if (canvasView.el === el) canvasView.el = null
    }
  }, [])

  useEffect(() => {
    if (!moving) return
    return onBack(() => {
      useUi.setState({ movingCell: null })
      return true
    })
  }, [moving])

  usePinch(scroller, sizer, layer, size, drawing)

  /** Zooms so the cell fills the width, then edits it where the finger was. */
  const editAt = (cell: Cell, e: React.PointerEvent) => {
    const el = scroller.current
    if (!el) return startEditing(cell.id, { x: e.clientX, y: e.clientY })
    const r = el.getBoundingClientRect()
    const z0 = useStore.getState().zoom
    const px = (e.clientX - r.left + el.scrollLeft) / z0
    const py = (e.clientY - r.top + el.scrollTop) / z0
    const want = Math.min(1.25, (r.width - 16) / cell.w)
    if (z0 < want - 0.04) {
      useStore.getState().setZoom(want)
      requestAnimationFrame(() => {
        const z = useStore.getState().zoom
        el.scrollLeft = Math.max(0, cell.x * z - 8)
        el.scrollTop = Math.max(0, py * z - (e.clientY - r.top))
        startEditing(cell.id, { x: r.left + px * z - el.scrollLeft, y: r.top + py * z - el.scrollTop })
      })
    } else startEditing(cell.id, { x: e.clientX, y: e.clientY })
  }

  const lastTap = useRef(0)
  const onBackgroundTap = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.m-cell, .m-page-head')) return
    if (moving) return useUi.setState({ movingCell: null })
    if (editing) return stopEditing()
    const now = Date.now()
    if (now - lastTap.current < 320) {
      // Double tap: fit width, or back to 100%.
      const z = useStore.getState().zoom
      useStore.getState().setZoom(Math.abs(z - fitZoom) < 0.03 ? 1 : fitZoom)
      lastTap.current = 0
    } else lastTap.current = now
  }

  const vars = cellStyleVars(settings, 1)
  const ordered = useMemo(() => [...page.cells].sort((a, b) => a.z - b.z), [page.cells])

  return (
    <div className="m-page">
      <div className={`m-scroll ${drawing ? 'm-draw-surface' : ''}`} ref={scroller} onPointerUp={drawing ? undefined : onBackgroundTap}>
        <div ref={sizer} className="m-canvas-size" style={{ width: size.w * zoom, height: size.h * zoom, minWidth: '100%' }}>
          <div
            ref={layer}
            className={`m-canvas canvas ${settings.showGrid ? `bg-${settings.pageBackground}` : ''}`}
            style={{ width: size.w, height: size.h, transform: `scale(${zoom})`, backgroundSize: `${settings.gridSize}px ${settings.gridSize}px`, ...vars }}
          >
            <PageHead page={page} settings={settings} />
            <svg className="m-ink" width={size.w} height={size.h}>
              <InkLines strokes={page.strokes || []} />
            </svg>
            {ordered.map((c) => (
              <CanvasCell key={c.id} cell={c} editing={editing === c.id} moving={moving === c.id} settings={settings} onEdit={editAt} />
            ))}
            {drawing && <DrawLayer w={size.w} h={size.h} scroller={scroller} />}
          </div>
        </div>
      </div>
      {!drawing && !editing && (
        <>
          <button
            className="m-zoom-pill"
            onClick={() => {
              const z = useStore.getState().zoom
              useStore.getState().setZoom(Math.abs(z - fitZoom) < 0.03 ? 1 : fitZoom)
            }}
          >
            <FitI /> {Math.round(zoom * 100)}%
          </button>
          <button className="m-fab" aria-label="New cell" onClick={addCellAtEnd}>
            <Plus />
          </button>
        </>
      )}
      {drawing && <DrawBar />}
    </div>
  )
}

const CanvasCell = memo(function CanvasCell({
  cell,
  editing,
  moving,
  settings,
  onEdit,
}: {
  cell: Cell
  editing: boolean
  moving: boolean
  settings: Settings
  onEdit(cell: Cell, e: React.PointerEvent): void
}) {
  const press = usePress(
    (e) => {
      if (editing || moving) return
      const t = e.target as HTMLElement
      if (t.closest('a, input[type="checkbox"], .m-embed-card')) return
      onEdit(cell, e)
    },
    () => cellActions(cell, 'canvas'),
  )
  const height = cell.collapsed ? 14 + settings.titleSize * 1.7 : undefined
  return (
    <div
      className={`m-cell ${settings.cellBorder ? 'bordered' : ''} ${editing ? 'editing' : ''} ${moving ? 'moving' : ''}`}
      data-cell-id={cell.id}
      style={{
        left: cell.x,
        top: cell.y,
        width: cell.w,
        minHeight: height ?? cell.h,
        height,
        zIndex: cell.z,
        background: cell.bg || settings.cellBg || undefined,
        borderColor: cell.border || undefined,
        ['--cell-radius' as any]: `${settings.cellRadius}px`,
        padding: `0 ${settings.cellPadding}px ${settings.cellPadding}px`,
        touchAction: moving ? 'none' : undefined,
      }}
      {...(editing || moving ? {} : press)}
    >
      {cell.conflict && <ConflictBar cell={cell} />}
      {(cell.strokes || []).length > 0 && (
        <svg className="m-cell-ink">
          <InkLines strokes={cell.strokes!} />
        </svg>
      )}
      <CellTitle cell={cell} editing={editing} settings={settings} scale={1} />
      {!cell.collapsed && <CellContent cell={cell} editing={editing} settings={settings} />}
      {moving && <MoveHandles cell={cell} />}
    </div>
  )
})

/** Drag to move, corner to resize, snapped to the grid. */
function MoveHandles({ cell }: { cell: Cell }) {
  const begin = (e: React.PointerEvent, mode: 'move' | 'size') => {
    e.stopPropagation()
    e.preventDefault()
    const st = useStore.getState()
    const z = st.zoom
    const g = st.settings.snapToGrid ? st.settings.gridSize : 1
    const sx = e.clientX
    const sy = e.clientY
    const box = { x: cell.x, y: cell.y, w: cell.w, h: cell.h }
    const el = (e.currentTarget as HTMLElement).closest('.m-cell') as HTMLElement
    let last = box
    st.pushHistory()
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / z
      const dy = (ev.clientY - sy) / z
      last =
        mode === 'move'
          ? { ...box, x: Math.max(0, Math.round((box.x + dx) / g) * g), y: Math.max(0, Math.round((box.y + dy) / g) * g) }
          : { ...box, w: Math.max(g * 4, Math.round((box.w + dx) / g) * g), h: Math.max(g * 2, Math.round((box.h + dy) / g) * g) }
      el.style.left = `${last.x}px`
      el.style.top = `${last.y}px`
      el.style.width = `${last.w}px`
      el.style.minHeight = `${last.h}px`
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      useStore.getState().updateCell(cell.id, last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  return (
    <>
      <div onPointerDown={(e) => begin(e, 'move')} style={{ position: 'absolute', inset: 0, zIndex: 5, cursor: 'move' }} />
      <div
        onPointerDown={(e) => begin(e, 'size')}
        style={{ position: 'absolute', right: -14, bottom: -14, width: 36, height: 36, borderRadius: 18, background: 'var(--accent)', zIndex: 6, border: '3px solid var(--bg-1)' }}
      />
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useUi.setState({ movingCell: null })}
        style={{ position: 'absolute', right: 6, top: -40, zIndex: 7 }}
        className="m-btn primary"
      >
        <Check /> Done
      </button>
    </>
  )
}

/**
 * Two fingers zoom (and pan while drawing). The zoom happens straight on the
 * page's layers while the fingers move, and lands in the store when they lift,
 * so the cells are not redrawn on every frame.
 */
function usePinch(
  scroller: React.RefObject<HTMLDivElement>,
  sizer: React.RefObject<HTMLDivElement>,
  layer: React.RefObject<HTMLDivElement>,
  size: { w: number; h: number },
  drawing: boolean,
) {
  const sizeRef = useRef(size)
  sizeRef.current = size
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let g: { d0: number; z0: number; cx: number; cy: number; z: number } | null = null
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      const r = el.getBoundingClientRect()
      const m = mid(e.touches)
      const z0 = useStore.getState().zoom
      g = { d0: dist(e.touches), z0, z: z0, cx: (m.x - r.left + el.scrollLeft) / z0, cy: (m.y - r.top + el.scrollTop) / z0 }
    }
    const move = (e: TouchEvent) => {
      if (!g || e.touches.length !== 2) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const m = mid(e.touches)
      const z = Math.min(3, Math.max(0.3, g.z0 * (dist(e.touches) / g.d0)))
      g.z = z
      const s = sizeRef.current
      if (layer.current) layer.current.style.transform = `scale(${z})`
      if (sizer.current) {
        sizer.current.style.width = `${s.w * z}px`
        sizer.current.style.height = `${s.h * z}px`
      }
      el.scrollLeft = g.cx * z - (m.x - r.left)
      el.scrollTop = g.cy * z - (m.y - r.top)
    }
    const end = (e: TouchEvent) => {
      if (!g || e.touches.length >= 2) return
      const z = g.z
      const left = el.scrollLeft
      const top = el.scrollTop
      g = null
      useStore.getState().setZoom(z)
      requestAnimationFrame(() => {
        el.scrollLeft = left
        el.scrollTop = top
      })
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [scroller, sizer, layer, drawing])
}

/* ---------------- drawing ---------------- */

interface Pen {
  tool: 'pen' | 'highlighter' | 'eraser'
  color: string
  size: number
}
const usePen = (() => {
  let pen: Pen | null = null
  const subs = new Set<() => void>()
  return {
    get(settings: Settings): Pen {
      return pen ?? { tool: 'pen', color: settings.penColor, size: settings.penSize }
    },
    set(p: Pen) {
      pen = p
      subs.forEach((f) => f())
    },
    sub(f: () => void) {
      subs.add(f)
      return () => void subs.delete(f)
    },
  }
})()

function usePenState(): [Pen, (p: Pen) => void] {
  const settings = useStore((s) => s.settings)
  const [, force] = useState(0)
  useEffect(() => usePen.sub(() => force((n) => n + 1)), [])
  return [usePen.get(settings), usePen.set]
}

function DrawLayer({ w, h, scroller }: { w: number; h: number; scroller: React.RefObject<HTMLDivElement> }) {
  const [pen] = usePenState()
  const live = useRef<SVGPolylineElement>(null)
  const pts = useRef<number[] | null>(null)
  const pointerIds = useRef(new Set<number>())

  const toPage = (e: React.PointerEvent) => {
    const el = scroller.current!
    const r = el.getBoundingClientRect()
    const z = useStore.getState().zoom
    return [Math.round(((e.clientX - r.left + el.scrollLeft) / z) * 10) / 10, Math.round(((e.clientY - r.top + el.scrollTop) / z) * 10) / 10]
  }

  const erase = (x: number, y: number) => {
    const pg = useStore.getState().page
    if (!pg) return
    const rad = 14
    const hit = (s: Stroke, ox = 0, oy = 0) => {
      for (let i = 0; i < s.points.length; i += 2) if (Math.hypot(ox + s.points[i] - x, oy + s.points[i + 1] - y) < rad + s.size / 2) return true
      return false
    }
    const keep = pg.strokes.filter((s) => !hit(s))
    const touchedCells: string[] = []
    const cells = pg.cells.map((c) => {
      if (!c.strokes?.length) return c
      const k = c.strokes.filter((s) => !hit(s, c.x, c.y))
      if (k.length === c.strokes.length) return c
      touchedCells.push(c.id)
      return { ...c, strokes: k }
    })
    if (keep.length !== pg.strokes.length || touchedCells.length) {
      useStore.getState().applyPageEdit((p) => ({ ...p, strokes: keep, cells }), touchedCells)
      tick()
    }
  }

  return (
    <svg
      className="m-ink top"
      width={w}
      height={h}
      style={{ pointerEvents: 'auto', touchAction: 'none' }}
      onPointerDown={(e) => {
        pointerIds.current.add(e.pointerId)
        if (pointerIds.current.size > 1) {
          // A second finger: that is a pinch, not a stroke.
          pts.current = null
          live.current?.setAttribute('points', '')
          return
        }
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        const [x, y] = toPage(e)
        if (pen.tool === 'eraser') {
          pts.current = []
          erase(x, y)
          return
        }
        pts.current = [x, y]
        live.current?.setAttribute('points', `${x},${y}`)
      }}
      onPointerMove={(e) => {
        if (!pts.current || pointerIds.current.size > 1) return
        const [x, y] = toPage(e)
        if (pen.tool === 'eraser') return erase(x, y)
        const p = pts.current
        if (Math.hypot(p[p.length - 2] - x, p[p.length - 1] - y) < 1.5) return
        p.push(x, y)
        live.current?.setAttribute('points', pairs(p))
      }}
      onPointerUp={(e) => {
        pointerIds.current.delete(e.pointerId)
        const p = pts.current
        pts.current = null
        live.current?.setAttribute('points', '')
        if (!p || pen.tool === 'eraser' || p.length < 4) return
        useStore.getState().addPageStroke({ color: pen.color, size: pen.size, points: p })
      }}
      onPointerCancel={(e) => {
        pointerIds.current.delete(e.pointerId)
        pts.current = null
        live.current?.setAttribute('points', '')
      }}
    >
      <polyline
        ref={live}
        fill="none"
        stroke={pen.color}
        strokeWidth={pen.size}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={pen.tool === 'highlighter' ? 0.38 : 1}
      />
    </svg>
  )
}

function DrawBar() {
  const settings = useStore((s) => s.settings)
  const [pen, setPen] = usePenState()
  const colors = Array.from(new Set([settings.penColor, ...(settings.recentColors || []), ...COLORS.slice(0, 4)])).slice(0, 7)
  const pick = (tool: Pen['tool']) => {
    tick()
    if (tool === 'pen') setPen({ tool, color: pen.tool === 'pen' ? pen.color : settings.penColor, size: settings.penSize })
    else if (tool === 'highlighter') setPen({ tool, color: settings.highlighterColor, size: settings.highlighterSize })
    else setPen({ ...pen, tool })
  }
  return (
    <div className="m-drawbar">
      <button className={`m-icon ${pen.tool === 'pen' ? 'on' : ''}`} onClick={() => pick('pen')} aria-label="Pen">
        <Pen />
      </button>
      <button className={`m-icon ${pen.tool === 'highlighter' ? 'on' : ''}`} onClick={() => pick('highlighter')} aria-label="Highlighter">
        <Highlighter />
      </button>
      <button className={`m-icon ${pen.tool === 'eraser' ? 'on' : ''}`} onClick={() => pick('eraser')} aria-label="Eraser">
        <Eraser />
      </button>
      {pen.tool !== 'eraser' &&
        colors.map((c) => (
          <button key={c} className={`m-swatch ${pen.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setPen({ ...pen, color: c })} aria-label={c} />
        ))}
      {pen.tool !== 'eraser' && (
        <button
          className="m-icon"
          aria-label="Thickness"
          onClick={() => {
            const sizes = pen.tool === 'highlighter' ? [10, 16, 24] : [2, 3, 5, 8]
            const i = sizes.indexOf(pen.size)
            setPen({ ...pen, size: sizes[(i + 1) % sizes.length] })
          }}
        >
          <span style={{ width: Math.min(22, pen.size + 4), height: Math.min(22, pen.size + 4), borderRadius: '50%', background: pen.color, display: 'block' }} />
        </button>
      )}
      <button className="m-icon" aria-label="Undo" onClick={() => useStore.getState().undo()}>
        <Undo />
      </button>
      <span style={{ flex: 1 }} />
      <button className="m-btn primary" onClick={() => useUi.setState({ drawing: false })}>
        <X /> Done
      </button>
    </div>
  )
}
