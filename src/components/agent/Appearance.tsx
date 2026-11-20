/**
 * How the assistant panel reads: text size, line spacing, reply width, and a
 * wide mode. Ctrl + wheel, Ctrl + plus / minus / 0 over the panel change the
 * text size (instead of zooming the page).
 */
import React, { useEffect, useRef, useState } from 'react'
import { useAgent } from '../../agent/store'

export const MIN_SCALE = 0.75
export const MAX_SCALE = 1.75
const clampScale = (v: number) => Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, v)) * 20) / 20

/** The narrowest the page next to the panel may get. */
const PAGE_ROOM = 140

/** As wide as the panel can get: the room in its row (the side panes stay), less a strip of page. */
export const maxPanelWidth = () => {
  const row = document.querySelector('.agent-panel')?.parentElement
  const panes = row ? [...row.children].filter((c) => !c.classList.contains('agent-panel') && !c.classList.contains('ag-resizer')) : []
  // Everything else in the row except the page area itself keeps its width.
  const fixed = panes.filter((c) => !c.querySelector('.canvas-wrap')).reduce((n, c) => n + (c as HTMLElement).offsetWidth, 0)
  const room = (row ? row.clientWidth : window.innerWidth) - fixed
  return Math.max(320, room - PAGE_ROOM)
}

/** Style variables for the panel. */
export function appearanceVars(p: { textScale?: number; spacing?: string; readWidth?: string }): React.CSSProperties {
  const lh = p.spacing === 'compact' ? 1.42 : p.spacing === 'airy' ? 1.75 : 1.55
  const read = p.readWidth === 'narrow' ? '640px' : p.readWidth === 'full' ? 'none' : '860px'
  return { ['--ag-zoom' as any]: String(p.textScale || 1), ['--ag-lh' as any]: String(lh), ['--ag-read' as any]: read }
}

export function setTextScale(v: number) {
  useAgent.getState().setPrefs({ textScale: clampScale(v) })
  flashScale(clampScale(v))
}

let flashTimer = 0
function flashScale(v: number) {
  window.dispatchEvent(new CustomEvent('ag-scale-flash', { detail: v }))
  clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => window.dispatchEvent(new CustomEvent('ag-scale-flash', { detail: 0 })), 900)
}

/** Expand the docked panel over most of the window, or back to where it was. */
export function toggleExpand() {
  const { prefs, setPrefs } = useAgent.getState()
  const big = Math.round(maxPanelWidth() * 0.97)
  if (prefs.width >= big - 40) setPrefs({ width: Math.min(prefs.widthBeforeExpand || 420, maxPanelWidth()) })
  else setPrefs({ widthBeforeExpand: prefs.width, width: big, mode: 'pane' })
}

export const isExpanded = (w: number) => w >= Math.round(maxPanelWidth() * 0.97) - 40

/** Ctrl + wheel and Ctrl + plus / minus / 0 inside the panel size its text. */
export function useTextZoomKeys(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const cur = useAgent.getState().prefs.textScale || 1
      setTextScale(cur + (e.deltaY < 0 ? 0.05 : -0.05))
    }
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return
      if (!el.contains(document.activeElement) && !el.matches(':hover')) return
      const cur = useAgent.getState().prefs.textScale || 1
      let next: number | null = null
      if (e.key === '+' || e.key === '=') next = cur + 0.1
      else if (e.key === '-') next = cur - 0.1
      else if (e.key === '0') next = 1
      if (next === null) return
      e.preventDefault()
      e.stopPropagation()
      setTextScale(next)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('keydown', key, true)
    return () => {
      el.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', key, true)
    }
  }, [ref])
}

/** A short "Text 115%" badge while the size changes. */
export function ScaleFlash() {
  const [v, setV] = useState(0)
  useEffect(() => {
    const on = (e: Event) => setV((e as CustomEvent).detail || 0)
    window.addEventListener('ag-scale-flash', on)
    return () => window.removeEventListener('ag-scale-flash', on)
  }, [])
  if (!v) return null
  return <div className="ag-scale-flash">Text {Math.round(v * 100)}%</div>
}

