import React, { useMemo, useState } from 'react'
import { useAgent, contextBreakdown, estimateTokens, chatCost, thinkSettingOf } from '../../agent/store'
import { modelInfo, costOf, fmtMoney, fmtCtx, fmtDate, paramsLabel, fmtBudget, THINK_LABEL } from '../../agent/models'
import { SYSTEM_PROMPT } from '../../agent/prompt'
import { TOOL_DEFS } from '../../agent/tools'
import { buildContext } from '../../agent/context'
import { Chevron, Copy, Check, Retry, X } from '../Icons'

const COLORS: Record<string, string> = {
  system: '#c678dd',
  tools: '#61afef',
  context: '#56b6c2',
  history: '#98c379',
  'tools-out': '#e5c07b',
  thinking: '#d19a66',
  files: '#e06c75',
  images: '#be8cff',
}

export const fmtTokens = (n: number) => (n >= 100_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

function useBreakdown() {
  const chat = useAgent((s) => s.chat)
  const usage = useAgent((s) => s.usage)
  const busy = useAgent((s) => s.busy)
  const model = useAgent((s) => s.prefs.model)
  // Recompute when messages change or a request finishes.
  return useMemo(() => contextBreakdown(chat, undefined, model), [chat, usage, busy, model])
}

/** Small ring in the header: how full the context window is. */
export function ContextRing({ onClick, active }: { onClick(): void; active?: boolean }) {
  const { total, exact } = useBreakdown()
  const CONTEXT_LIMIT = modelInfo(useAgent((s) => s.prefs.model)).context
  const pct = Math.min(1, total / CONTEXT_LIMIT)
  const r = 8
  const c = 2 * Math.PI * r
  const color = pct > 0.85 ? '#e06c75' : pct > 0.6 ? '#e5c07b' : 'var(--accent)'
  return (
    <button
      className={`ag-ring ${active ? 'on' : ''}`}
      onClick={onClick}
      title={`Context: ${total.toLocaleString()} of ${CONTEXT_LIMIT.toLocaleString()} tokens (${(pct * 100).toFixed(1)}%)${exact ? '' : ', estimated'}. Click for details.`}
    >
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={r} fill="none" stroke="var(--line)" strokeWidth="2.4" />
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(pct * c, total ? 1.2 : 0)} ${c}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span>{fmtTokens(total)}</span>
    </button>
  )
}

