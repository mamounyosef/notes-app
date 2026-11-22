/**
 * The assistant's memory, seen and edited by the user: in the assistant panel
 * (the memory button in its header) and in Settings, Memory.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { useAgent } from '../../agent/store'
import {
  MEMORY_KINDS, addMemory, currentNotebook, estimateMemoryTokens, kindInfo, memoryState, removeMemory, replaceAllMemories, restoreMemory, setMemoryPrefs, updateMemory, useMemoryUi,
  type MemoryItem, type MemoryKind,
} from '../../agent/memory'
import { askConfirm } from '../../lib/confirm'
import { Check, MemoryI, PauseI, Pencil, PinI, Plus, SearchI, Trash, X } from '../Icons'

const EXAMPLES: { text: string; kind: MemoryKind }[] = [
  { text: 'Logic circuit diagrams are drawn inside a box: the gates inside, inputs entering on the left and outputs leaving on the right.', kind: 'rule' },
  { text: 'Keep answers short and to the point, with bullet points when listing things.', kind: 'style' },
  { text: 'I study Computer Engineering at university.', kind: 'about' },
]

export function relAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

/** Live memory state (re-renders when it changes, here or from another computer). */
export function useMemory() {
  useStore((s) => (s.settings as any).assistantMemory)
  return memoryState()
}

function Toggle({ on, onChange, label, sub }: { on: boolean; onChange(v: boolean): void; label: string; sub: string }) {
  return (
    <label className={`mem-toggle ${on ? 'on' : ''}`}>
      <span className="mem-toggle-text">
        <b>{label}</b>
        <em>{sub}</em>
      </span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="mem-switch" aria-hidden />
    </label>
  )
}

function KindPick({ value, onChange }: { value: MemoryKind; onChange(k: MemoryKind): void }) {
  return (
    <div className="mem-kinds-pick">
      {MEMORY_KINDS.map((k) => (
        <button key={k.kind} type="button" className={value === k.kind ? 'on' : ''} style={{ '--k': k.color } as React.CSSProperties} title={k.hint} onClick={() => onChange(k.kind)}>
          <i />
          {k.label}
        </button>
      ))}
    </div>
  )
}

