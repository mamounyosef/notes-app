import React, { useEffect, useRef, useState } from 'react'
import { useAgent } from '../../agent/store'
import { useClaude, cacheInfo, type ClaudeLimits } from '../../agent/claude'
import { isClaude, modelInfo } from '../../agent/models'
import { Retry, X } from '../Icons'
import { fmtTokens } from './ContextMeter'

/** "1h 12m", "4m 05s", "37s". */
function fmtLeft(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m >= 10) return `${m}m`
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** "in 2h 5m" / "tomorrow 07:00". */
function fmtReset(at: number | null | undefined) {
  if (!at) return ''
  const left = at - Date.now()
  if (left <= 0) return 'resetting now'
  if (left < 20 * 3600_000) return `resets in ${fmtLeft(left)}`
  return `resets ${new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

const tone = (pct: number | null | undefined) => (pct === null || pct === undefined ? '' : pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'ok')

/** Ticks every second while mounted (the cache countdown). */
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function useCache() {
  const chat = useAgent((s) => s.chat)
  const busy = useAgent((s) => s.busy)
  const now = useNow(1000)
  const c = cacheInfo(chat)
  if (busy) return { state: 'busy' as const, left: 0, ttl: c?.ttlMs || 3600_000 }
  if (!c) return { state: 'none' as const, left: 0, ttl: 3600_000 }
  const left = c.at + c.ttlMs - now
  return { state: left > 0 ? ('warm' as const) : ('cold' as const), left, ttl: c.ttlMs }
}

/** Header pill for Claude chats: how long the prompt cache stays warm, and how much of the plan's 5-hour window is used. */
export function ClaudePill({ active, onClick }: { active: boolean; onClick(): void }) {
  const model = useAgent((s) => s.prefs.model)
  const limits = useClaude((s) => s.limits)
  const cache = useCache()
  if (!isClaude(model)) return null
  const five = limits?.five_hour?.pct ?? null
  const r = 7
  const circ = 2 * Math.PI * r
  const frac = cache.state === 'warm' ? Math.max(0, Math.min(1, cache.left / cache.ttl)) : 0
  const cacheTone = cache.state === 'warm' ? (cache.left < 5 * 60_000 ? 'warm' : 'ok') : cache.state === 'busy' ? 'busy' : 'cold'
  return (
    <button
      className={`cl-pill ${active ? 'on' : ''}`}
      onClick={onClick}
      title={`Prompt cache: ${cache.state === 'warm' ? `warm for ${fmtLeft(cache.left)} more` : cache.state === 'busy' ? 'in use' : cache.state === 'cold' ? 'expired' : 'starts with the first reply'}${five !== null ? `. Plan: ${five}% of the 5-hour limit used` : ''}. Click for details.`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" className={`cl-cache ${cacheTone}`}>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.2" />
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${frac * circ} ${circ}`} transform="rotate(-90 9 9)" className="arc" />
        <path d="M9 5.6v3.6l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span className="cl-cache-t">{cache.state === 'warm' ? fmtLeft(cache.left).split(' ')[0] : cache.state === 'busy' ? 'live' : cache.state === 'cold' ? 'cold' : 'new'}</span>
      {five !== null && (
        <span className={`cl-plan ${tone(five)}`}>
          <i style={{ width: `${Math.min(100, five)}%` }} />
        </span>
      )}
    </button>
  )
}

function Bar({ label, w, sub }: { label: string; w: { pct: number | null; resetsAt: number | null } | null | undefined; sub?: string }) {
  if (!w) return null
  const pct = w.pct ?? 0
  return (
    <div className="cl-bar">
      <div className="cl-bar-head">
        <span>{label}</span>
        <b className={tone(pct)}>{w.pct === null ? '?' : `${pct}%`}</b>
      </div>
      <div className={`cl-track ${tone(pct)}`}>
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="cl-bar-sub">{sub || fmtReset(w.resetsAt)}</div>
    </div>
  )
}

