/**
 * How hard the model thinks: a chip in the chat box that opens a dial with
 * exactly the levels the current model takes on its service, a token budget
 * where the service offers one, and a clear "always thinks" state for models
 * that cannot switch reasoning off. Remembered per model.
 */
import React, { useEffect, useRef, useState } from 'react'
import { thinkSettingOf, useAgent } from '../../agent/store'
import {
  PROVIDER_LABEL,
  THINK_BUDGETS,
  THINK_HINT,
  THINK_LABEL,
  THINK_SHORT,
  canStopThinking,
  fmtBudget,
  modelInfo,
  thinkDepth,
  thinkSummary,
  type ThinkLevel,
  type ThinkSetting,
  type ThinkSpec,
} from '../../agent/models'

/** Four rising bars, lit up to the level's depth. */
export function ThinkBars({ depth, size = 12 }: { depth: number; size?: number }) {
  return (
    <svg className={`tk-bars d${depth}`} width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={0.5 + i * 3} y={8 - i * 2.4} width={2.2} height={3.5 + i * 2.4} rx={0.9} className={i < depth ? 'lit' : ''} />
      ))}
    </svg>
  )
}

const alwaysHint = (provider: string) =>
  `Always thinks on ${provider}: the service does not let this model skip reasoning, so the lightest level is the fastest it goes.`

/** The segmented dial: one stop per level the model takes, a sliding light behind the pick. */
export function ThinkLevels({ spec, value, onPick, compact, muted }: { spec: ThinkSpec; value: ThinkLevel; onPick(l: ThinkLevel): void; compact?: boolean; muted?: boolean }) {
  const i = Math.max(0, spec.levels.indexOf(value))
  const step = (d: number) => onPick(spec.levels[Math.min(spec.levels.length - 1, Math.max(0, i + d))])
  return (
    <div
      className={`tk-seg ${compact ? 'compact' : ''} ${muted ? 'muted' : ''}`}
      role="radiogroup"
      aria-label="Thinking level"
      style={{ '--n': spec.levels.length, '--i': i } as React.CSSProperties}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(1)
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-1)
        else return
        e.preventDefault()
      }}
    >
      <span className={`tk-seg-light d${thinkDepth(value)}`} />
      {spec.levels.map((l) => (
        <button
          key={l}
          role="radio"
          aria-checked={l === value}
          tabIndex={l === value ? 0 : -1}
          className={`tk-stop ${l === value ? 'on' : ''}`}
          title={`${THINK_LABEL[l]}: ${THINK_HINT[l]}${spec.default === l ? ' (the service default)' : ''}`}
          onClick={() => onPick(l)}
        >
          <ThinkBars depth={thinkDepth(l)} size={11} />
          <span>{THINK_SHORT[l]}</span>
          {spec.default === l && !compact && <i className="tk-def" />}
        </button>
      ))}
    </div>
  )
}

/** Reasoning token cap, for models whose service takes one. Auto leaves it to the level. */
function ThinkBudget({ value, disabled, onPick }: { value: number; disabled: boolean; onPick(n: number): void }) {
  const idx = value ? Math.max(1, THINK_BUDGETS.findIndex((b) => b >= value) + 1 || THINK_BUDGETS.length) : 0
  const pct = (idx / THINK_BUDGETS.length) * 100
  return (
    <div className={`tk-budget ${disabled ? 'off' : ''}`}>
      <div className="tk-budget-head">
        <span>Token budget</span>
        <b>{value ? `${fmtBudget(value)} tokens` : 'Auto'}</b>
      </div>
      <input
        type="range"
        min={0}
        max={THINK_BUDGETS.length}
        step={1}
        value={idx}
        disabled={disabled}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        aria-label="Reasoning token budget"
        title="How many tokens it may spend reasoning. Auto follows the level. A small budget answers sooner; a large one lets it work through harder problems."
        onChange={(e) => {
          const n = Number(e.target.value)
          onPick(n ? THINK_BUDGETS[n - 1] : 0)
        }}
      />
      <div className="tk-ticks">
        <span>Auto</span>
        {THINK_BUDGETS.map((b) => (
          <span key={b}>{fmtBudget(b)}</span>
        ))}
      </div>
      {value > 0 && !disabled && <div className="tk-note">A budget replaces the level: OpenRouter takes one or the other.</div>}
    </div>
  )
}

