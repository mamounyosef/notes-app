import React, { useEffect } from 'react'
import { useClaude, type OutsideEdit } from '../../agent/claude'
import { undoTurn, canUndo } from '../../agent/tools'
import { Undo, X } from '../Icons'

/** How long a note about a change from outside stays up. */
const SHOW_MS = 14_000

function Item({ e }: { e: OutsideEdit }) {
  const dismiss = useClaude((s) => s.dismissOutside)
  useEffect(() => {
    const t = setTimeout(() => dismiss(e.id), SHOW_MS)
    return () => clearTimeout(t)
  }, [e.id])
  return (
    <div className={`cl-out ${e.undone ? 'undone' : ''}`}>
      <span className="cl-out-mark">✳</span>
      <div className="cl-out-t">
        <b>{e.client}</b>
        <span>{e.undone ? 'Undone' : e.summary}</span>
      </div>
      {e.turnId && !e.undone && canUndo(e.turnId) && (
        <button
          className="ag-icon-btn"
          title="Undo this change"
          onClick={async () => {
            await undoTurn(e.turnId!)
            useClaude.setState((s) => ({ outside: s.outside.map((o) => (o.id === e.id ? { ...o, undone: true } : o)) }))
          }}
        >
          <Undo size={14} />
        </button>
      )}
      <button className="ag-icon-btn" title="Dismiss" onClick={() => dismiss(e.id)}>
        <X size={13} />
      </button>
    </div>
  )
}

/** Changes the Claude app or Claude Code made to the notes from outside, each with an undo. */
export default function ClaudeOutside() {
  const items = useClaude((s) => s.outside)
  if (!items.length) return null
  return (
    <div className="cl-outs">
      {items.map((e) => (
        <Item key={e.id} e={e} />
      ))}
    </div>
  )
}