const TextSizeI = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 19l5-13 5 13M4.8 14.5h6.4" />
    <path d="M14.5 19l3.5-9 3.5 9M15.6 16h4.8" />
  </svg>
)

export const ExpandI = ({ size = 15, on }: { size?: number; on?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {on ? <path d="M14 4v6h6M10 20v-6H4M20 4l-6 6M4 20l6-6" /> : <path d="M15 4h5v5M9 20H4v-5M20 4l-7 7M4 20l7-7" />}
  </svg>
)

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="ag-ap-seg">
      {options.map((o) => (
        <button key={o.v} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** The "Aa" button and its menu. */
export function AppearanceButton() {
  const prefs = useAgent((s) => s.prefs)
  const setPrefs = useAgent((s) => s.setPrefs)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', off)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  const scale = prefs.textScale || 1
  return (
    <div className="ag-ap-wrap" ref={box}>
      <button className={`ag-icon-btn ${open ? 'on' : ''}`} title="Text size and layout (Ctrl + wheel over the chat)" onClick={() => setOpen(!open)}>
        <TextSizeI />
      </button>
      {open && (
        <div className="ag-ap">
          <div className="ag-ap-row">
            <span className="ag-ap-label">Text size</span>
            <span className="ag-ap-val">{Math.round(scale * 100)}%</span>
          </div>
          <div className="ag-ap-size">
            <button title="Smaller (Ctrl -)" onClick={() => setTextScale(scale - 0.05)} disabled={scale <= MIN_SCALE}>
              <span style={{ fontSize: 11 }}>A</span>
            </button>
            <input type="range" min={MIN_SCALE} max={MAX_SCALE} step={0.05} value={scale} onChange={(e) => setTextScale(Number(e.target.value))} />
            <button title="Bigger (Ctrl +)" onClick={() => setTextScale(scale + 0.05)} disabled={scale >= MAX_SCALE}>
              <span style={{ fontSize: 17 }}>A</span>
            </button>
          </div>
          <div className="ag-ap-presets">
            {[0.9, 1, 1.15, 1.3, 1.5].map((v) => (
              <button key={v} className={Math.abs(scale - v) < 0.01 ? 'on' : ''} onClick={() => setTextScale(v)}>
                {Math.round(v * 100)}
              </button>
            ))}
          </div>
          <div className="ag-ap-row">
            <span className="ag-ap-label">Line spacing</span>
          </div>
          <Seg
            value={prefs.spacing || 'normal'}
            onChange={(spacing) => setPrefs({ spacing })}
            options={[
              { v: 'compact', label: 'Compact' },
              { v: 'normal', label: 'Normal' },
              { v: 'airy', label: 'Airy' },
            ]}
          />
          <div className="ag-ap-row">
            <span className="ag-ap-label">Reply width in a wide panel</span>
          </div>
          <Seg
            value={prefs.readWidth || 'normal'}
            onChange={(readWidth) => setPrefs({ readWidth })}
            options={[
              { v: 'narrow', label: 'Narrow' },
              { v: 'normal', label: 'Normal' },
              { v: 'full', label: 'Full' },
            ]}
          />
          <label className="ag-ap-check">
            <input type="checkbox" checked={prefs.showThinking} onChange={(e) => setPrefs({ showThinking: e.target.checked })} />
            Show the model's reasoning
          </label>
          <button className="ag-ap-reset" onClick={() => setPrefs({ textScale: 1, spacing: 'normal', readWidth: 'normal' })}>
            Reset
          </button>
        </div>
      )}
    </div>
  )
}

/** "Latest" pill when you scrolled up while new text keeps coming. */
export function JumpToLatest({ scrollRef, onJump }: { scrollRef: React.RefObject<HTMLDivElement>; onJump(): void }) {
  const [away, setAway] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = () => setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 220)
    el.addEventListener('scroll', check, { passive: true })
    window.addEventListener('ag-stream-grow', check)
    check()
    return () => {
      el.removeEventListener('scroll', check)
      window.removeEventListener('ag-stream-grow', check)
    }
  }, [scrollRef])
  if (!away) return null
  return (
    <button className="ag-jump" onClick={onJump} title="Jump to the latest message">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M6 13l6 6 6-6" />
      </svg>
      Latest
    </button>
  )
}
