import React, { useEffect, useState } from 'react'
import { useAgent, type RunInfo } from '../../agent/store'
import { X } from '../Icons'

/** Most urgent first: a question waits on you, then problems, then news, then work in progress. */
const RANK: Record<RunInfo['state'], number> = { asking: 0, error: 1, unread: 2, working: 3 }

/** Chip labels; a working chip shows its timer instead. */
const SHORT: Partial<Record<RunInfo['state'], string>> = { asking: 'asks you', unread: 'new reply', error: 'problem' }

export function elapsed(since: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** One line on what a chat is up to. */
export function runLine(r: RunInfo, now = Date.now()) {
  if (r.state === 'asking') return 'Has a question for you'
  if (r.state === 'error') return 'Stopped with a problem'
  if (r.state === 'unread') return 'New reply'
  return `${r.activity || 'Working'} · ${elapsed(r.since, now)}`
}

/** A small mark for a chat's state: spinning while it works, ? when it asks, a dot for news, ! for a problem. */
export function RunMark({ state }: { state: RunInfo['state'] }) {
  return <span className={`run-mark ${state}`}>{state === 'asking' ? '?' : state === 'error' ? '!' : null}</span>
}

/** Ticks once a second while something is working, for the timers. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/**
 * The other chats with something going on, as chips under the header:
 * they keep working while you are here, and one click takes you there.
 */
export function SessionStrip() {
  const runs = useAgent((s) => s.runs)
  const current = useAgent((s) => s.chat?.id)
  const openChat = useAgent((s) => s.openChat)
  const others = Object.entries(runs)
    .filter(([id]) => id !== current)
    .sort((a, b) => RANK[a[1].state] - RANK[b[1].state] || b[1].since - a[1].since)
  const now = useNow(others.some(([, r]) => r.state === 'working'))
  if (!others.length) return null
  return (
    <div className="ag-sessions" role="list" aria-label="Other chats">
      {others.map(([id, r]) => (
        <div
          key={id}
          role="listitem"
          className={`ag-session ${r.state}`}
          title={`${r.title}: ${runLine(r, now)}. Click to open.`}
          onClick={() => openChat(id)}
        >
          <RunMark state={r.state} />
          <span className="t">{r.title}</span>
          <span className="l">{SHORT[r.state] || elapsed(r.since, now)}</span>
          {r.state === 'working' && (
            <button
              className="x"
              title="Stop this chat"
              onClick={(e) => {
                e.stopPropagation()
                useAgent.getState().stop(id)
              }}
            >
              <X size={10} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** For the Assistant button: chats needing you, and whether any is working. */
export function useRunsSummary(includeOpen: boolean) {
  const runs = useAgent((s) => s.runs)
  const current = useAgent((s) => s.chat?.id)
  let attention = 0
  let working = 0
  let asking = 0
  for (const [id, r] of Object.entries(runs)) {
    if (id === current && !includeOpen) continue
    if (r.state === 'working') working++
    else attention++
    if (r.state === 'asking') asking++
  }
  return { attention, working, asking }
}