function Section({ title, meta, children, defaultOpen }: { title: string; meta?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  return (
    <div className={`ci-sec ${open ? 'open' : ''}`}>
      <button className="ci-sec-head" onClick={() => setOpen(!open)}>
        <Chevron size={12} className="ci-chev" />
        <span>{title}</span>
        {meta && <em>{meta}</em>}
      </button>
      {open && <div className="ci-sec-body">{children}</div>}
    </div>
  )
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      className="ag-icon-btn ci-copy"
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setOk(true)
        setTimeout(() => setOk(false), 1200)
      }}
    >
      {ok ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/** Full view of what goes to the model: usage, breakdown, prompt, tools, live context. */
export function ContextInspector({ onClose }: { onClose(): void }) {
  const { parts, total, exact } = useBreakdown()
  const usage = useAgent((s) => s.usage)
  const prefs = useAgent((s) => s.prefs)
  const think = thinkSettingOf(prefs, prefs.model)
  const thinkLabel = think.budget ? `Up to ${fmtBudget(think.budget)} tokens` : THINK_LABEL[think.level]
  const chat = useAgent((s) => s.chat)
  const info = modelInfo(prefs.model)
  const CONTEXT_LIMIT = info.context
  const cost = chatCost(chat)
  const lastCost = usage ? costOf(usage.model || prefs.model, usage) : null
  const popRef = React.useRef<HTMLDivElement>(null)
  // Click anywhere else (except the ring, which toggles it) to close.
  React.useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (popRef.current?.contains(t) || t.closest('.ag-ring')) return
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
  const [ctx, setCtx] = useState(() => buildContext().full)
  const pct = (total / CONTEXT_LIMIT) * 100
  const free = Math.max(0, CONTEXT_LIMIT - total)

  return (
    <div
      className="ci ci-pop"
      ref={popRef}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="ci-head">
        <div>
          <div className="ci-title">Context window</div>
          <div className="ci-sub">{info.name} · {paramsLabel(info)} · {fmtCtx(CONTEXT_LIMIT)} context · released {fmtDate(info.released)}</div>
        </div>
        <button className="ag-icon-btn" onClick={onClose} title="Back to chat"><X size={15} /></button>
      </div>

      <div className="ci-body">
        <div className="ci-big">
          <span className="n">{total.toLocaleString()}</span>
          <span className="of">/ {fmtTokens(CONTEXT_LIMIT)} tokens</span>
          <span className="pct">{pct < 0.1 && total ? '<0.1' : pct.toFixed(1)}%</span>
        </div>
        <div className="ci-bar">
          {parts.map((p) => (
            <i key={p.key} style={{ width: `${(p.tokens / CONTEXT_LIMIT) * 100}%`, background: COLORS[p.key] }} title={`${p.label}: ${p.tokens.toLocaleString()}`} />
          ))}
        </div>
        <div className="ci-note">
          {exact ? 'Exact count from Ollama for the last request, split by estimate.' : 'Estimated. The exact count appears after the next reply.'} {fmtTokens(free)} free.
        </div>

        <div className="ci-parts">
          {parts.map((p) => (
            <div key={p.key} className="ci-part">
              <i style={{ background: COLORS[p.key] }} />
              <div className="l">
                <span>{p.label}</span>
                {p.detail && <em>{p.detail}</em>}
              </div>
              <span className="t">{p.tokens.toLocaleString()}</span>
              <span className="p">{((p.tokens / Math.max(1, total)) * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>

        {usage && (
          <div className="ci-stats">
            <div><em>Last request in</em><span>{usage.prompt.toLocaleString()}</span></div>
            <div><em>Reply out</em><span>{usage.output.toLocaleString()}</span></div>
            <div><em>Cached</em><span>{usage.cached.toLocaleString()}</span></div>
            <div><em>Time</em><span>{(usage.ms / 1000).toFixed(1)}s</span></div>
          </div>
        )}
        <div className="ci-stats two">
          <div><em>Last request cost</em><span>{!usage ? '-' : lastCost === null ? 'not listed' : fmtMoney(lastCost)}</span></div>
          <div><em>This chat so far</em><span>{fmtMoney(cost.total)}{cost.priced ? '' : ' +'}</span></div>
        </div>
        <div className="ci-note">{info.price ? `${info.name}: $${info.price.input} in, $${info.price.output} out per 1M tokens${info.price.cached !== null ? `, $${info.price.cached} cached` : ''}. Plan credits are used first.` : `${info.name} has no listed price yet.`}</div>

        <Section title="System prompt" meta={`${fmtTokens(estimateTokens(SYSTEM_PROMPT))} tokens`}>
          <CopyBtn text={SYSTEM_PROMPT} />
          <pre className="ci-pre">{SYSTEM_PROMPT}</pre>
        </Section>

        <Section title="Tools" meta={`${TOOL_DEFS.length} tools`}>
          <div className="ci-tools">
            {TOOL_DEFS.map((t) => (
              <div key={t.function.name} className="ci-tool">
                <code>{t.function.name}</code>
                <span>{t.function.description}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="What it sees right now" meta={`${fmtTokens(estimateTokens(ctx))} tokens`}>
          <div className="ci-row">
            <button className="ag-btn sm" onClick={() => setCtx(buildContext().full)}><Retry size={12} /> Refresh</button>
            <CopyBtn text={ctx} />
          </div>
          <pre className="ci-pre">{ctx}</pre>
        </Section>

        <Section title="Settings" meta={`thinking ${thinkLabel.toLowerCase()}`}>
          <div className="ci-kv"><em>Model</em><span>{prefs.model}</span></div>
          <div className="ci-kv"><em>Thinking</em><span>{thinkLabel}</span></div>
          <div className="ci-kv"><em>Temperature</em><span>0.4</span></div>
          <div className="ci-kv"><em>Endpoint</em><span>ollama.com/api/chat</span></div>
        </Section>
      </div>
    </div>
  )
}