/** The model card's line: the levels it takes, the service default marked. */
export function ThinkTag({ spec, provider }: { spec: ThinkSpec; provider: string }) {
  const always = !canStopThinking(spec)
  const title = [
    always ? alwaysHint(provider) : 'Thinking can be switched off.',
    `Levels: ${spec.levels.map((l) => THINK_LABEL[l]).join(', ')}.`,
    spec.default ? `Service default: ${THINK_LABEL[spec.default]}.` : 'The service does not state a default.',
    spec.budget ? 'Also takes a reasoning token budget.' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={`mp-think ${always ? 'always' : ''}`} title={title} aria-label={`Thinking: ${thinkSummary(spec)}`}>
      <span className="mp-think-label">{always ? 'Always thinks' : 'Thinking'}</span>
      {spec.levels.map((l) => (
        <span key={l} className={`mp-think-lv ${spec.default === l ? 'def' : ''}`}>
          <ThinkBars depth={thinkDepth(l)} size={9} />
          {THINK_SHORT[l]}
        </span>
      ))}
      {spec.budget && <span className="mp-think-lv budget">token budget</span>}
    </div>
  )
}

/** The chat box chip and its dial. */
export default function ThinkControl() {
  const model = useAgent((s) => s.prefs.model)
  const prefs = useAgent((s) => s.prefs)
  const setting = thinkSettingOf(prefs, model)
  const saved = prefs.thinkBy?.[model]
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const m = modelInfo(model)
  const spec = m.think
  const always = !canStopThinking(spec)
  const provider = PROVIDER_LABEL[m.provider]
  const depth = thinkDepth(setting.level)
  const pick = (s: ThinkSetting) => useAgent.getState().setThink(model, s)
  // A new level drops the budget; turning thinking off keeps it for when it comes back on.
  const pickLevel = (level: ThinkLevel) => pick({ level, budget: level === 'off' ? saved?.budget : 0 })

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  // Opening the dial puts the keyboard on the current level.
  useEffect(() => {
    if (open) requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('.tk-pop .tk-stop.on')?.focus())
  }, [open])

  const label = setting.budget ? fmtBudget(setting.budget) : setting.level === 'on' || setting.level === 'off' ? '' : THINK_SHORT[setting.level]
  const chipTitle = `Thinking: ${setting.budget ? `up to ${fmtBudget(setting.budget)} tokens` : THINK_LABEL[setting.level]}. ${setting.budget ? '' : THINK_HINT[setting.level]}${always ? ` ${alwaysHint(provider)}` : ''} Click to change, scroll to step.`

  return (
    <div className="tk" ref={ref}>
      <button
        className={`tk-chip d${depth} ${open ? 'open' : ''} ${always ? 'always' : ''}`}
        title={chipTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onWheel={(e) => {
          if (open || !e.deltaY) return
          const i = spec.levels.indexOf(setting.level)
          const next = spec.levels[Math.min(spec.levels.length - 1, Math.max(0, i + (e.deltaY < 0 ? 1 : -1)))]
          if (next !== setting.level) pickLevel(next)
        }}
      >
        <ThinkBars depth={depth} size={12} />
        Think
        {label && <em className="tk-chip-lv">{label}</em>}
      </button>
      {open && (
        <div className="tk-pop" role="dialog" aria-label="Thinking">
          <div className="tk-head">
            <span className="tk-title">Thinking</span>
            <span className="tk-model">
              {m.name} <em>on {provider}</em>
            </span>
            {always && (
              <span className="tk-always" title={alwaysHint(provider)}>
                <i /> Always thinks
              </span>
            )}
          </div>
          <ThinkLevels spec={spec} value={setting.level} onPick={pickLevel} muted={Boolean(setting.budget)} />
          <div className="tk-scale">
            <span>Faster</span>
            <span className="tk-scale-line" />
            <span>Deeper</span>
          </div>
          <div className="tk-desc">
            <b>{setting.budget ? `Up to ${fmtBudget(setting.budget)} reasoning tokens` : THINK_LABEL[setting.level]}</b>
            <span>{setting.budget ? 'Reasons until it reaches the budget, then answers.' : THINK_HINT[setting.level]}</span>
          </div>
          {spec.budget && <ThinkBudget value={setting.budget || 0} disabled={setting.level === 'off'} onPick={(budget) => pick({ level: setting.level, budget })} />}
          <div className="tk-foot">
            Remembered for this model. {spec.default ? `Service default: ${THINK_LABEL[spec.default]}.` : `${provider} does not state a default.`}
          </div>
        </div>
      )}
    </div>
  )
}
