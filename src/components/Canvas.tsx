import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CellView from './CellView'
import { Menu, type MenuItem } from './Menu'
import { useStore } from '../store'
import type { Cell, Stroke } from '../types'
import { Copy, Layers, Trash, SpaceI, Plus } from './Icons'

type Drag =
  | { mode: 'none' }
  | { mode: 'move'; startX: number; startY: number; origin: Record<string, { x: number; y: number }> }
  | { mode: 'resize'; id: string; dir: string; startX: number; startY: number; box: Cell }
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { mode: 'pan'; sx: number; sy: number; sl: number; st: number; moved: boolean }
  | { mode: 'space'; atY: number; dy: number }
  | { mode: 'ink'; stroke: Stroke }

const MARGIN_X = 120 // breathing room to the right of the widest cell
const MARGIN_Y = 240 // and below the lowest one

export default function Canvas() {
  const page = useStore((s) => s.page)
  const settings = useStore((s) => s.settings)
  const selection = useStore((s) => s.selection)
  const zoom = useStore((s) => s.zoom)
  const tool = useStore((s) => s.tool)
  const editingCellId = useStore((s) => s.editingCellId)
  const store = useStore

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>({ mode: 'none' })
  const dragRef = useRef<Drag>({ mode: 'none' })
  dragRef.current = drag
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const snap = useCallback(
    (v: number) => (settings.snapToGrid ? Math.round(v / settings.gridSize) * settings.gridSize : Math.round(v)),
    [settings.snapToGrid, settings.gridSize],
  )

  /* -------- the visible area, so the page is never smaller than the window -------- */
  const [viewport, setViewport] = useState({ w: 1000, h: 700 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* -------- canvas size: fits the content, never an endless sheet -------- */
  const size = useMemo(() => {
    const cells = page?.cells || []
    let w = 0
    let h = 0
    for (const c of cells) {
      w = Math.max(w, c.x + c.w)
      h = Math.max(h, c.y + c.h)
    }
    for (const s of page?.strokes || []) {
      for (let i = 0; i < s.points.length; i += 2) {
        w = Math.max(w, s.points[i])
        h = Math.max(h, s.points[i + 1])
      }
    }
    if (drag.mode === 'space') h += Math.max(0, drag.dy)
    // Room to keep working past the last cell, but never smaller than the
    // window itself, so there is no dead strip and no pointless scrollbar.
    return {
      w: Math.max(w + MARGIN_X, viewport.w / zoom - 2),
      h: Math.max(h + MARGIN_Y, viewport.h / zoom - 2),
    }
  }, [page?.cells, page?.strokes, drag, viewport, zoom])

  /* -------- coordinates -------- */
  const toCanvas = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = canvasRef.current!.getBoundingClientRect()
      return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
    },
    [zoom],
  )

  /* -------- pointer handling on empty canvas -------- */
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2 || (e.button === 1 && settings.panButton === 'middle')) {
      const wrap = wrapRef.current!
      setDrag({ mode: 'pan', sx: e.clientX, sy: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, moved: false })
      return
    }
    if (e.button !== 0) return
    const p = toCanvas(e)

    if (tool === 'space') {
      setDrag({ mode: 'space', atY: snap(p.y), dy: 0 })
      return
    }
    if (tool === 'pen' || tool === 'highlighter') {
      const stroke: Stroke = {
        color: tool === 'pen' ? settings.penColor : settings.highlighterColor,
        size: tool === 'pen' ? settings.penSize : settings.highlighterSize,
        points: [p.x, p.y],
      }
      setDrag({ mode: 'ink', stroke })
      return
    }
    if (tool === 'eraser') {
      eraseAt(p)
      return
    }
    // Plain select: start a marquee and clear the selection.
    if (!(e.target as HTMLElement).closest('.cell')) {
      store.getState().setSelection([])
      store.setState({ editingCellId: null })
      setDrag({ mode: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    }
  }

  const eraseAt = (p: { x: number; y: number }) => {
    const pg = store.getState().page
    if (!pg) return
    const r = 12
    const keep = pg.strokes.filter((s) => {
      for (let i = 0; i < s.points.length; i += 2) {
        if (Math.hypot(s.points[i] - p.x, s.points[i + 1] - p.y) < r + s.size / 2) return false
      }
      return true
    })
    if (keep.length !== pg.strokes.length) {
      store.getState().pushHistory()
      store.setState({ page: { ...pg, strokes: keep }, dirty: true })
    }
  }

  /* -------- global move / up -------- */
  useEffect(() => {
    if (drag.mode === 'none') return

    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (d.mode === 'pan') {
        const wrap = wrapRef.current!
        wrap.scrollLeft = d.sl - (e.clientX - d.sx)
        wrap.scrollTop = d.st - (e.clientY - d.sy)
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) setDrag({ ...d, moved: true })
        return
      }
      const p = toCanvas(e)
      if (d.mode === 'move') {
        const dx = p.x - d.startX
        const dy = p.y - d.startY
        store.getState().updateCells(Object.keys(d.origin), (c) => {
          const o = d.origin[c.id]
          return { x: Math.max(0, snap(o.x + dx)), y: Math.max(0, snap(o.y + dy)) }
        })
      } else if (d.mode === 'resize') {
        const dx = p.x - d.startX
        const dy = p.y - d.startY
        const b = d.box
        const patch: Partial<Cell> = {}
        if (d.dir.includes('e')) patch.w = Math.max(120, snap(b.w + dx))
        if (d.dir.includes('s')) {
          patch.h = Math.max(60, snap(b.h + dy))
          patch.autoHeight = false
        }
        if (d.dir.includes('w')) {
          const nx = Math.max(0, snap(b.x + dx))
          patch.x = nx
          patch.w = Math.max(120, b.w + (b.x - nx))
        }
        if (d.dir.includes('n')) {
          const ny = Math.max(0, snap(b.y + dy))
          patch.y = ny
          patch.h = Math.max(60, b.h + (b.y - ny))
          patch.autoHeight = false
        }
        store.getState().updateCell(d.id, patch)
      } else if (d.mode === 'marquee') {
        setDrag({ ...d, x1: p.x, y1: p.y })
      } else if (d.mode === 'space') {
        setDrag({ ...d, dy: snap(p.y - d.atY) })
      } else if (d.mode === 'ink') {
        const pts = d.stroke.points
        const lx = pts[pts.length - 2]
        const ly = pts[pts.length - 1]
        if (Math.hypot(p.x - lx, p.y - ly) > 1.6) setDrag({ mode: 'ink', stroke: { ...d.stroke, points: [...pts, p.x, p.y] } })
      }
    }

    const up = () => {
      const d = dragRef.current
      if (d.mode === 'marquee') {
        const x0 = Math.min(d.x0, d.x1)
        const x1 = Math.max(d.x0, d.x1)
        const y0 = Math.min(d.y0, d.y1)
        const y1 = Math.max(d.y0, d.y1)
        if (Math.abs(x1 - x0) > 4 || Math.abs(y1 - y0) > 4) {
          const hit = (store.getState().page?.cells || [])
            .filter((c) => c.x < x1 && c.x + c.w > x0 && c.y < y1 && c.y + c.h > y0)
            .map((c) => c.id)
          store.getState().setSelection(hit)
        }
      } else if (d.mode === 'space' && Math.abs(d.dy) >= settings.gridSize) {
        store.getState().insertSpace(d.atY, d.dy)
      } else if (d.mode === 'ink' && d.stroke.points.length >= 4) {
        store.getState().addPageStroke(d.stroke)
      }
      setDrag({ mode: 'none' })
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag.mode, snap, toCanvas, settings.gridSize, store])

  /* -------- imported pages tidy themselves once -------- */
  useEffect(() => {
    if (!page?.needsReflow) return
    const id = page.id
    // Two frames plus a beat so every cell has reported its real height.
    const t = setTimeout(() => {
      const st = useStore.getState()
      if (st.page?.id !== id) return
      st.reflowOverlaps(false)
      const fresh = useStore.getState().page
      if (fresh && fresh.id === id) {
        useStore.setState({ page: { ...fresh, needsReflow: false }, dirty: true })
        st.save()
      }
    }, 700)
    return () => clearTimeout(t)
  }, [page?.id, page?.needsReflow])

  /* -------- zoom with ctrl + wheel -------- */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const s = useStore.getState()
      const before = s.zoom
      const rect = el.getBoundingClientRect()
      // Point under the cursor, in canvas coordinates.
      const cx = (el.scrollLeft + e.clientX - rect.left) / before
      const cy = (el.scrollTop + e.clientY - rect.top) / before
      s.setZoom(before + (e.deltaY < 0 ? s.settings.zoomStep : -s.settings.zoomStep))
      const after = useStore.getState().zoom
      if (after === before) return
      // Keep that same point parked under the cursor.
      requestAnimationFrame(() => {
        el.scrollLeft = cx * after - (e.clientX - rect.left)
        el.scrollTop = cy * after - (e.clientY - rect.top)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (!page) {
    return (
      <div className="canvas-wrap">
        <div className="empty-hint" style={{ padding: 40 }}>
          No page open. Create one in the page list on the left.
        </div>
      </div>
    )
  }

  const cells = [...page.cells].sort((a, b) => a.z - b.z)

  const cellMenu = (cell: Cell, e: React.MouseEvent): MenuItem[] => {
    const ids = selection.includes(cell.id) ? selection : [cell.id]
    const st = store.getState()
    return [
      { label: 'Duplicate', hint: 'Ctrl+D', icon: <Copy />, onClick: () => st.duplicateCells(ids) },
      { label: cell.collapsed ? 'Expand' : 'Collapse', onClick: () => st.updateCell(cell.id, { collapsed: !cell.collapsed }, true) },
      { label: cell.showTitle ? 'Hide title' : 'Show title', onClick: () => st.updateCell(cell.id, { showTitle: !cell.showTitle }, true) },
      { label: cell.autoHeight ? 'Fixed height' : 'Fit height to text', onClick: () => st.updateCell(cell.id, { autoHeight: !cell.autoHeight }, true) },
      { label: cell.locked ? 'Unlock' : 'Lock position', onClick: () => st.updateCell(cell.id, { locked: !cell.locked }, true) },
      { separator: true },
      { label: 'Bring to front', icon: <Layers />, onClick: () => st.bringToFront(ids) },
      { label: 'Send to back', icon: <Layers />, onClick: () => st.sendToBack(ids) },
      { separator: true },
      { title: 'Cell background' },
      { label: 'Default', onClick: () => st.updateCells(ids, () => ({ bg: '' })) },
      ...['#2d2320', '#252d22', '#202a33', '#2b2536', '#332d20'].map((c) => ({
        label: c,
        icon: <span className="swatch" style={{ background: c, width: 14, height: 14 }} />,
        onClick: () => st.updateCells(ids, () => ({ bg: c })),
      })),
      { separator: true },
      { label: ids.length > 1 ? `Delete ${ids.length} cells` : 'Delete cell', danger: true, icon: <Trash />, onClick: () => st.deleteCells(ids) },
    ]
  }

  const canvasMenu = (p: { x: number; y: number }): MenuItem[] => {
    const st = store.getState()
    return [
      { label: 'New cell here', icon: <Plus />, onClick: () => st.addCell({ x: snap(p.x), y: snap(p.y) }) },
      { label: 'Paste', hint: 'Ctrl+V', onClick: () => pasteIntoNewCell(snap(p.x), snap(p.y)) },
      { separator: true },
      { label: 'Insert space here', icon: <SpaceI />, onClick: () => st.setTool('space') },
      { label: 'Select all cells', hint: 'Ctrl+A', onClick: () => st.setSelection(page.cells.map((c) => c.id)) },
      { label: 'Tidy layout, remove overlaps', onClick: () => st.reflowOverlaps() },
      { separator: true },
      { label: 'Clear page ink', onClick: () => st.clearPageInk() },
    ]
  }

  async function pasteIntoNewCell(x: number, y: number) {
    const text = await navigator.clipboard.readText().catch(() => '')
    const st = useStore.getState()
    const id = st.addCell({ x, y })
    if (text) {
      const { looksLikeMarkdown, markdownToHtml } = await import('../editor/markdown')
      st.updateCell(id, { html: looksLikeMarkdown(text) ? markdownToHtml(text) : `<p>${escapeHtml(text)}</p>` })
    }
  }

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${tool} ${drag.mode === 'pan' ? 'panning' : ''}`}
      tabIndex={0}
      onPointerDown={onCanvasPointerDown}
      onContextMenu={(e) => {
        e.preventDefault()
        const d = dragRef.current
        if (d.mode === 'pan' && d.moved) return
        const target = (e.target as HTMLElement).closest('.cell') as HTMLElement | null
        if (target) {
          const cell = page.cells.find((c) => c.id === target.dataset.cellId)
          if (cell) setMenu({ x: e.clientX, y: e.clientY, items: cellMenu(cell, e) })
        } else {
          setMenu({ x: e.clientX, y: e.clientY, items: canvasMenu(toCanvas(e)) })
        }
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.cell')) return
        if (!settings.newCellAtClick) return
        const p = toCanvas(e)
        store.getState().addCell({ x: snap(p.x), y: snap(p.y) })
      }}
    >
      {/* The outer box carries the scaled size so scrollbars stay correct. */}
      <div style={{ width: size.w * zoom, height: size.h * zoom, minWidth: '100%', minHeight: '100%', position: 'relative' }}>
      <div
        ref={canvasRef}
        className={`canvas ${settings.showGrid ? `bg-${settings.pageBackground}` : ''}`}
        style={{
          width: size.w,
          height: size.h,
          minWidth: `${100 / zoom}%`,
          minHeight: `${100 / zoom}%`,
          transform: `scale(${zoom})`,
          backgroundSize: `${settings.gridSize}px ${settings.gridSize}px`,
        }}
      >
        <div className="page-title-wrap">
          <input
            className="page-title"
            value={page.title}
            placeholder="Untitled page"
            spellCheck={settings.spellcheck}
            style={{ fontSize: settings.pageTitleSize }}
            onChange={(e) => store.getState().setPageTitle(e.target.value)}
          />
          {settings.showPageDate && (
            <div style={{ color: 'var(--text-faint)', fontSize: 12, paddingTop: 6 }}>
              {new Date(page.updatedAt).toLocaleString()}
            </div>
          )}
        </div>

        {/* ink behind the cells */}
        <svg className="ink-layer" width={size.w} height={size.h}>
          {page.strokes.map((s, i) => (
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
          {drag.mode === 'ink' && (
            <polyline
              points={pairs(drag.stroke.points)}
              fill="none"
              stroke={drag.stroke.color}
              strokeWidth={drag.stroke.size}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={drag.stroke.size > 10 ? 0.38 : 1}
            />
          )}
        </svg>

        {cells.map((cell) => (
          <CellView
            key={cell.id}
            cell={cell}
            settings={settings}
            selected={selection.includes(cell.id)}
            editing={editingCellId === cell.id}
            onSelect={(e) => {
              if (e.button === 2) return
              const st = store.getState()
              // Clicking the frame rather than the text selects the cell, so
              // Delete removes it instead of typing into it.
              const inText = (e.target as HTMLElement).closest('.ProseMirror, .cell-title')
              if (!inText) {
                ;(document.activeElement as HTMLElement | null)?.blur()
                store.setState({ editingCellId: null })
              }
              if (e.shiftKey || e.ctrlKey) {
                st.setSelection(
                  selection.includes(cell.id) ? selection.filter((i) => i !== cell.id) : [...selection, cell.id],
                )
              } else if (!selection.includes(cell.id)) {
                st.setSelection([cell.id])
              }
            }}
            onStartEdit={() => store.setState({ editingCellId: cell.id, selection: [cell.id] })}
            onDragStart={(e) => {
              if (cell.locked || e.button !== 0) return
              e.preventDefault()
              const st = store.getState()
              
              // Ensure we exit text editing mode so Delete removes the cell, not text.
              ;(document.activeElement as HTMLElement | null)?.blur()
              store.setState({ editingCellId: null })

              const ids = st.selection.includes(cell.id) ? st.selection : [cell.id]
              if (!st.selection.includes(cell.id)) st.setSelection([cell.id])
              st.pushHistory()
              const p = toCanvas(e)
              const origin: Record<string, { x: number; y: number }> = {}
              for (const c of page.cells) if (ids.includes(c.id)) origin[c.id] = { x: c.x, y: c.y }
              setDrag({ mode: 'move', startX: p.x, startY: p.y, origin })
            }}
            onResizeStart={(e, dir) => {
              e.preventDefault()
              e.stopPropagation()
              const st = store.getState()

              // Ensure we exit text editing mode.
              ;(document.activeElement as HTMLElement | null)?.blur()
              store.setState({ editingCellId: null })

              st.pushHistory()
              const p = toCanvas(e)
              setDrag({ mode: 'resize', id: cell.id, dir, startX: p.x, startY: p.y, box: { ...cell } })
            }}
            onChange={(patch) => store.getState().updateCell(cell.id, patch)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ x: e.clientX, y: e.clientY, items: cellMenu(cell, e) })
            }}
            onDeleteSelf={() => store.getState().deleteCells([cell.id])}
          />
        ))}

        {drag.mode === 'marquee' && (
          <div
            className="marquee"
            style={{
              left: Math.min(drag.x0, drag.x1),
              top: Math.min(drag.y0, drag.y1),
              width: Math.abs(drag.x1 - drag.x0),
              height: Math.abs(drag.y1 - drag.y0),
            }}
          />
        )}

        {drag.mode === 'space' && (
          <>
            <div className="space-guide" style={{ top: drag.atY }} />
            <div
              className="space-fill"
              style={{ top: drag.dy >= 0 ? drag.atY : drag.atY + drag.dy, height: Math.abs(drag.dy) }}
            />
          </>
        )}
      </div>
      </div>

      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function pairs(pts: number[]) {
  const out: string[] = []
  for (let i = 0; i < pts.length; i += 2) out.push(`${pts[i]},${pts[i + 1]}`)
  return out.join(' ')
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}
