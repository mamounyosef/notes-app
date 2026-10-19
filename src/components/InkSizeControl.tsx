import React from 'react'
import { useStore } from '../store'

type InkTool = 'pen' | 'highlighter'

/** Fixed thickness steps per ink tool (within the Settings limits), plus the quick-pick dots. */
const INK_SIZES: Record<InkTool, { scale: number[]; presets: number[] }> = {
  pen: { scale: [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20], presets: [1, 3, 5, 8, 12] },
  highlighter: { scale: [6, 8, 10, 12, 16, 20, 24, 30, 36, 48, 60], presets: [8, 12, 16, 24, 36] },
}

/** The next step up or down the fixed scale from any current size. */
function stepSize(tool: InkTool, size: number, dir: 1 | -1) {
  const scale = INK_SIZES[tool].scale
  if (dir > 0) return scale.find((v) => v > size) ?? scale[scale.length - 1]
  return [...scale].reverse().find((v) => v < size) ?? scale[0]
}

function setSize(tool: InkTool, size: number) {
  useStore.getState().setSettings(tool === 'pen' ? { penSize: size } : { highlighterSize: size })
}

/** Step the active ink tool's thickness (used by the [ and ] shortcuts). Returns the new size, or null when no ink tool is active. */
export function nudgeInkSize(dir: 1 | -1): number | null {
  const st = useStore.getState()
  if (st.tool !== 'pen' && st.tool !== 'highlighter') return null
  const next = stepSize(st.tool, st.tool === 'pen' ? st.settings.penSize : st.settings.highlighterSize, dir)
  setSize(st.tool, next)
  return next
}

/** Same opacity rule the canvas uses when it renders a stroke. */
const strokeOpacity = (size: number) => (size > 10 ? 0.38 : 1)

/** Inline toolbar control: minus, preset dots drawn at their real thickness, plus, and the current size. */
export function InkSizeControl({ tool }: { tool: InkTool }) {
  const settings = useStore((s) => s.settings)
  const size = tool === 'pen' ? settings.penSize : settings.highlighterSize
  const color = tool === 'pen' ? settings.penColor : settings.highlighterColor
  const { scale, presets } = INK_SIZES[tool]
  const label = tool === 'pen' ? 'Pen' : 'Highlighter'

  return (
    <div className="ink-size" title={`${label} thickness`}>
      <button className="tb-btn ink-size-step" title="Thinner ([)" disabled={size <= scale[0]} onClick={() => setSize(tool, stepSize(tool, size, -1))}>-</button>
      {presets.map((p) => (
        <button key={p} className={`tb-btn ink-size-preset ${p === size ? 'on' : ''}`} title={`${p}px`} onClick={() => setSize(tool, p)}>
          <span style={{ width: Math.min(p, 18), height: Math.min(p, 18), background: color, opacity: strokeOpacity(p) }} />
        </button>
      ))}
      <button className="tb-btn ink-size-step" title="Thicker (])" disabled={size >= scale[scale.length - 1]} onClick={() => setSize(tool, stepSize(tool, size, 1))}>+</button>
      <span className="ink-size-num">{size}px</span>
    </div>
  )
}
