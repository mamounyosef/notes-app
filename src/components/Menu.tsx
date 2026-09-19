import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label?: string
  hint?: string
  icon?: React.ReactNode
  danger?: boolean
  separator?: boolean
  title?: string
  onClick?: () => void
}

/** A context / dropdown menu that always stays inside the window. */
export function Menu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    })
  }, [x, y, items.length])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} className="popover" style={{ left: pos.x, top: pos.y, position: 'fixed' }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="pop-sep" />
        ) : it.title ? (
          <div key={i} className="pop-title">{it.title}</div>
        ) : (
          <button
            key={i}
            className="pop-item"
            style={it.danger ? { color: '#e06c75' } : undefined}
            onClick={() => {
              it.onClick?.()
              onClose()
            }}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  )
}
