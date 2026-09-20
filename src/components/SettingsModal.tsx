import React, { useState } from 'react'
import { useStore } from '../store'
import { DEFAULT_SETTINGS, type Settings } from '../types'
import { storage, isDesktop } from '../lib/storage'
import { X } from './Icons'

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
  const [tab, setTab] = useState<'look' | 'text' | 'cells' | 'canvas' | 'editing' | 'storage'>('look')

  const Num = ({
    k, label, sub, min, max, step = 1, unit = '',
  }: { k: keyof Settings; label: string; sub?: string; min: number; max: number; step?: number; unit?: string }) => (
    <div className="set-row">
      <label>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </label>
      <div className="with-val">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(settings[k])}
          onChange={(e) => set({ [k]: Number(e.target.value) } as any)}
        />
        <span>{String(settings[k])}{unit}</span>
      </div>
    </div>
  )

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
            {(['look', 'text', 'cells', 'canvas', 'editing', 'storage'] as const).map((t) => (
              <button key={t} className={`theme-chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                {{ look: 'Appearance', text: 'Text', cells: 'Cells', canvas: 'Canvas', editing: 'Editing', storage: 'Storage' }[t]}
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
              <Text k="thickLineShortcut" label="Thick line shortcut" sub="Requires a reload to apply" />
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
                Put this folder inside OneDrive, Google Drive or Dropbox and your laptop will
                stay in sync. Each page is a plain JSON file, images live in the assets folder.
              </div>
              <div className="set-row">
                <label>Reset every setting to its default</label>
                <button className="btn danger" onClick={() => { if (confirm('Reset all settings?')) set({ ...DEFAULT_SETTINGS, sidebarWidth: settings.sidebarWidth }) }}>
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
