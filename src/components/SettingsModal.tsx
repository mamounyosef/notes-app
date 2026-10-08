import React, { useState, useEffect } from 'react'
import { useStore } from '../store'
import { DEFAULT_SETTINGS, type Settings } from '../types'
import { storage, isDesktop } from '../lib/storage'
import { askConfirm } from '../lib/confirm'
import { X, Plus, Min, Undo } from './Icons'
import { SHORTCUTS, prettyShortcut, shortcutFromEvent, type ShortcutKey } from '../editor/shortcuts'

function getDecimals(step: number): number {
  const str = step.toString()
  const dot = str.indexOf('.')
  return dot >= 0 ? str.length - dot - 1 : 0
}

function formatVal(val: number, decimals: number): string {
  if (isNaN(val)) return '0'
  return Number(val.toFixed(decimals)).toString()
}

function snapToStep(val: number, step: number, min: number, decimals: number): number {
  const snapped = Math.round((val - min) / step) * step + min
  return Number(snapped.toFixed(decimals))
}

interface NumSliderProps {
  label: string
  sub?: string
  min: number
  max: number
  step?: number
  unit?: string
  val: number
  defaultVal?: number
  onChange: (val: number) => void
}

function NumSlider({
  label,
  sub,
  min,
  max,
  step = 1,
  unit = '',
  val,
  defaultVal,
  onChange,
}: NumSliderProps) {
  const decimals = getDecimals(step)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(() => formatVal(val, decimals))

  useEffect(() => {
    if (!isEditing) {
      setEditText(formatVal(val, decimals))
    }
  }, [val, decimals, isEditing])

  const commit = (nextVal: number) => {
    const clamped = Math.min(max, Math.max(min, nextVal))
    const snapped = snapToStep(clamped, step, min, decimals)
    onChange(snapped)
    setEditText(formatVal(snapped, decimals))
  }

  const commitText = () => {
    const parsed = parseFloat(editText)
    if (isNaN(parsed)) {
      setEditText(formatVal(val, decimals))
    } else {
      commit(parsed)
    }
    setIsEditing(false)
  }

  const stepBy = (direction: number) => {
    let baseVal = val
    if (isEditing) {
      const parsed = parseFloat(editText)
      if (!isNaN(parsed)) {
        baseVal = parsed
      }
    }
    const next = baseVal + direction * step
    commit(next)
  }

  const pct = max > min ? Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100)) : 0
  const isModified = defaultVal !== undefined && Math.abs(val - defaultVal) > 0.0001
  const cleanUnit = unit.trim()

  return (
    <div className="set-row has-slider">
      <label>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </label>
      <div className="slider-control">
        <div className="slider-track-wrap">
          <input
            type="range"
            className="slider-input-range"
            min={min}
            max={max}
            step={step}
            value={val}
            style={{
              '--slider-bg': `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--bg-4) ${pct}%, var(--bg-4) 100%)`,
            } as React.CSSProperties}
            onChange={(e) => commit(Number(e.target.value))}
            onDoubleClick={() => defaultVal !== undefined && commit(defaultVal)}
            title={defaultVal !== undefined ? `Double-click to reset (${formatVal(defaultVal, decimals)}${cleanUnit ? ' ' + cleanUnit : ''})` : undefined}
          />
        </div>

        <div className="slider-val-box">
          <button
            type="button"
            className="slider-step-btn"
            title="Decrease"
            disabled={val <= min}
            onClick={() => stepBy(-1)}
            tabIndex={-1}
          >
            <Min size={12} />
          </button>
          <input
            type="text"
            inputMode="decimal"
            className="slider-num-input"
            value={isEditing ? editText : formatVal(val, decimals)}
            onFocus={(e) => {
              setIsEditing(true)
              setEditText(formatVal(val, decimals))
              e.target.select()
            }}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitText()
                ;(e.target as HTMLElement).blur()
              } else if (e.key === 'Escape') {
                setEditText(formatVal(val, decimals))
                setIsEditing(false)
                ;(e.target as HTMLElement).blur()
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                stepBy(1)
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                stepBy(-1)
              }
            }}
            onWheel={(e) => {
              if (isEditing) {
                e.preventDefault()
                stepBy(e.deltaY < 0 ? 1 : -1)
              }
            }}
            onBlur={commitText}
          />
          {cleanUnit && <span className="slider-unit">{cleanUnit}</span>}
          <button
            type="button"
            className="slider-step-btn"
            title="Increase"
            disabled={val >= max}
            onClick={() => stepBy(1)}
            tabIndex={-1}
          >
            <Plus size={12} />
          </button>
        </div>

        {defaultVal !== undefined ? (
          isModified ? (
            <button
              type="button"
              className="slider-reset-btn"
              title={`Reset to default (${formatVal(defaultVal, decimals)}${cleanUnit ? ' ' + cleanUnit : ''})`}
              onClick={() => commit(defaultVal)}
              tabIndex={-1}
            >
              <Undo size={13} />
            </button>
          ) : (
            <div className="slider-reset-placeholder" />
          )
        ) : null}
      </div>
    </div>
  )
}

