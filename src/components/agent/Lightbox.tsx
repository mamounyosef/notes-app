import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { blobUrl, type ChatAttachment } from '../../agent/api'
import { ArrowLeft, ArrowRight, X, ZoomIn, ZoomOut } from '../Icons'

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

export function AttachmentThumb({ att, big, onClick }: { att: ChatAttachment | LightboxItem; big?: boolean; onClick?(): void }) {
  const url = useBlobUrl(att.sha, att.mime)
  return (
    <button className={`ag-thumb ${big ? 'big' : ''}`} onClick={onClick} title={`${att.name}, click to view`}>
      {url ? <img src={url} alt={att.name} draggable={false} /> : <span className="ag-thumb-wait" />}
    </button>
  )
}

/** Full screen image viewer: wheel or buttons to zoom, drag to pan, arrows to move between images. */
export function Lightbox({ items, index, onClose }: { items: LightboxItem[]; index: number; onClose(): void }) {
  const [i, setI] = useState(index)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const item = items[i]
  const url = useBlobUrl(item.sha, item.mime)

  const reset = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }
  const go = (d: number) => {
    setI((v) => (v + d + items.length) % items.length)
    reset()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && items.length > 1) go(1)
      else if (e.key === 'ArrowLeft' && items.length > 1) go(-1)
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(8, z * 1.25))
      else if (e.key === '-') setZoom((z) => Math.max(0.2, z / 1.25))
      else if (e.key === '0') reset()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return createPortal(
    <div
      className="lb"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onWheel={(e) => {
        const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
        setZoom((z) => Math.min(8, Math.max(0.2, z * f)))
      }}
    >
      <div className="lb-bar">
        <span className="lb-name">{item.name}{items.length > 1 ? `  (${i + 1} of ${items.length})` : ''}</span>
        <div className="spacer" />
        <button className="lb-btn" onClick={() => setZoom((z) => Math.max(0.2, z / 1.25))} title="Zoom out (-)"><ZoomOut /></button>
        <button className="lb-btn pct" onClick={reset} title="Fit (0)">{Math.round(zoom * 100)}%</button>
        <button className="lb-btn" onClick={() => setZoom((z) => Math.min(8, z * 1.25))} title="Zoom in (+)"><ZoomIn /></button>
        <button className="lb-btn" onClick={onClose} title="Close (Esc)"><X /></button>
      </div>
      {items.length > 1 && (
        <>
          <button className="lb-nav left" onClick={() => go(-1)}><ArrowLeft size={20} /></button>
          <button className="lb-nav right" onClick={() => go(1)}><ArrowRight size={20} /></button>
        </>
      )}
      {url && (
        <img
          className={`lb-img ${drag.current ? 'dragging' : ''}`}
          src={url}
          alt={item.name}
          draggable={false}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, cursor: zoom > 1 ? 'grab' : 'zoom-in' }}
          onDoubleClick={() => (zoom === 1 ? setZoom(2) : reset())}
          onClick={() => zoom === 1 && setZoom(2)}
          onMouseDown={(e) => {
            if (zoom <= 1) return
            e.preventDefault()
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
            const move = (ev: MouseEvent) => {
              const d = drag.current
              if (d) setPan({ x: d.px + ev.clientX - d.x, y: d.py + ev.clientY - d.y })
            }
            const up = () => {
              drag.current = null
              window.removeEventListener('mousemove', move)
              window.removeEventListener('mouseup', up)
            }
            window.addEventListener('mousemove', move)
            window.addEventListener('mouseup', up)
          }}
        />
      )}
    </div>,
    document.body,
  )
}
