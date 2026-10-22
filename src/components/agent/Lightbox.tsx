import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { blobUrl, type ChatAttachment } from '../../agent/api'
import { ArrowLeft, ArrowRight, Copy, Download, FitI, RotateI, X, ZoomIn, ZoomOut } from '../Icons'
import { Menu, type MenuItem } from '../Menu'
import { clearHover, copyImage, hoverCopy, saveImage } from './imageCopy'

export interface LightboxItem {
  sha: string
  mime: string
  name: string
}

export function useBlobUrl(sha: string, mime: string) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    blobUrl(sha, mime).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [sha, mime])
  return url
}

export function AttachmentThumb({ att, big, onClick, title }: { att: ChatAttachment | LightboxItem; big?: boolean; onClick?(): void; title?: string }) {
  const url = useBlobUrl(att.sha, att.mime)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => () => clearHover(att.sha), [att.sha])
  return (
    <>
      <button
        className={`ag-thumb ${big ? 'big' : ''}`}
        onClick={onClick}
        title={title ?? `${att.name}: click to view, Ctrl+C to copy`}
        {...hoverCopy(att)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {url ? <img src={url} alt={att.name} draggable={false} /> : <span className="ag-thumb-wait" />}
      </button>
      {menu && <Menu x={menu.x} y={menu.y} items={imageMenu(att, onClick)} onClose={() => setMenu(null)} />}
    </>
  )
}

/** Right click on a picture. */
export function imageMenu(img: LightboxItem, open?: () => void, inViewer = false): MenuItem[] {
  return [
    ...(open ? [{ label: 'Open', onClick: open }] : []),
    { label: 'Copy image', hint: 'Ctrl+C', icon: <Copy />, onClick: () => copyImage(img) },
    { label: 'Save image as...', hint: inViewer ? 'Ctrl+S' : undefined, icon: <Download />, onClick: () => saveImage(img) },
  ]
}

const MIN = 0.1
const MAX = 12
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z))

function StripThumb({ item, active, onClick }: { item: LightboxItem; active: boolean; onClick(): void }) {
  const url = useBlobUrl(item.sha, item.mime)
  return (
    <button className={`lb-strip-item ${active ? 'on' : ''}`} onClick={onClick} title={item.name}>
      {url && <img src={url} alt="" draggable={false} />}
    </button>
  )
}

/**
 * Full screen image viewer. Wheel zooms toward the cursor, drag pans at any
 * zoom, double click toggles fit and 2x at the clicked point, R rotates,
 * 1 shows actual pixels, arrows move between images.
 */