/** A shortcut field that records the next key combination pressed. */
function ShortcutRow({
  label, value, defaultValue, warning, onChange,
}: { label: string; value: string; defaultValue: string; warning?: string; onChange(v: string): void }) {
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  return (
    <div className="set-row">
      <label>
        {label}
        {(hint || warning) && <span className="sub" style={{ color: 'var(--danger, #e06c75)' }}>{hint || warning}</span>}
      </label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          className={`btn shortcut-rec ${recording ? 'recording' : ''}`}
          onClick={() => { setRecording(true); setHint(null) }}
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            if (!recording) return
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'Escape') { setRecording(false); return }
            if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey) {
              onChange('')
              setRecording(false)
              return
            }
            const combo = shortcutFromEvent(e)
            if (!combo) return
            const fnKey = /^F\d{1,2}$/.test(e.key)
            if (!e.ctrlKey && !e.altKey && !e.metaKey && !fnKey) {
              setHint('Use Ctrl, Alt or Win with a key, or a function key')
              return
            }
            setHint(null)
            onChange(combo)
            setRecording(false)
          }}
          style={{ minWidth: 150 }}
        >
          {recording ? 'Press keys...' : value ? prettyShortcut(value) : 'None'}
        </button>
        {value !== defaultValue ? (
          <button
            type="button"
            className="slider-reset-btn"
            title={`Reset to default (${prettyShortcut(defaultValue)})`}
            onClick={() => { onChange(defaultValue); setHint(null) }}
          >
            <Undo size={13} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

const THEMES: { id: Settings['theme']; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'nord', label: 'Nord' },
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'system', label: 'Follow system' },
]

const FONT_CHOICES = [
  'Segoe UI, system-ui, sans-serif',
  'Calibri, sans-serif',
  'Georgia, serif',
  'Times New Roman, serif',
  'Verdana, sans-serif',
  'Arial, sans-serif',
  'Cascadia Code, Consolas, monospace',
]