function Row({ m, focus, onForget }: { m: MemoryItem; focus: boolean; onForget(m: MemoryItem): void }) {
  const stats = useMemoryUi((s) => s.stats[m.id])
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.text)
  const [kind, setKind] = useState<MemoryKind>(m.kind)
  const ref = useRef<HTMLDivElement>(null)
  const k = kindInfo(m.kind)
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus])
  const save = () => {
    const t = text.trim()
    if (t && (t !== m.text || kind !== m.kind)) updateMemory(m.id, { text: t, kind })
    setEditing(false)
  }
  const openChat = () => {
    if (!m.chatId) return
    useMemoryUi.getState().hide()
    useAgent.getState().toggle(true)
    useAgent.getState().openChat(m.chatId)
  }
  return (
    <div ref={ref} className={`mem-row ${m.off ? 'off' : ''} ${focus ? 'flash' : ''} ${editing ? 'editing' : ''}`} style={{ '--k': k.color } as React.CSSProperties}>
      <span className="mem-bar" />
      <div className="mem-main">
        {editing ? (
          <>
            <textarea
              className="mem-edit"
              value={text}
              autoFocus
              rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  save()
                }
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setText(m.text)
                  setKind(m.kind)
                  setEditing(false)
                }
              }}
            />
            <div className="mem-edit-bar">
              <KindPick value={kind} onChange={setKind} />
              <div className="spacer" />
              <button className="mem-btn" onClick={() => { setText(m.text); setKind(m.kind); setEditing(false) }}>Cancel</button>
              <button className="mem-btn primary" onClick={save}><Check size={12} /> Save</button>
            </div>
          </>
        ) : (
          <div className="mem-text" onDoubleClick={() => setEditing(true)} title="Double click to edit">
            {m.pinned && <PinI size={12} className="mem-pin-mark" />}
            {m.text}
          </div>
        )}
        <div className="mem-meta">
          {m.notebookId && <span className="mem-tag scope" title="Only used while you work in this notebook">only in {m.notebookTitle || 'a notebook'}</span>}
          {m.off && <span className="mem-tag paused">paused</span>}
          <span title={new Date(m.createdAt).toLocaleString()}>
            {m.by === 'assistant' ? 'Learned' : 'Added by you'} {relAgo(m.createdAt)}
          </span>
          {m.chatId && (
            <button className="mem-link" onClick={openChat} title="Open the chat it was learned in">
              in “{(m.chatTitle || 'a chat').slice(0, 40)}”
            </button>
          )}
          <span className={`mem-uses ${stats?.uses ? 'used' : ''}`} title={stats?.last ? `Last used ${new Date(stats.last).toLocaleString()} (on this computer)` : 'The assistant has not said it used this yet (on this computer)'}>
            {stats?.uses ? `used ${stats.uses}× · ${relAgo(stats.last)}` : 'not used yet'}
          </span>
        </div>
      </div>
      {!editing && (
        <div className="mem-actions">
          <button className={`mem-icon ${m.pinned ? 'on' : ''}`} title={m.pinned ? 'Not important' : 'Important: listed first, the assistant gives it more weight'} onClick={() => updateMemory(m.id, { pinned: !m.pinned })}><PinI size={13} /></button>
          <button className={`mem-icon ${m.off ? 'on' : ''}`} title={m.off ? 'Resume: give it to the assistant again' : 'Pause: keep it, but do not give it to the assistant'} onClick={() => updateMemory(m.id, { off: !m.off })}><PauseI size={13} /></button>
          <button className="mem-icon" title="Edit" onClick={() => setEditing(true)}><Pencil size={13} /></button>
          <button className="mem-icon danger" title="Forget" onClick={() => onForget(m)}><Trash size={13} /></button>
        </div>
      )}
    </div>
  )
}