/** Details: plan limits, the prompt cache, the context window, and compaction. */
export function ClaudePanel({ onClose }: { onClose(): void }) {
  const model = useAgent((s) => s.prefs.model)
  const chat = useAgent((s) => s.chat)
  const busy = useAgent((s) => s.busy)
  const compact = useAgent((s) => s.compact)
  const limits: ClaudeLimits | null = useClaude((s) => s.limits)
  const version = useClaude((s) => s.version)
  const ctx = useClaude((s) => (chat ? s.ctx[chat.id] : undefined))
  const refreshUsage = useClaude((s) => s.refreshUsage)
  const [loading, setLoading] = useState(false)
  const cache = useCache()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    refreshUsage().finally(() => setLoading(false))
    useClaude.getState().refresh()
  }, [])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t) || t.closest('.cl-pill')) return
      onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const plan = limits?.plan ? limits.plan.charAt(0).toUpperCase() + limits.plan.slice(1) : null
  const hasSession = Boolean(chat?.claude?.head)

  return (
    <div className="ci ci-pop cl-pop" ref={ref}>
      <div className="ci-head">
        <div>
          <div className="ci-title">Claude</div>
          <div className="ci-sub">
            {modelInfo(model).name}
            {plan ? ` · ${plan} plan` : ''}
            {version ? ` · Claude Code ${version}` : ''}
          </div>
        </div>
        <button className="ag-icon-btn" onClick={onClose} title="Close"><X size={15} /></button>
      </div>
      <div className="ci-body">
        <div className="cl-sec-t">
          Plan usage
          <button
            className="ag-icon-btn sm"
            title="Check again"
            disabled={loading}
            onClick={() => {
              setLoading(true)
              refreshUsage(true).finally(() => setLoading(false))
            }}
          >
            <Retry size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>
        {!limits?.five_hour && !limits?.seven_day ? (
          <div className="ci-note">{loading ? 'Checking your plan...' : 'Shown after the first Claude reply.'}</div>
        ) : (
          <div className="cl-bars">
            <Bar label="5-hour window" w={limits?.five_hour} />
            <Bar label="This week" w={limits?.seven_day} />
            <Bar label="This week, Opus" w={limits?.seven_day_opus} />
            <Bar label="This week, Sonnet" w={limits?.seven_day_sonnet} />
          </div>
        )}
        {limits?.breakdown?.length ? (
          <div className="cl-break" title="Share of this week's usage by where it was used">
            {limits.breakdown.filter((b) => b.pct > 0).map((b) => (
              <span key={b.name}>
                {b.name} <b>{b.pct}%</b>
              </span>
            ))}
          </div>
        ) : null}

        <div className="cl-sec-t">Prompt cache</div>
        <div className={`cl-cache-big ${cache.state}`}>
          <span className="n">{cache.state === 'warm' ? fmtLeft(cache.left) : cache.state === 'busy' ? 'In use' : cache.state === 'cold' ? 'Expired' : 'Not started'}</span>
          <span className="of">{cache.state === 'warm' ? `of ${cache.ttl >= 3600_000 ? '1 hour' : '5 minutes'}` : ''}</span>
        </div>
        <div className="ci-note">
          After each reply this conversation stays cached on Anthropic's side for {cache.ttl >= 3600_000 ? 'an hour' : '5 minutes'}. A message sent while it is warm re-reads the history at a small fraction of the usage; after it expires, the whole conversation is processed again on your next message.
        </div>

        <div className="cl-sec-t">Context</div>
        {ctx && hasSession ? (
          <>
            <div className="ci-big">
              <span className="n">{ctx.total.toLocaleString()}</span>
              <span className="of">/ {fmtTokens(ctx.max)} tokens</span>
              <span className="pct">{ctx.pct}%</span>
            </div>
            <div className="ci-note">Measured by Claude Code. It compacts the conversation by itself when it nears the limit; compact now to start lighter while keeping a summary.</div>
          </>
        ) : (
          <div className="ci-note">Measured by Claude Code after each reply.</div>
        )}
        <div className="ci-row">
          <button className="ag-btn sm" disabled={busy || !hasSession} onClick={() => compact()} title="Claude Code summarizes the conversation so far and continues from the summary (/compact)">
            Compact conversation
          </button>
        </div>
        <div className="ci-note dim">Runs in Claude Code on this computer with your own Claude plan: only the Notes tools, web search and web fetch, and attached files. It closes by itself after 12 minutes without messages.</div>
      </div>
    </div>
  )
}
