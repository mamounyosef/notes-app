import React from 'react'
import { ArrowDiagI, EllipseI, Eraser, Highlighter, LineI, Pen, RectI, StepI, TextI, Trash } from '../Icons'

export type DrawTool = 'pen' | 'hl' | 'erase' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'text' | 'step'

export interface DrawPrefs {
  tool: DrawTool
  color: string
  /** On screen pixels at the zoom you draw at. */
  size: number
  fill: boolean
}

export const TOOLS: { t: DrawTool; label: string; tip: string; Icon: (p: { size?: number }) => React.ReactElement; gap?: boolean }[] = [
  { t: 'pen', label: 'Pen', tip: 'Smooth ink, thicker as you press with a pen tablet', Icon: Pen },
  { t: 'hl', label: 'Marker', tip: 'See-through highlighter', Icon: Highlighter },
  { t: 'erase', label: 'Eraser', tip: 'Rubs out drawing only, never the picture', Icon: Eraser },
  { t: 'arrow', label: 'Arrow', tip: 'Point at something (Shift: steady angles)', Icon: ArrowDiagI, gap: true },
  { t: 'line', label: 'Line', tip: 'Straight line (Shift: steady angles)', Icon: LineI },
  { t: 'rect', label: 'Box', tip: 'Box around something (Shift: square, Alt: from the middle)', Icon: RectI },
  { t: 'ellipse', label: 'Circle', tip: 'Circle something (Shift: round, Alt: from the middle)', Icon: EllipseI },
  { t: 'text', label: 'Text', tip: 'Click to type, click text to change it', Icon: TextI, gap: true },
  { t: 'step', label: 'Steps', tip: 'Numbered badges: 1, 2, 3 for each click', Icon: StepI },
]

export const COLORS: { c: string; name: string }[] = [
  { c: '#ff3b30', name: 'Red' },
  { c: '#ff9f0a', name: 'Orange' },
  { c: '#ffd60a', name: 'Yellow' },
  { c: '#30d158', name: 'Green' },
  { c: '#0a84ff', name: 'Blue' },
  { c: '#bf5af2', name: 'Purple' },
  { c: '#ffffff', name: 'White' },
  { c: '#111111', name: 'Black' },
]

const KEY = 'notes.imageEditor.draw'
const DEFAULTS: DrawPrefs = { tool: 'pen', color: '#ff3b30', size: 4, fill: false }

export function loadDrawPrefs(): DrawPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    return v ? { ...DEFAULTS, ...v } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

export function saveDrawPrefs(p: DrawPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* only a convenience */
  }
}

/** Screen sizes for text and step badges, from the size slider. */
export const textPx = (size: number) => Math.round(10 + size * 2.2)
export const stepPx = (size: number) => Math.round(9 + size * 1.6)
/** Line width on screen: a marker and an eraser go broader than a pen at the same size. */
export const brushPx = (tool: DrawTool, size: number) => (tool === 'hl' ? size * 3.5 : tool === 'erase' ? size * 3 : size)

/** The draw mode's row: tools, colors, size, fill, clear. */
export function DrawBar({ prefs, set, hasMarks, onClear }: { prefs: DrawPrefs; set(p: Partial<DrawPrefs>): void; hasMarks: boolean; onClear(): void }) {
  const custom = !COLORS.some((k) => k.c === prefs.color)
  const fills = prefs.tool === 'rect' || prefs.tool === 'ellipse' || prefs.tool === 'text'
  const dot = prefs.tool === 'text' ? textPx(prefs.size) * 0.6 : prefs.tool === 'step' ? stepPx(prefs.size) : brushPx(prefs.tool, prefs.size)
  return (
    <div className="ie-row ie-draw">
      {TOOLS.map(({ t, label, tip, Icon, gap }, k) => (
        <React.Fragment key={t}>
          {gap && <span className="ie-gap" />}
          <button className={`ie-tool ${prefs.tool === t ? 'on' : ''}`} onClick={() => set({ tool: t })} title={`${label}: ${tip} (${k + 1})`}>
            <Icon size={16} />
          </button>
        </React.Fragment>
      ))}
      <span className="lb-sep" />
      {COLORS.map((k) => (
        <button
          key={k.c}
          className={`ie-swatch ${prefs.color === k.c ? 'on' : ''}`}
          style={{ ['--sw' as any]: k.c }}
          onClick={() => set({ color: k.c })}
          title={k.name}
        />
      ))}
      <label className={`ie-swatch custom ${custom ? 'on' : ''}`} style={custom ? { ['--sw' as any]: prefs.color } : undefined} title="Any color">
        <input type="color" value={prefs.color} onChange={(e) => set({ color: e.target.value })} />
      </label>
      <span className="lb-sep" />
      <label className="ie-slide ie-size" title="Size ([ and ])">
        <span className="ie-size-box">
          <i className="ie-size-dot" style={{ width: Math.min(26, Math.max(3, dot)), height: Math.min(26, Math.max(3, dot)), background: prefs.tool === 'erase' ? 'transparent' : prefs.color }} />
        </span>
        <input type="range" min={1} max={40} value={prefs.size} onChange={(e) => set({ size: Number(e.target.value) })} />
      </label>
      {fills && (
        <button className={`ie-pill ${prefs.fill ? 'on' : ''}`} onClick={() => set({ fill: !prefs.fill })} title={prefs.tool === 'text' ? 'Text on a colored label' : 'Fill the shape with a see-through tint'}>
          {prefs.tool === 'text' ? 'Label' : 'Fill'}
        </button>
      )}
      {hasMarks && (
        <button className="ie-pill ghost ie-clear" onClick={onClear} title="Remove all drawing from this picture">
          <Trash size={13} /> Clear
        </button>
      )}
    </div>
  )
}