/** Everything the assistant remembers, with add, edit, pause, pin, forget, import and export. */
export default function MemoryManager({ mode, onClose }: { mode: 'panel' | 'settings'; onClose?(): void }) {
  const mem = useMemory()
  const focus = useMemoryUi((s) => s.focus)
  const stats = useMemoryUi((s) => s.stats)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<MemoryKind | 'all'>('all')
  const [sort, setSort] = useState<'kind' | 'recent' | 'used'>('kind')
  const [draft, setDraft] = useState('')
  const [draftKind, setDraftKind] = useState<MemoryKind>('rule')
  const [scoped, setScoped] = useState(false)
  const [undo, setUndo] = useState<{ items: MemoryItem[]; label: string } | null>(null)
  const nb = currentNotebook()
  const fileRef = useRef<HTMLInputElement>(null)
  const undoTimer = useRef<any>(null)

  // In the panel: Esc and the mouse back button close it (App sends the event).
  useEffect(() => {
    if (mode !== 'panel' || !onClose) return
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement?.closest('.agent-panel') && !document.activeElement?.closest('.mem-edit, .mem-add textarea')) close()
    }
    window.addEventListener('agent:close-history', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('agent:close-history', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [mode, onClose])
  // The focus flash fades on its own.
  useEffect(() => {
    if (!focus) return
    const t = setTimeout(() => useMemoryUi.setState({ focus: null }), 2400)
    return () => clearTimeout(t)
  }, [focus])

  const showUndo = (items: MemoryItem[], label: string) => {
    clearTimeout(undoTimer.current)
    setUndo({ items, label })
    undoTimer.current = setTimeout(() => setUndo(null), 8000)
  }
  const forget = (m: MemoryItem) => {
    removeMemory(m.id)
    showUndo([m], `Forgot “${m.text.slice(0, 48)}${m.text.length > 48 ? '…' : ''}”`)
  }

  const add = () => {
    const t = draft.trim()
    if (!t) return
    const { item } = addMemory({ text: t, kind: draftKind, notebook: scoped ? nb : null, by: 'you' })
    setDraft('')
    useMemoryUi.setState({ focus: item.id })
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: mem.items.length }
    for (const m of mem.items) c[m.kind] = (c[m.kind] || 0) + 1
    return c
  }, [mem.items])

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    let l = mem.items.filter((m) => (filter === 'all' || m.kind === filter) && words.every((w) => `${m.text} ${m.notebookTitle || ''} ${m.chatTitle || ''}`.toLowerCase().includes(w)))
    if (sort === 'recent') l = [...l].sort((a, b) => b.updatedAt - a.updatedAt)
    else if (sort === 'used') l = [...l].sort((a, b) => (stats[b.id]?.uses || 0) - (stats[a.id]?.uses || 0) || b.updatedAt - a.updatedAt)
    else l = [...l].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt)
    return l
  }, [mem.items, q, filter, sort, stats])

  const groups = sort === 'kind' && filter === 'all' && !q ? MEMORY_KINDS.map((k) => ({ k, items: list.filter((m) => m.kind === k.kind) })).filter((g) => g.items.length) : [{ k: null, items: list }]
  const active = mem.items.filter((m) => !m.off).length

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ app: 'Notes', kind: 'assistant-memory', version: 1, exportedAt: new Date().toISOString(), items: mem.items }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `notes-assistant-memory-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  const importJson = async (f: File) => {
    try {
      const data = JSON.parse(await f.text())
      const incoming: MemoryItem[] = (Array.isArray(data) ? data : data.items || []).filter((m: any) => m && typeof m.text === 'string')
      let added = 0
      for (const m of incoming) {
        const before = memoryState().items.length
        addMemory({ text: m.text, kind: MEMORY_KINDS.some((k) => k.kind === m.kind) ? m.kind : 'fact', by: m.by === 'assistant' ? 'assistant' : 'you', pinned: m.pinned, notebook: m.notebookId ? { id: m.notebookId, title: m.notebookTitle || '' } : null })
        if (memoryState().items.length > before) added++
      }
      showUndo([], `Imported ${added} new memor${added === 1 ? 'y' : 'ies'}${incoming.length - added ? `, ${incoming.length - added} already known` : ''}`)
    } catch {
      showUndo([], 'That file is not a memory export.')
    }
  }
  const clearAll = async () => {
    if (!mem.items.length) return
    if (!(await askConfirm(`Forget all ${mem.items.length} memories? You can undo it right after.`, 'Forget all'))) return
    const items = mem.items
    replaceAllMemories([])
    showUndo(items, `Forgot all ${items.length} memories`)
  }

  return (
    <div className={`mem-view ${mode}`}>
      <div className="mem-hero">
        <div className={`mem-hero-icon ${mem.on ? '' : 'off'}`}><MemoryI size={22} /></div>
        <div className="mem-hero-text">
          <h3>Memory</h3>
          <p>
            {mem.on
              ? mem.items.length
                ? `${active} thing${active === 1 ? '' : 's'} the assistant keeps in mind in every chat${mem.items.length - active ? ` (${mem.items.length - active} paused)` : ''}. About ${estimateMemoryTokens().toLocaleString()} tokens per message.`
                : 'Nothing remembered yet. Tell the assistant "remember …", or add something below.'
              : 'Memory is off: the assistant starts every chat knowing nothing about you.'}
          </p>
        </div>
        {mode === 'panel' && onClose && (
          <button className="ag-history-close" title="Close memory (Esc, mouse back)" onClick={onClose}><X size={14} /></button>
        )}
      </div>

      <div className="mem-toggles">
        <Toggle on={mem.on} onChange={(on) => setMemoryPrefs({ on })} label="Use memory" sub="Give the assistant what is below in every chat, with every model." />
        <Toggle on={mem.on && mem.auto} onChange={(auto) => setMemoryPrefs({ auto, ...(auto ? { on: true } : {}) })} label="Learn on its own" sub="Also save lasting preferences and corrections without being asked. Off: only when you say “remember”." />
      </div>

      <div className="mem-add">
        <textarea
          placeholder="Teach it something… e.g. “Always put logic designs inside a box”"
          value={draft}
          rows={draft.length > 70 ? 3 : 2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              add()
            }
          }}
        />
        <div className="mem-add-bar">
          <KindPick value={draftKind} onChange={setDraftKind} />
          <div className="spacer" />
          {nb && (
            <label className="mem-scope" title="Only use it while you work in this notebook">
              <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
              only in {nb.title.slice(0, 22)}
            </label>
          )}
          <button className="mem-btn primary" disabled={!draft.trim()} onClick={add}><Plus size={12} /> Remember</button>
        </div>
      </div>

      {mem.items.length > 0 && (
        <div className="mem-tools">
          <div className="mem-search">
            <SearchI size={13} />
            <input placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && <button onClick={() => setQ('')}><X size={11} /></button>}
          </div>
          <div className="mem-filter">
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All <span>{counts.all}</span></button>
            {MEMORY_KINDS.map((k) => (
              <button key={k.kind} className={filter === k.kind ? 'on' : ''} style={{ '--k': k.color } as React.CSSProperties} onClick={() => setFilter(filter === k.kind ? 'all' : k.kind)} title={k.hint}>
                <i />
                {k.label} <span>{counts[k.kind] || 0}</span>
              </button>
            ))}
            <div className="spacer" />
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} title="Order">
              <option value="kind">By kind</option>
              <option value="recent">Recently changed</option>
              <option value="used">Most used</option>
            </select>
          </div>
        </div>
      )}

      <div className="mem-list">
        {mem.items.length === 0 ? (
          <div className="mem-empty">
            <p>Things worth remembering: how you like your notes to look, how you like answers, what you study. Try one:</p>
            {EXAMPLES.map((e) => (
              <button key={e.text} className="mem-example" style={{ '--k': kindInfo(e.kind).color } as React.CSSProperties} onClick={() => { setDraft(e.text); setDraftKind(e.kind) }}>
                <i />
                {e.text}
              </button>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="mem-empty"><p>No memory matches.</p></div>
        ) : (
          groups.map((g) => (
            <div key={g.k?.kind || 'list'} className="mem-group">
              {g.k && (
                <div className="mem-group-head" style={{ '--k': g.k.color } as React.CSSProperties}>
                  <i />
                  <span>{g.k.label}</span>
                  <em>{g.k.hint}</em>
                  <span className="mem-group-line" />
                  <b>{g.items.length}</b>
                </div>
              )}
              {g.items.map((m) => (
                <Row key={m.id} m={m} focus={focus === m.id} onForget={forget} />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="mem-foot">
        <span>Synced to your other computers with your settings. Use counts are per computer.</span>
        <div className="spacer" />
        <button className="mem-btn" onClick={() => fileRef.current?.click()}>Import</button>
        <button className="mem-btn" disabled={!mem.items.length} onClick={exportJson}>Export</button>
        <button className="mem-btn danger" disabled={!mem.items.length} onClick={clearAll}><Trash size={12} /> Forget all</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = '' }} />
      </div>

      {undo && (
        <div className="mem-undo">
          <span>{undo.label}</span>
          {undo.items.length > 0 && (
            <button
              onClick={() => {
                for (const m of undo.items) restoreMemory(m)
                setUndo(null)
              }}
            >
              Undo
            </button>
          )}
          <button className="x" onClick={() => setUndo(null)}><X size={11} /></button>
        </div>
      )}
    </div>
  )
}
