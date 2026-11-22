/**
 * Memory in the chat: the header button, the card a memory tool leaves in a
 * reply (saved, updated, forgot, with Undo), and the "used memory" badge under
 * a reply the assistant shaped with what it remembers.
 */
import React, { useState } from 'react'
import type { ChatMessage } from '../../agent/api'
import { kindInfo, removeMemory, restoreMemory, useMemoryUi, type MemoryItem } from '../../agent/memory'
import { useMemory } from './MemoryManager'
import { Chevron, MemoryI, Undo } from '../Icons'

/** The header button: how much is remembered, and a glow when the assistant saves or uses a memory. */
export function MemoryButton({ onClick }: { onClick(): void }) {
  const mem = useMemory()
  const open = useMemoryUi((s) => s.open)
  const pulse = useMemoryUi((s) => s.pulse)
  const n = mem.items.filter((m) => !m.off).length
  return (
    <button
      className={`ag-icon-btn ag-mem-btn ${open ? 'on' : ''} ${mem.on ? '' : 'mem-off'}`}
      title={mem.on ? `Memory: ${n} thing${n === 1 ? '' : 's'} remembered across chats. Click to see and edit.` : 'Memory is off. Click to turn it on or see it.'}
      onClick={onClick}
    >
      <MemoryI size={15} />
      {mem.on && n > 0 && <span className="ag-mem-count">{n > 99 ? '99+' : n}</span>}
      {pulse.n > 0 && <span key={pulse.n} className={`ag-mem-glow ${pulse.kind}`} />}
    </button>
  )
}

const OP_TITLE = { add: 'Saved to memory', refresh: 'Already in memory, refreshed', update: 'Updated memory', forget: 'Forgot' } as const

/** What remember, update_memory or forget did, with Undo. */
export function MemoryCard({ m }: { m: ChatMessage }) {
  const mem = useMemory()
  const info = (m.meta as any).memory as { op: keyof typeof OP_TITLE; id: string; before?: MemoryItem; after?: MemoryItem }
  const cur = mem.items.find((x) => x.id === info.id) || null
  const shown = info.after || info.before
  const k = kindInfo(cur?.kind || shown?.kind)
  // Whether it still stands, from the memory as it is now (so it survives restarts and other computers).
  let undone = false
  if (info.op === 'add') undone = !cur
  else if (info.op === 'forget') undone = Boolean(cur)
  else if (info.op === 'update') undone = Boolean(cur && info.before && cur.text === info.before.text && cur.kind === info.before.kind)
  const canUndo = info.op !== 'refresh' && !undone
  const undo = () => {
    if (info.op === 'add') removeMemory(info.id)
    else if (info.before) restoreMemory(info.before)
  }
  const redo = () => {
    if (info.op === 'forget') removeMemory(info.id)
    else if (info.after) restoreMemory(info.after)
  }
  return (
    <div className={`ag-mem-card op-${info.op} ${undone ? 'undone' : ''}`} style={{ '--k': k.color } as React.CSSProperties}>
      <div className="ag-mem-card-head">
        <span className="ag-mem-card-icon"><MemoryI size={13} /></span>
        <b>{undone ? (info.op === 'forget' ? 'Kept after all' : info.op === 'add' ? 'Not saved (undone)' : 'Change undone') : OP_TITLE[info.op]}</b>
        <span className="ag-mem-kind"><i />{k.label}</span>
        {shown?.notebookTitle && <span className="ag-mem-kind scope">only in {shown.notebookTitle}</span>}
        <div className="spacer" />
        {canUndo && <button className="ag-mem-act" title="Put it back the way it was" onClick={undo}><Undo size={11} /> Undo</button>}
        {undone && info.op !== 'refresh' && <button className="ag-mem-act" onClick={redo}>Redo</button>}
        {(cur || info.op !== 'forget') && (
          <button className="ag-mem-act" title="See it in Memory" onClick={() => useMemoryUi.getState().show(cur ? info.id : null)}>View</button>
        )}
      </div>
      {info.op === 'update' && info.before && info.before.text !== info.after?.text && <div className="ag-mem-card-text was">{info.before.text}</div>}
      <div className={`ag-mem-card-text ${info.op === 'forget' ? 'gone' : ''}`}>{shown?.text || (m.meta as any)?.detail}</div>
    </div>
  )
}

/** Under a reply: which memories shaped it. */
export function MemoryUsed({ ids }: { ids: string[] }) {
  const mem = useMemory()
  const [open, setOpen] = useState(false)
  const items = ids.map((id) => ({ id, m: mem.items.find((x) => x.id === id) || null }))
  const known = items.filter((x) => x.m)
  if (!items.length) return null
  const first = known[0]?.m
  return (
    <div className={`ag-mem-used ${open ? 'open' : ''}`}>
      <button className="ag-mem-used-pill" onClick={() => setOpen(!open)} title="The assistant applied what it remembers about you here. Click to see which.">
        <MemoryI size={12} />
        <span>
          {known.length === 1 && first ? (
            <>Used memory: <em>{first.text.length > 46 ? `${first.text.slice(0, 46)}…` : first.text}</em></>
          ) : (
            `Used ${items.length} memories`
          )}
        </span>
        <Chevron size={11} className="ag-chev" />
      </button>
      {open && (
        <div className="ag-mem-used-list">
          {items.map(({ id, m }) => {
            const k = kindInfo(m?.kind)
            return (
              <button key={id} className={`ag-mem-used-item ${m ? '' : 'gone'}`} style={{ '--k': k.color } as React.CSSProperties} disabled={!m} onClick={() => useMemoryUi.getState().show(id)} title={m ? 'Open it in Memory' : 'Forgotten since'}>
                <i />
                <span>{m ? m.text : 'A memory that has since been forgotten'}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
