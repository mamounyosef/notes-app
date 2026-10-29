import React, { useEffect, useRef, useState } from 'react'
import { thinkSettingOf, useAgent } from '../../agent/store'
import { MODELS, PROVIDER_LABEL, modelInfo, fmtCtx, fmtDate, paramsLabel, expertsLabel, expertsTitle, type ModelInfo } from '../../agent/models'
import { Check, Chevron, ImageI, Gauge, Star } from '../Icons'
import { fmtSec, useSpeeds, type ModelSpeed } from '../../voice/voicePrefs'
import { runSpeedTest, useSpeedTest } from '../../voice/speedTest'
import { ThinkTag } from './ThinkControl'

const money = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`)

function PriceLine({ m }: { m: ModelInfo }) {
  if (!m.price) return <span className="mp-price none">Price not listed</span>
  if (m.provider === 'openrouter' && !m.price.input && !m.price.output)
    return (
      <span className="mp-price free" title="OpenRouter free model: 50 requests a day on a key without credits">
        Free <em>· 50 requests a day</em>
      </span>
    )
  return (
    <span className="mp-price" title={`US dollars per million tokens (${m.provider === 'openrouter' ? 'openrouter.ai' : 'ollama.com/pricing'})`}>
      {money(m.price.input)} in · {money(m.price.output)} out <em>/ 1M</em>
    </span>
  )
}

/** Seconds until a model starts talking in voice mode, measured on this computer. */
function SpeedBadge({ s, other, think }: { s?: ModelSpeed; other?: ModelSpeed; think: boolean }) {
  const testing = useSpeedTest((t) => t.running)
  if (!s) return testing ? <span className="mp-speed dim">timing...</span> : null
  if (s.error) return <span className="mp-speed warn" title={s.error}>no answer</span>
  const tone = s.ms < 2500 ? 'fast' : s.ms < 5000 ? 'mid' : 'slow'
  const how = s.tested ? 'speed test' : `${s.n} real ${s.n === 1 ? 'reply' : 'replies'}`
  return (
    <span
      className={`mp-speed ${tone}`}
      title={`${think ? 'Thinking first' : 'Without thinking first'}: starts talking after ${fmtSec(s.ms)} (${how}).${other && !other.error ? ` ${think ? 'Without' : 'With'} thinking: ${fmtSec(other.ms)}.` : ''}`}
    >
      <Gauge size={10} /> {fmtSec(s.ms)}
    </span>
  )
}

/**
 * Model chooser: name in the composer, details for every model in the menu.
 * Voice mode passes its own pick (`value`/`onPick`) and gets each model's
 * seconds to the first spoken word beside it.
 */
export default function ModelPicker({ value, onPick, label, voiceThink }: { value?: string; onPick?(id: string): void; label?: string; voiceThink?: boolean } = {}) {
  const chatModel = useAgent((s) => s.prefs.model)
  const prefs = useAgent((s) => s.prefs)
  const setPrefs = useAgent((s) => s.setPrefs)
  const model = value || chatModel
  const voice = voiceThink !== undefined
  const speeds = useSpeeds()
  const test = useSpeedTest()
  const book = voice ? (voiceThink ? speeds.thinking : speeds.quick) : null
  const otherBook = voice ? (voiceThink ? speeds.quick : speeds.thinking) : null
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const cur = modelInfo(model)
  // Starred models come first, each part still strongest first.
  const favSet = new Set(prefs.favModels)
  const favs = MODELS.filter((m) => favSet.has(m.id))
  const rest = MODELS.filter((m) => !favSet.has(m.id))
  // The row that just moved between the parts glows briefly, so the eye can follow it.
  const [moved, setMoved] = useState<string | null>(null)
  const pop = useRef<HTMLDivElement>(null)

  const toggleFav = (id: string) => {
    const now = useAgent.getState().prefs.favModels
    setPrefs({ favModels: now.includes(id) ? now.filter((f) => f !== id) : [...now, id] })
    setMoved(id)
  }

  useEffect(() => {
    if (!moved) return
    pop.current?.querySelector(`[data-model="${CSS.escape(moved)}"]`)?.scrollIntoView({ block: 'nearest' })
    const t = setTimeout(() => setMoved(null), 900)
    return () => clearTimeout(t)
  }, [moved, prefs.favModels])

  // Open on the current pick, wherever it sits in the list.
  useEffect(() => {
    if (open) pop.current?.querySelector('.mp-opt.sel')?.scrollIntoView({ block: 'nearest' })
  }, [open])

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

  return (
    <div className="mp" ref={ref}>
      <button
        className={`mp-btn ${open ? 'on' : ''} ${label ? 'labeled' : ''}`}
        onClick={() => setOpen(!open)}
        title={`${cur.name} on ${PROVIDER_LABEL[cur.provider]}: ${paramsLabel(cur)}, ${fmtCtx(cur.context)} context${cur.released ? `, released ${fmtDate(cur.released)}` : ''}`}
      >
        {label && <span className="mp-btn-label">{label}</span>}
        {cur.name}
        {cur.provider === 'openrouter' && <span className="mp-btn-prov">OpenRouter</span>}
        {book?.[cur.id] && !book[cur.id].error && <span className="mp-btn-speed">{fmtSec(book[cur.id].ms)}</span>}
        <Chevron size={11} className="mp-chev" />
      </button>
      {open && (
        <div className="mp-pop" ref={pop}>
          <div className="mp-head">
            {voice ? 'Voice model' : 'Model'} <span className="mp-head-sub">strongest first</span>
            {voice && (
              <button className="mp-test" disabled={test.running} onClick={() => runSpeedTest()} title="Times every Ollama model on a real spoken question about this page, one at a time. Nothing is changed.">
                <Gauge size={11} /> {test.running ? 'Testing...' : 'Test speed'}
              </button>
            )}
          </div>
          {voice && (
            <div className="mp-voice-note">
              {test.running
                ? `Timing ${test.progress}`
                : `Seconds until each model starts talking (${voiceThink ? 'thinking first' : 'quick answers'}), measured on this computer by the speed test and by every voice reply. Separate from the chat's model.`}
            </div>
          )}
          {favs.length > 0 && (
            <div className="mp-sec fav">
              <Star size={11} /> Favorites <span className="mp-sec-n">{favs.length}</span>
            </div>
          )}
          {favs.map(row)}
          {favs.length > 0 && rest.length > 0 && (
            <div className="mp-sec line">
              <span>All other models</span>
            </div>
          )}
          {rest.map(row)}
          <div className="mp-foot">
            {favs.length === 0 && <span className="mp-foot-hint"><Star size={10} /> Star a model to keep it at the top. </span>}
            Ollama prices from ollama.com/pricing; your plan's monthly credits are used first. OpenRouter free models need an OpenRouter key (Settings, Assistant) and allow 50 requests a day.
          </div>
        </div>
      )}
    </div>
  )

  function row(m: ModelInfo) {
    const fav = favSet.has(m.id)
    return (
      <button
        key={m.id}
        data-model={m.id}
        className={`mp-opt ${m.id === model ? 'sel' : ''} ${moved === m.id ? 'moved' : ''}`}
        onClick={() => {
          if (onPick) onPick(m.id)
          else setPrefs({ model: m.id })
          setOpen(false)
        }}
      >
        <div className="mp-row1">
          <span className="mp-name">{m.name}</span>
          <span className={`mp-prov ${m.provider}`} title={m.provider === 'openrouter' ? 'Runs on OpenRouter' : 'Runs on Ollama Cloud'}>
            {PROVIDER_LABEL[m.provider]}
          </span>
          {m.vision && (
            <span className="mp-tag" title="Can see images">
              <ImageI size={11} /> vision
            </span>
          )}
          {book && <SpeedBadge s={book[m.id]} other={otherBook?.[m.id]} think={Boolean(voiceThink)} />}
          {m.id === model && <Check size={13} className="mp-check" />}
          <span
            role="button"
            tabIndex={0}
            aria-pressed={fav}
            className={`mp-star ${fav ? 'on' : ''}`}
            title={fav ? 'Remove from favorites' : 'Add to favorites (keeps it at the top)'}
            onClick={(e) => {
              e.stopPropagation()
              toggleFav(m.id)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              toggleFav(m.id)
            }}
          >
            <Star size={14} />
          </span>
        </div>
        <div className="mp-row2">
          <span>{paramsLabel(m)}</span>
          {m.experts && (
            <span className="mp-experts" title={expertsTitle(m.experts)}>
              {expertsLabel(m.experts)}
            </span>
          )}
          <span>{fmtCtx(m.context)} context</span>
          <span>{fmtDate(m.released)}</span>
        </div>
        <ThinkTag
          spec={m.think}
          provider={PROVIDER_LABEL[m.provider]}
          // The chat's picker: a level pill picks the model and its thinking in one click (voice keeps its own switch).
          current={voice ? undefined : thinkSettingOf(prefs, m.id).level}
          onPick={
            voice
              ? undefined
              : (l) => {
                  useAgent.getState().setThink(m.id, { level: l, budget: 0 })
                  if (onPick) onPick(m.id)
                  else setPrefs({ model: m.id })
                  setOpen(false)
                }
          }
        />
        {m.arch && <div className="mp-arch">{m.arch.join(' · ')}</div>}
        <div className="mp-row3">
          <PriceLine m={m} />
          {m.note && <span className="mp-note">{m.note}</span>}
        </div>
      </button>
    )
  }
}
