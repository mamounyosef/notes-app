/**
 * A small map of the whole page in the corner of the canvas: every cell as a
 * block, the ink as thin lines, and the part on screen as an outlined box.
 * Click to jump there, drag the box to move around, wheel to scroll.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Page } from '../types'

const MAX_W = 180
const MAX_H = 150

interface View {
  sl: number
  st: number
  cw: number
  ch: number
}

export default function Minimap({ wrap, page, size, zoom }: { wrap: HTMLDivElement | null; page: Page; size: { w: number; h: number }; zoom: number }) {
  const [view, setView] = useState<View>({ sl: 0, st: 0, cw: 0, ch: 0 })
  const grab = useRef<{ dx: number; dy: number } | null>(null)
  const box = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!wrap) return
    let frame = 0
    const read = () => {
      frame = 0
      setView({ sl: wrap.scrollLeft, st: wrap.scrollTop, cw: wrap.clientWidth, ch: wrap.clientHeight })
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    wrap.addEventListener('scroll', later, { passive: true })
    const ro = new ResizeObserver(later)
    ro.observe(wrap)
    return () => {
      wrap.removeEventListener('scroll', later)
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [wrap])

  // Page units on the map.
  const k = Math.min(MAX_W / size.w, MAX_H / size.h)
  const mw = Math.round(size.w * k)
  const mh = Math.round(size.h * k)

  const ink = useMemo(
    () =>
      page.strokes.map((s) => {
        let pts = ''
        // Every few points is plenty at this size.
        const step = Math.max(2, Math.floor(s.points.length / 120) * 2)
        for (let i = 0; i < s.points.length; i += step) pts += `${s.points[i]},${s.points[i + 1]} `
        return { pts, color: s.color, faint: s.size > 10 }
      }),
    [page.strokes],
  )

  if (!wrap || !view.cw) return null
  // Everything fits on screen: no map needed.
  if (size.w * zoom <= view.cw + 4 && size.h * zoom <= view.ch + 4) return null

  const vx = view.sl / zoom
  const vy = view.st / zoom
  const vw = Math.min(size.w, view.cw / zoom)
  const vh = Math.min(size.h, view.ch / zoom)

  const toPage = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }
  const scrollTo = (x: number, y: number, smooth = false) =>
    wrap.scrollTo({ left: x * zoom, top: y * zoom, behavior: smooth ? 'smooth' : 'auto' })

  return (
    <div className="minimap" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <svg
        ref={box}
        width={mw}
        height={mh}
        viewBox={`0 0 ${size.w} ${size.h}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          const p = toPage(e)
          const inside = p.x >= vx && p.x <= vx + vw && p.y >= vy && p.y <= vy + vh
          // Grab the box where it was clicked, or jump so the click is the middle of the screen.
          grab.current = inside ? { dx: p.x - vx, dy: p.y - vy } : { dx: vw / 2, dy: vh / 2 }
          if (!inside) scrollTo(p.x - vw / 2, p.y - vh / 2, true)
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!grab.current) return
          const p = toPage(e)
          scrollTo(p.x - grab.current.dx, p.y - grab.current.dy)
        }}
        onPointerUp={() => (grab.current = null)}
        onPointerCancel={() => (grab.current = null)}
        onWheel={(e) => wrap.scrollBy({ left: e.shiftKey ? e.deltaY : e.deltaX, top: e.shiftKey ? 0 : e.deltaY })}
      >
        <rect className="mm-page" x={0} y={0} width={size.w} height={size.h} />
        {ink.map((s, i) => (
          <polyline key={i} points={s.pts} fill="none" stroke={s.color} strokeWidth={2 / k} opacity={s.faint ? 0.35 : 0.8} strokeLinecap="round" />
        ))}
        {page.cells.map((c) => (
          <rect
            key={c.id}
            className="mm-cell"
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.collapsed ? 30 : c.h}
            rx={4 / k}
            style={c.bg ? { fill: c.bg } : undefined}
          />
        ))}
        <rect className="mm-view" x={vx} y={vy} width={vw} height={vh} rx={3 / k} strokeWidth={1.5 / k} />
      </svg>
    </div>
  )
}