export default function SettingsModal({ onClose }: { onClose(): void }) {
  const settings = useStore((s) => s.settings)
  const set = useStore((s) => s.setSettings)
  const vaultPath = useStore((s) => s.vaultPath)
  const syncCount = useStore((s) => s.conflicts.cells.length + s.conflicts.orphans.length)
  const [tab, setTab] = useState<'look' | 'text' | 'cells' | 'canvas' | 'editing' | 'shortcuts' | 'storage'>('look')

  const Num = ({
    k, label, sub, min, max, step = 1, unit = '',
  }: { k: keyof Settings; label: string; sub?: string; min: number; max: number; step?: number; unit?: string }) => {
    const rawVal = settings[k]
    const def = DEFAULT_SETTINGS[k]
    const val = typeof rawVal === 'number' ? rawVal : (typeof def === 'number' ? def : min)
    const defaultVal = typeof def === 'number' ? def : undefined

    return (
      <NumSlider
        label={label}
        sub={sub}
        min={min}
        max={max}
        step={step}
        unit={unit}
        val={val}
        defaultVal={defaultVal}
        onChange={(v) => set({ [k]: v } as any)}
      />
    )
  }

  const Toggle = ({ k, label, sub }: { k: keyof Settings; label: string; sub?: string }) => (
    <div className="set-row">
      <label>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </label>
      <input
        type="checkbox"
        checked={Boolean(settings[k])}
        onChange={(e) => set({ [k]: e.target.checked } as any)}
        style={{ width: 18, height: 18, accentColor: 'var(--accent)', justifySelf: 'start' }}
      />
    </div>
  )

  const Color = ({ k, label, sub }: { k: keyof Settings; label: string; sub?: string }) => (
    <div className="set-row">
      <label>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </label>
      <input type="color" value={String(settings[k] || '#000000')} onChange={(e) => set({ [k]: e.target.value } as any)} />
    </div>
  )

  const Text = ({ k, label, sub }: { k: keyof Settings; label: string; sub?: string }) => (
    <div className="set-row">
      <label>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </label>
      <input type="text" className="input" value={String(settings[k] || '')} onChange={(e) => set({ [k]: e.target.value } as any)} style={{ width: 120 }} />
    </div>
  )

  const Choice = ({ k, label, sub, options }: { k: keyof Settings; label: string; sub?: string; options: { v: string; l: string }[] }) => (
    <div className="set-row">
      <label>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </label>
      <select value={String(settings[k])} onChange={(e) => set({ [k]: e.target.value } as any)}>
        {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  )

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h2>Settings</h2>
          <div className="spacer" />
          <div className="theme-chips">
            {(['look', 'text', 'cells', 'canvas', 'editing', 'shortcuts', 'storage'] as const).map((t) => (
              <button key={t} className={`theme-chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                {{ look: 'Appearance', text: 'Text', cells: 'Cells', canvas: 'Canvas', editing: 'Editing', shortcuts: 'Shortcuts', storage: 'Storage' }[t]}
              </button>
            ))}
          </div>
          <button className="tb-btn" onClick={onClose}><X /></button>
        </div>

        <div className="modal-body settings-grid">
          {tab === 'look' && (
            <>
              <div className="set-group">
                <h3>Theme</h3>
                <div className="theme-chips">
                  {THEMES.map((t) => (
                    <button key={t.id} className={`theme-chip ${settings.theme === t.id ? 'on' : ''}`} onClick={() => set({ theme: t.id })}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <div style={{ height: 10 }} />
                <Color k="accent" label="Accent color" sub="Selection, highlights, active items" />
              </div>
              <div className="set-group">
                <h3>Window</h3>
                <Toggle k="sidebarVisible" label="Show notebooks pane" sub="Ctrl+1" />
                <Toggle k="pagelistVisible" label="Show pages pane" sub="Ctrl+2" />
                <Toggle k="autoHidePanes" label="Auto-hide side panes on hover" sub="Reveal when mouse moves to left edge (Ctrl+3)" />
                <Toggle k="showStatusBar" label="Show status bar" />
                <Toggle k="showPageDate" label="Show the date under the page title" />
              </div>
            </>
          )}

          {tab === 'text' && (
            <>
              <div className="set-group">
                <h3>Fonts</h3>
                <Choice k="bodyFont" label="Body font" options={FONT_CHOICES.map((f) => ({ v: f, l: f.split(',')[0] }))} />
                <Choice k="headingFont" label="Title font" sub="Page titles and cell titles" options={FONT_CHOICES.map((f) => ({ v: f, l: f.split(',')[0] }))} />
                <Choice k="monoFont" label="Code font" options={FONT_CHOICES.map((f) => ({ v: f, l: f.split(',')[0] }))} />
              </div>
              <div className="set-group">
                <h3>Sizes</h3>
                <Num k="bodySize" label="Body text size" sub="Default size inside a cell" min={10} max={30} unit=" px" />
                <Num k="titleSize" label="Cell title size" sub="The bold heading at the top of each cell" min={12} max={40} unit=" px" />
                <Num k="pageTitleSize" label="Page title size" min={16} max={60} unit=" px" />
                <Num k="lineHeight" label="Line spacing" min={1.1} max={2.2} step={0.05} />
              </div>
              <div className="set-group">
                <h3>Default colors</h3>
                <Color k="bodyColor" label="Body text color" />
                <Color k="titleColor" label="Cell title color" />
              </div>
            </>
          )}

          {tab === 'cells' && (
            <div className="set-group">
              <h3>New cells</h3>
              <Num k="defaultCellWidth" label="Default width" min={200} max={1400} step={10} unit=" px" />
              <Num k="defaultCellHeight" label="Default height" sub="Used when a cell does not fit its text" min={80} max={900} step={10} unit=" px" />
              <Num k="cellPadding" label="Inner padding" min={0} max={40} unit=" px" />
              <Num k="cellRadius" label="Corner rounding" min={0} max={22} unit=" px" />
              <Num k="cellGap" label="Gap used when stacking cells" min={0} max={60} unit=" px" />
              <Toggle k="cellBorder" label="Draw a border around cells" />
              <Toggle k="cellAutoHeight" label="New cells grow to fit their text" />
              <Toggle k="newCellAtClick" label="Double click on empty space creates a cell" />
            </div>
          )}

          {tab === 'canvas' && (
            <>
              <div className="set-group">
                <h3>Grid</h3>
                <Toggle k="showGrid" label="Show the grid" />
                <Choice k="pageBackground" label="Grid style" options={[
                  { v: 'grid', l: 'Squares' }, { v: 'dots', l: 'Dots' }, { v: 'lines', l: 'Lines' }, { v: 'none', l: 'Plain' },
                ]} />
                <Num k="gridSize" label="Grid size" sub="Cells snap and move by this step" min={4} max={80} unit=" px" />
                <Toggle k="snapToGrid" label="Snap cells to the grid" />
              </div>
              <div className="set-group">
                <h3>Navigation</h3>
                <Choice k="panButton" label="Pan the page with" options={[
                  { v: 'right', l: 'Right mouse drag' }, { v: 'middle', l: 'Middle mouse drag' }, { v: 'space', l: 'Space and drag' },
                ]} />
                <Num k="zoomStep" label="Zoom step" sub="Ctrl and mouse wheel" min={0.02} max={0.4} step={0.02} />
              </div>
              <div className="set-group">
                <h3>Pen and highlighter</h3>
                <Color k="penColor" label="Pen color" />
                <Num k="penSize" label="Pen thickness" min={1} max={20} unit=" px" />
                <Color k="highlighterColor" label="Highlighter color" />
                <Num k="highlighterSize" label="Highlighter thickness" min={6} max={60} unit=" px" />
              </div>
            </>
          )}

          {tab === 'editing' && (
            <>
              <div className="set-group">
                <h3>Typing and pasting</h3>
                <Num k="maxImageWidth" label="Max pasted image width" sub="Resizes large images automatically" min={100} max={2000} step={50} unit=" px" />
                <Choice k="markdownPaste" label="Convert pasted Markdown" sub="Text copied from an AI chat keeps its headings, lists, tables, code and LaTeX" options={[
                  { v: 'auto', l: 'When it looks like Markdown' },
                  { v: 'always', l: 'Always' },
                  { v: 'never', l: 'Never, paste plain' },
                ]} />
                <Toggle k="autoMath" label="Render LaTeX automatically" sub="$x^2$, $$...$$, \\( ... \\) and \\[ ... \\]" />
                <Toggle k="autoLink" label="Turn typed addresses into links" />
                <Toggle k="spellcheck" label="Check spelling" />
                <Toggle k="confirmDelete" label="Ask before deleting a notebook, section or page" />
                <Num k="autosaveMs" label="Autosave delay" min={200} max={4000} step={100} unit=" ms" />
              </div>
            </>
          )}

          {tab === 'shortcuts' && (
            <div className="set-group">
              <h3>Editor shortcuts</h3>
              <div className="empty-hint" style={{ padding: '0 0 8px' }}>
                Click a shortcut, then press the new key combination. Esc cancels, Backspace removes it.
                Changes apply immediately.
              </div>
              {SHORTCUTS.map((s) => {
                const value = String(settings[s.key] || '')
                const clash = value
                  ? SHORTCUTS.find((o) => o.key !== s.key && String(settings[o.key] || '').toLowerCase() === value.toLowerCase())
                  : undefined
                return (
                  <ShortcutRow
                    key={s.key}
                    label={s.label}
                    value={value}
                    defaultValue={String(DEFAULT_SETTINGS[s.key] || '')}
                    warning={clash ? `Also used by ${clash.label}` : undefined}
                    onChange={(v) => set({ [s.key]: v } as Partial<Settings>)}
                  />
                )
              })}
            </div>
          )}

          {tab === 'storage' && (
            <div className="set-group">
              <h3>Notes folder</h3>
              <div className="set-row">
                <label>
                  Current location
                  <span className="sub" style={{ wordBreak: 'break-all' }}>{vaultPath}</span>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {isDesktop && (
                    <>
                      <button
                        className="btn"
                        onClick={async () => {
                          const p = await storage.chooseVault()
                          if (p) location.reload()
                        }}
                      >
                        Change
                      </button>
                      <button className="btn" onClick={() => storage.revealVault()}>Open</button>
                    </>
                  )}
                </div>
              </div>
              <div className="empty-hint" style={{ padding: '6px 0' }}>
                Put this folder inside OneDrive, Google Drive or Dropbox and your laptops will
                stay in sync. Each page is a plain JSON file, images live in the assets folder.
                Changes from another computer appear here by themselves. If both computers changed
                the same cell, both versions are kept and the sync button next to Settings lights up.
              </div>
              <div className="set-row">
                <label>
                  Sync
                  <span className="sub">
                    {syncCount > 0 ? `${syncCount} ${syncCount === 1 ? 'item needs' : 'items need'} your attention` : 'Everything is in sync'}
                  </span>
                </label>
                <button className="btn" onClick={() => { onClose(); useStore.getState().setShowSyncPanel(true) }}>
                  Open sync
                </button>
              </div>
              <div className="set-row">
                <label>Reset every setting to its default</label>
                <button className="btn danger" onClick={async () => { if (await askConfirm('Reset all settings?', 'Reset')) set({ ...DEFAULT_SETTINGS, sidebarWidth: settings.sidebarWidth }) }}>
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