export function Lightbox({ items, index, onClose }: { items: LightboxItem[]; index: number; onClose(): void }) {
  const [i, setI] = useState(index)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [rot, setRot] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const moved = useRef(false)
  const item = items[i]
  const url = useBlobUrl(item.sha, item.mime)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan

  const reset = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }
  const go = (d: number) => {
    setI((v) => (v + d + items.length) % items.length)
    setRot(0)
    setNatural(null)
    reset()
  }

  /** Zoom to `next`, keeping the point under (cx, cy) in place (screen coords; default: center). */
  const zoomTo = (next: number, cx?: number, cy?: number) => {
    const z2 = clamp(next)
    const r = stage.current?.getBoundingClientRect()
    if (!r) return setZoom(z2)
    const px = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2)
    const py = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2)
    const k = z2 / zoomRef.current
    const p = panRef.current
    zoomRef.current = z2
    setZoom(z2)
    const np = z2 <= 1 ? { x: 0, y: 0 } : { x: px - (px - p.x) * k, y: py - (py - p.y) * k }
    panRef.current = np
    setPan(np)
  }

  /** Zoom at which the image shows at its real pixel size. */
  const actualZoom = () => {
    const el = img.current
    if (!el || !natural || !el.offsetWidth) return 1
    return natural.w / el.offsetWidth
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) copyImage(item)
      else if (mod && e.key.toLowerCase() === 's') saveImage(item)
      else if (mod) return
      else if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && items.length > 1) go(1)
      else if (e.key === 'ArrowLeft' && items.length > 1) go(-1)
      else if (e.key === '+' || e.key === '=') zoomTo(zoom * 1.25)
      else if (e.key === '-') zoomTo(zoom / 1.25)
      else if (e.key === '0') reset()
      else if (e.key === '1') zoomTo(actualZoom())
      else if (e.key === 'r' || e.key === 'R') setRot((v) => v + (e.shiftKey ? -90 : 90))
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Wheel needs a non-passive listener so the page behind never scrolls.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))
      zoomTo(zoomRef.current * f, e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    moved.current = false
    const s = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
    setDragging(true)
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - s.x
      const dy = ev.clientY - s.y
      if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true
      setPan({ x: s.px + dx, y: s.py + dy })
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const pct = Math.round(zoom * 100)

  return createPortal(
    <div
      className="lb"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="lb-bar">
        <span className="lb-name" title={item.name}>{item.name}</span>
        {items.length > 1 && <span className="lb-count">{i + 1} / {items.length}</span>}
        {natural && <span className="lb-count">{natural.w} x {natural.h}</span>}
        <div className="spacer" />
        <button className="lb-btn" onClick={() => saveImage(item)} title="Save image as (Ctrl+S)"><Download size={16} /></button>
        <button className="lb-btn" onClick={onClose} title="Close (Esc)"><X /></button>
      </div>

      <div
        ref={stage}
        className={`lb-stage ${dragging ? 'dragging' : ''}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && zoom <= 1) onClose()
          else if (e.target === e.currentTarget) startDrag(e)
        }}
      >
        {url && (
          <img
            ref={img}
            className="lb-img"
            src={url}
            alt={item.name}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rot}deg)`,
              cursor: dragging ? 'grabbing' : zoom > 1 ? 'grab' : 'zoom-in',
              transition: dragging ? 'none' : undefined,
            }}
            onMouseDown={startDrag}
            onClick={(e) => {
              if (!moved.current && zoom <= 1) zoomTo(2.5, e.clientX, e.clientY)
            }}
            onDoubleClick={(e) => (zoom > 1 ? reset() : zoomTo(2.5, e.clientX, e.clientY))}
          />
        )}
      </div>

      {items.length > 1 && (
        <>
          <button className="lb-nav left" onClick={() => go(-1)} title="Previous (Left)"><ArrowLeft size={20} /></button>
          <button className="lb-nav right" onClick={() => go(1)} title="Next (Right)"><ArrowRight size={20} /></button>
        </>
      )}

      <div className="lb-dock">
        {items.length > 1 && (
          <div className="lb-strip">
            {items.map((it, k) => (
              <StripThumb key={it.sha + k} item={it} active={k === i} onClick={() => go(k - i)} />
            ))}
          </div>
        )}
        <div className="lb-tools">
          <button className="lb-btn" onClick={() => zoomTo(zoom / 1.25)} title="Zoom out (-)"><ZoomOut size={17} /></button>
          <input
            className="lb-slider"
            type="range"
            min={Math.log(MIN)}
            max={Math.log(MAX)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(e) => zoomTo(Math.exp(Number(e.target.value)))}
            title="Zoom"
          />
          <button className="lb-btn" onClick={() => zoomTo(zoom * 1.25)} title="Zoom in (+)"><ZoomIn size={17} /></button>
          <span className="lb-sep" />
          <button className={`lb-btn pct ${zoom === 1 ? 'on' : ''}`} onClick={reset} title="Fit to screen (0)"><FitI size={16} /><span>{pct}%</span></button>
          <button className="lb-btn txt" onClick={() => zoomTo(actualZoom())} title="Actual size (1)">1:1</button>
          <button className="lb-btn" onClick={() => setRot((v) => v + 90)} title="Turn the view (R). To send a picture turned, edit it before sending."><RotateI size={16} /></button>
          <span className="lb-sep" />
          <button className="lb-btn" onClick={() => copyImage(item)} title="Copy image (Ctrl+C)"><Copy size={16} /></button>
        </div>
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={imageMenu(item, undefined, true)} onClose={() => setMenu(null)} />}
    </div>,
    document.body,
  )
}
