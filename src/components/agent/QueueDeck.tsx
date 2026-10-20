/**
 * Messages typed while the agent works wait here as a small deck of tickets
 * above the composer. The top ticket has a fuse that burns while the reply
 * runs; when it ends the ticket launches into the chat. Each ticket can be
 * sent now (cutting the reply short), edited, reordered by dragging, or
 * dropped. The deck pauses (and says why) when you stop a reply or it fails.
 */
import React, { useEffect, useRef, useState } from 'react'
import { useAgent, type Queued } from '../../agent/store'
import { modelInfo, DEFAULT_MODEL } from '../../agent/models'
import { Bolt, Pencil, X, Play, QueueI, Clock, Grip, AtI, File as FileIcon } from '../Icons'

/** "8s", "2m 5s", "1h 3m". */
export function waitText(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** How many tickets show before the rest fold into the deck. */
const SHOWN = 3

export default function QueueDeck() {
  const chatId = useAgent((s) => s.chat?.id)
  const all = useAgent((s) => s.queue)
  const hold = useAgent((s) => (chatId ? s.queueHold[chatId] : undefined))
  const busy = useAgent((s) => s.busy)
  const model = useAgent((s) => s.prefs.model || DEFAULT_MODEL)
  const items = all.filter((q) => q.chatId === chatId)
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  // Tickets that just left: launched into the chat, or thrown away.
  const [ghosts, setGhosts] = useState<{ q: Queued; how: 'launch' | 'drop'; index: number }[]>([])
  const dropped = useRef(new Set<string>())
  const prev = useRef<Queued[]>(items)

  // Waiting times tick while anything waits.
  useEffect(() => {
    if (!items.length) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [items.length])

  useEffect(() => {
    const now = new Set(items.map((q) => q.id))
    const gone = prev.current.map((q, index) => ({ q, index })).filter(({ q }) => !now.has(q.id))
    prev.current = items
    if (!gone.length) return
    const add = gone.map(({ q, index }) => ({ q, index, how: dropped.current.delete(q.id) ? ('drop' as const) : ('launch' as const) }))
    setGhosts((g) => [...g, ...add])
    const t = setTimeout(() => setGhosts((g) => g.filter((x) => !add.includes(x))), 520)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, chatId])

  if (!items.length && !ghosts.length) return null
  const st = useAgent.getState()
  const name = modelInfo(model).name
  const shown = open ? items : items.slice(0, SHOWN)
  const folded = items.length - shown.length
  const status = hold ? hold : busy ? `Each goes out when ${name} finishes` : 'Sending...'

  const drop = (id: string) => {
    dropped.current.add(id)
    st.unqueue(id)
  }

  return (
    <div className={`qd ${hold ? 'held' : busy ? 'waiting' : 'going'}`}>
      <div className="qd-head">
        <span className="qd-title">
          <QueueI size={13} /> Up next <b>{items.length}</b>
        </span>
        <span className="qd-status" title={status}>{status}</span>
        <span className="spacer" />
        {hold && items.length > 0 && (
          <button className="qd-btn go" onClick={() => st.resumeQueue()} title="Send the queued messages, one after another">
            <Play size={11} /> Resume
          </button>
        )}
        {items.length > 1 && (
          <button className="qd-btn" onClick={() => st.clearQueue()} title="Throw away every queued message">
            Clear
          </button>
        )}
      </div>

      <div className="qd-list" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && drag && setDrag({ ...drag, over: -1 })}>
        {shown.map((q, i) => (
          <Ticket
            key={q.id}
            q={q}
            n={i + 1}
            first={i === 0}
            burning={i === 0 && busy && !hold}
            dragging={drag?.id === q.id}
            dropBefore={drag != null && drag.over === i && drag.id !== q.id}
            onDragStart={() => setDrag({ id: q.id, over: i })}
            onDragOver={() => drag && drag.over !== i && setDrag({ ...drag, over: i })}
            onDrop={() => {
              if (drag) st.moveQueued(drag.id, i)
              setDrag(null)
            }}
            onDragEnd={() => setDrag(null)}
            onDrop2={() => drop(q.id)}
          />
        ))}
        {ghosts.map((g) => (
          <div key={`g-${g.q.id}`} className={`qd-ticket ghost ${g.how}`} style={{ order: g.how === 'launch' ? -1 : g.index }}>
            <span className="qd-num">{g.how === 'launch' ? <Bolt size={10} /> : <X size={10} />}</span>
            <div className="qd-text">{g.q.text || g.q.attachments.map((a) => a.name).join(', ')}</div>
          </div>
        ))}
        {folded > 0 && (
          <button className="qd-more" onClick={() => setOpen(true)} title="Show every queued message">
            <span className="qd-cards"><i /><i /><i /></span>
            {folded} more waiting
          </button>
        )}
        {open && items.length > SHOWN && (
          <button className="qd-more less" onClick={() => setOpen(false)}>Fold the deck</button>
        )}
      </div>
    </div>
  )
}

function Ticket(p: {
  q: Queued
  n: number
  first: boolean
  burning: boolean
  dragging: boolean
  dropBefore: boolean
  onDragStart(): void
  onDragOver(): void
  onDrop(): void
  onDragEnd(): void
  onDrop2(): void
}) {
  const { q } = p
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(q.text)
  const ta = useRef<HTMLTextAreaElement>(null)
  const st = useAgent.getState()

  useEffect(() => {
    if (!editing) return
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }, [editing, text])

  const save = () => {
    setEditing(false)
    if (text.trim() !== q.text) st.editQueued(q.id, text)
  }

  const files = q.attachments.length
  return (
    <div
      className={`qd-ticket ${p.first ? 'first' : ''} ${p.dragging ? 'dragging' : ''} ${p.dropBefore ? 'drop-before' : ''}`}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/x-queued', q.id)
        p.onDragStart()
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/x-queued')) return
        e.preventDefault()
        p.onDragOver()
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('text/x-queued')) return
        e.preventDefault()
        e.stopPropagation()
        p.onDrop()
      }}
      onDragEnd={p.onDragEnd}
    >
      <span className="qd-grip" title="Drag to reorder"><Grip size={12} /></span>
      <span className="qd-num" title={p.first ? 'Next to go' : `Number ${p.n} in line`}>{p.n}</span>
      <div className="qd-body">
        {editing ? (
          <textarea
            ref={ta}
            className="qd-edit"
            value={text}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setText(q.text)
                setEditing(false)
              }
            }}
          />
        ) : (
          <div className="qd-text" onDoubleClick={() => setEditing(true)} title="Double click to edit">
            {q.text || <em>{files === 1 ? 'An attachment' : `${files} attachments`}</em>}
          </div>
        )}
        <div className="qd-meta">
          <span className="qd-wait"><Clock size={10} /> {waitText(Date.now() - q.at)}</span>
          {q.mentions.map((m) => (
            <span key={m.id} className="qd-tag"><AtI size={10} />{m.title}</span>
          ))}
          {files > 0 && <span className="qd-tag"><FileIcon size={10} />{files}</span>}
          {q.selection && <span className="qd-tag sel" title={q.selection.text.slice(0, 300)}>{q.selection.label}</span>}
          {q.quote && <span className="qd-tag" title={q.quote}>"{q.quote.slice(0, 24)}{q.quote.length > 24 ? '...' : ''}"</span>}
        </div>
      </div>
      <div className="qd-acts">
        <button className="qd-act now" title="Send now: cut the running reply short and send this" onClick={() => st.sendNow(q.id)}>
          <Bolt size={12} />
        </button>
        <button className="qd-act" title="Edit" onClick={() => { setText(q.text); setEditing(true) }}>
          <Pencil size={12} />
        </button>
        <button className="qd-act danger" title="Remove from the queue" onClick={p.onDrop2}>
          <X size={12} />
        </button>
      </div>
      {p.burning && <span className="qd-fuse" aria-hidden><i /></span>}
    </div>
  )
}
