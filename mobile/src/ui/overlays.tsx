/**
 * Action sheets, prompts and toasts: one small store, shown by <Overlays />.
 */
import React, { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { onBack, tick } from '../platform'

export interface SheetItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  onClick(): void
}

interface SheetSpec {
  title?: string
  items: SheetItem[]
  colors?: { value: string; label: string; onPick(v: string): void; current?: string }
}

interface PromptSpec {
  title: string
  value: string
  placeholder?: string
  ok: string
  onOk(v: string): void
}

interface ConfirmSpec {
  title: string
  body?: string
  ok: string
  danger?: boolean
  onOk(): void
}

interface ToastSpec {
  text: string
  action?: { label: string; onClick(): void }
  ms?: number
}

interface OverlayState {
  sheet: SheetSpec | null
  prompt: PromptSpec | null
  confirm: ConfirmSpec | null
  toast: (ToastSpec & { id: number }) | null
}

export const useOverlay = create<OverlayState>(() => ({ sheet: null, prompt: null, confirm: null, toast: null }))

export function showSheet(spec: SheetSpec) {
  tick()
  useOverlay.setState({ sheet: spec })
}

export function askText(spec: PromptSpec) {
  useOverlay.setState({ prompt: spec, sheet: null })
}

export function askConfirm(spec: ConfirmSpec) {
  useOverlay.setState({ confirm: spec, sheet: null })
}

let toastId = 0
export function toast(text: string, action?: ToastSpec['action'], ms = 3500) {
  useOverlay.setState({ toast: { text, action, ms, id: ++toastId } })
}

export const COLORS = ['#e06c75', '#e5a07b', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#7c9cff', '#c678dd', '#abb2bf']

export function Overlays() {
  const { sheet, prompt, confirm, toast: t } = useOverlay()

  useEffect(() => {
    if (!sheet && !prompt && !confirm) return
    return onBack(() => {
      useOverlay.setState({ sheet: null, prompt: null, confirm: null })
      return true
    })
  }, [sheet, prompt, confirm])

  useEffect(() => {
    if (!t) return
    const timer = setTimeout(() => {
      if (useOverlay.getState().toast?.id === t.id) useOverlay.setState({ toast: null })
    }, t.ms || 3500)
    return () => clearTimeout(timer)
  }, [t])

  const close = () => useOverlay.setState({ sheet: null })

  return (
    <>
      {sheet && (
        <div className="m-sheet-wrap" onClick={(e) => e.target === e.currentTarget && close()}>
          <div className="m-sheet" role="menu">
            <div className="m-sheet-grab" />
            {sheet.title && <div className="m-sheet-title">{sheet.title}</div>}
            {sheet.colors && (
              <div className="m-sheet-colors">
                {['', ...COLORS].map((c) => (
                  <button
                    key={c || 'none'}
                    className={`m-swatch ${c ? '' : 'none'}`}
                    style={c ? { background: c, borderColor: sheet.colors!.current === c ? 'var(--text)' : undefined } : undefined}
                    aria-label={c || 'No color'}
                    onClick={() => {
                      close()
                      sheet.colors!.onPick(c)
                    }}
                  />
                ))}
              </div>
            )}
            {sheet.items.map((it) => (
              <button
                key={it.label}
                className={`m-sheet-item ${it.danger ? 'danger' : ''}`}
                onClick={() => {
                  close()
                  it.onClick()
                }}
              >
                {it.icon}
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {prompt && <PromptSheet spec={prompt} />}
      {confirm && (
        <div className="m-sheet-wrap" onClick={(e) => e.target === e.currentTarget && useOverlay.setState({ confirm: null })}>
          <div className="m-sheet" role="dialog">
            <div className="m-sheet-grab" />
            <div style={{ padding: '6px 22px 4px', fontSize: 17, fontWeight: 600 }}>{confirm.title}</div>
            {confirm.body && <div style={{ padding: '4px 22px 10px', color: 'var(--text-dim)', lineHeight: 1.45 }}>{confirm.body}</div>}
            <div style={{ display: 'flex', gap: 10, padding: '10px 20px 4px' }}>
              <button className="m-btn" style={{ flex: 1 }} onClick={() => useOverlay.setState({ confirm: null })}>
                Cancel
              </button>
              <button
                className={`m-btn ${confirm.danger ? 'danger' : 'primary'}`}
                style={{ flex: 1 }}
                onClick={() => {
                  useOverlay.setState({ confirm: null })
                  confirm.onOk()
                }}
              >
                {confirm.ok}
              </button>
            </div>
          </div>
        </div>
      )}
      {t && (
        <div className="m-toast" role="status">
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                useOverlay.setState({ toast: null })
                t.action!.onClick()
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      )}
    </>
  )
}

function PromptSheet({ spec }: { spec: PromptSpec }) {
  const [v, setV] = useState(spec.value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus()
      ref.current?.select()
    }, 60)
    return () => clearTimeout(t)
  }, [])
  const done = () => {
    useOverlay.setState({ prompt: null })
    if (v.trim()) spec.onOk(v.trim())
  }
  return (
    <div className="m-sheet-wrap" style={{ paddingBottom: 'var(--kb)' }} onClick={(e) => e.target === e.currentTarget && useOverlay.setState({ prompt: null })}>
      <div className="m-sheet" role="dialog">
        <div className="m-sheet-grab" />
        <div style={{ padding: '6px 20px 8px', fontSize: 16, fontWeight: 600 }}>{spec.title}</div>
        <input
          ref={ref}
          className="m-field"
          value={v}
          placeholder={spec.placeholder}
          enterKeyHint="done"
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && done()}
        />
        <div style={{ display: 'flex', gap: 10, padding: '0 20px 4px' }}>
          <button className="m-btn" style={{ flex: 1 }} onClick={() => useOverlay.setState({ prompt: null })}>
            Cancel
          </button>
          <button className="m-btn primary" style={{ flex: 1 }} onClick={done}>
            {spec.ok}
          </button>
        </div>
      </div>
    </div>
  )
}
