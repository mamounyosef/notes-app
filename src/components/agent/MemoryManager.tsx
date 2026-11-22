/**
 * The assistant's memory, seen and edited by the user: in the assistant panel
 * (the memory button in its header) and in Settings, Memory. Two scopes:
 * general (all notes) and per section (a course, inside a notebook).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { useAgent } from '../../agent/store'
import {
  MEMORY_KINDS, addMemory, currentNotebook, estimateMemoryTokens, kindInfo, memoryInScope, memoryState, notebookTitle, removeMemory, replaceAllMemories, restoreMemory, setMemoryPrefs, updateMemory, useMemoryUi,
  type MemoryItem, type MemoryKind,
} from '../../agent/memory'
import { askConfirm } from '../../lib/confirm'
import { Folder as Book, Check, GlobeI, MemoryI, PauseI, Pencil, PinI, Plus, SearchI, Trash, X } from '../Icons'

type Nb = { id: string; title: string }

const EXAMPLES: { text: string; kind: MemoryKind; notebook: boolean }[] = [
  { text: 'Logic circuit diagrams are drawn inside a box: the gates inside, inputs entering on the left and outputs leaving on the right.', kind: 'rule', notebook: true },
  { text: 'Keep answers short and to the point, with bullet points when listing things.', kind: 'style', notebook: false },
  { text: 'I study Computer Engineering at university.', kind: 'about', notebook: false },
]

const SCOPE_KEY = 'agent-memory-add-scope'

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
  useStore((s) => s.workspace.tree)
  return memoryState()
}

/** The section (course) of the open page, kept live. */
function useOpenNotebook(): Nb | null {
  useStore((s) => s.page?.id)
  useStore((s) => s.workspace.tree)
  return currentNotebook()
}

/** "General" or the notebook's name, as a small tag. */
export function ScopeTag({ m, here }: { m: Pick<MemoryItem, 'notebookId' | 'notebookTitle'>; here?: string | null }) {
  if (!m.notebookId)
    return (
      <span className="mem-scope-tag general" title="General: used in all your notes">
        <GlobeI size={10} /> General
      </span>
    )
  const title = notebookTitle(m.notebookId, m.notebookTitle)
  return (
    <span className={`mem-scope-tag nb ${here === m.notebookId ? 'here' : ''}`} title={`Only used while you work in ${title}`}>
      <Book size={10} /> {title}
    </span>
  )
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

/** General, or a section (the open one, or the one it already has). */
function ScopePick({ value, notebooks, onChange }: { value: string | null; notebooks: Nb[]; onChange(nb: Nb | null): void }) {
  return (
    <div className="mem-scope-pick" role="radiogroup" aria-label="Where it applies">
      <button type="button" className={!value ? 'on' : ''} onClick={() => onChange(null)} title="Used in all your notes">
        <GlobeI size={11} /> All notes
      </button>
      {notebooks.map((nb) => (
        <button key={nb.id} type="button" className={value === nb.id ? 'on' : ''} onClick={() => onChange(nb)} title={`Only used while you work in ${nb.title}`}>
          <Book size={11} /> {nb.title.length > 24 ? `${nb.title.slice(0, 24)}…` : nb.title}
        </button>
      ))}
    </div>
  )
}

function Row({ m, focus, here, showScope, onForget }: { m: MemoryItem; focus: boolean; here: Nb | null; showScope: boolean; onForget(m: MemoryItem): void }) {
  const stats = useMemoryUi((s) => s.stats[m.id])
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.text)
  const [kind, setKind] = useState<MemoryKind>(m.kind)
  const [scope, setScope] = useState<Nb | null>(m.notebookId ? { id: m.notebookId, title: notebookTitle(m.notebookId, m.notebookTitle) } : null)
  const ref = useRef<HTMLDivElement>(null)
  const k = kindInfo(m.kind)
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus])
  const reset = () => {
    setText(m.text)
    setKind(m.kind)
    setScope(m.notebookId ? { id: m.notebookId, title: notebookTitle(m.notebookId, m.notebookTitle) } : null)
    setEditing(false)
  }
  const save = () => {
    const t = text.trim()
    if (t) updateMemory(m.id, { text: t, kind, ...(scope ? { notebookId: scope.id, notebookTitle: scope.title } : { notebookId: null as any }) })
    setEditing(false)
  }
  const openChat = () => {
    if (!m.chatId) return
    useMemoryUi.getState().hide()
    useAgent.getState().toggle(true)
    useAgent.getState().openChat(m.chatId)
  }
  // The scopes it can move to: general, its own section, and the open one.
  const choices: Nb[] = []
  if (m.notebookId) choices.push({ id: m.notebookId, title: notebookTitle(m.notebookId, m.notebookTitle) })
  if (here && here.id !== m.notebookId) choices.push(here)
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
                  reset()
                }
              }}
            />
            <div className="mem-edit-bar">
              <ScopePick value={scope?.id || null} notebooks={choices} onChange={setScope} />
            </div>
            <div className="mem-edit-bar">
              <KindPick value={kind} onChange={setKind} />
              <div className="spacer" />
              <button className="mem-btn" onClick={reset}>Cancel</button>
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
          <span className="mem-kind-tag"><i />{k.label}</span>
          {showScope && <ScopeTag m={m} here={here?.id} />}
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
          <button className="mem-icon" title="Edit (text, kind, where it applies)" onClick={() => setEditing(true)}><Pencil size={13} /></button>
          <button className="mem-icon danger" title="Forget" onClick={() => onForget(m)}><Trash size={13} /></button>
        </div>
      )}
    </div>
  )
}

/** Everything the assistant remembers, general and per section, with add, edit, move, pause, pin, forget, import and export. */
export default function MemoryManager({ mode, onClose }: { mode: 'panel' | 'settings'; onClose?(): void }) {
  const mem = useMemory()
  const here = useOpenNotebook()
  const focus = useMemoryUi((s) => s.focus)
  const stats = useMemoryUi((s) => s.stats)
  const [q, setQ] = useState('')
  const [kindF, setKindF] = useState<MemoryKind | 'all'>('all')
  /** 'all', 'general', or a notebook id. */
  const [scopeF, setScopeF] = useState<string>('all')
  const [sort, setSort] = useState<'scope' | 'recent' | 'used'>('scope')
  const [draft, setDraft] = useState('')
  const [draftKind, setDraftKind] = useState<MemoryKind>('rule')
  const [draftNb, setDraftNb] = useState<boolean>(() => localStorage.getItem(SCOPE_KEY) === 'notebook')
  const [undo, setUndo] = useState<{ items: MemoryItem[]; label: string } | null>(null)
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
    const { item } = addMemory({ text: t, kind: draftKind, notebook: draftNb && here ? here : null, by: 'you' })
    setDraft('')
    useMemoryUi.setState({ focus: item.id })
  }
  const pickDraftScope = (nb: Nb | null) => {
    setDraftNb(Boolean(nb))
    localStorage.setItem(SCOPE_KEY, nb ? 'notebook' : 'general')
  }

  // Sections that have memories, the open one first.
  const notebooks = useMemo(() => {
    const seen = new Map<string, Nb & { n: number }>()
    for (const m of mem.items) {
      if (!m.notebookId) continue
      const cur = seen.get(m.notebookId)
      if (cur) cur.n++
      else seen.set(m.notebookId, { id: m.notebookId, title: notebookTitle(m.notebookId, m.notebookTitle), n: 1 })
    }
    return [...seen.values()].sort((a, b) => Number(b.id === here?.id) - Number(a.id === here?.id) || a.title.localeCompare(b.title))
  }, [mem.items, here?.id])

  const generalCount = mem.items.filter((m) => !m.notebookId).length
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const m of mem.items) c[m.kind] = (c[m.kind] || 0) + 1
    return c
  }, [mem.items])

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    let l = mem.items.filter(
      (m) =>
        (kindF === 'all' || m.kind === kindF) &&
        (scopeF === 'all' || (scopeF === 'general' ? !m.notebookId : m.notebookId === scopeF)) &&
        words.every((w) => `${m.text} ${notebookTitle(m.notebookId, m.notebookTitle)} ${m.chatTitle || ''}`.toLowerCase().includes(w)),
    )
    const order = MEMORY_KINDS.map((k) => k.kind)
    if (sort === 'recent') l = [...l].sort((a, b) => b.updatedAt - a.updatedAt)
    else if (sort === 'used') l = [...l].sort((a, b) => (stats[b.id]?.uses || 0) - (stats[a.id]?.uses || 0) || b.updatedAt - a.updatedAt)
    else l = [...l].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || order.indexOf(a.kind) - order.indexOf(b.kind) || b.createdAt - a.createdAt)
    return l
  }, [mem.items, q, kindF, scopeF, sort, stats])

  // By scope: general first, then the open notebook, then the others.
  const grouped = sort === 'scope' && scopeF === 'all'
  const groups: { key: string; nb: (Nb & { n?: number }) | null; general: boolean; items: MemoryItem[] }[] = grouped
    ? [
        { key: 'general', nb: null, general: true, items: list.filter((m) => !m.notebookId) },
        ...notebooks.map((nb) => ({ key: nb.id, nb, general: false, items: list.filter((m) => m.notebookId === nb.id) })),
      ].filter((g) => g.items.length || (g.general && !q && kindF === 'all'))
    : [{ key: 'list', nb: null, general: false, items: list }]
  const inPlay = memoryInScope(mem.items).length
  const paused = mem.items.filter((m) => m.off).length

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
    if (!(await askConfirm(`Forget all ${mem.items.length} memories, general and every section's? You can undo it right after.`, 'Forget all'))) return
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
                ? `${generalCount} general, ${mem.items.length - generalCount} in courses and sections${paused ? `, ${paused} paused` : ''}. ${here ? `In ${here.title} the assistant keeps ${inPlay} in mind` : `It keeps ${inPlay} in mind now`} (about ${estimateMemoryTokens().toLocaleString()} tokens per message).`
                : 'Nothing remembered yet. Tell the assistant "remember …", or add something below. It decides on its own whether a memory is general or just for one course (section).'
              : 'Memory is off: the assistant starts every chat knowing nothing about you.'}
          </p>
        </div>
        {mode === 'panel' && onClose && (
          <button className="ag-history-close" title="Close memory (Esc, mouse back)" onClick={onClose}><X size={14} /></button>
        )}
      </div>

      <div className="mem-toggles">
        <Toggle on={mem.on} onChange={(on) => setMemoryPrefs({ on })} label="Use memory" sub="General memories in every chat, a course's (section's) own memories while you work in it. Every model." />
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
          <span className="mem-add-label">Applies to</span>
          <ScopePick value={draftNb && here ? here.id : null} notebooks={here ? [here] : []} onChange={pickDraftScope} />
          {!here && <span className="mem-add-hint">Open a page to add one for its section.</span>}
        </div>
        <div className="mem-add-bar">
          <KindPick value={draftKind} onChange={setDraftKind} />
          <div className="spacer" />
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
          <div className="mem-filter scopes">
            <button className={scopeF === 'all' ? 'on' : ''} onClick={() => setScopeF('all')}>Everything <span>{mem.items.length}</span></button>
            <button className={scopeF === 'general' ? 'on' : ''} onClick={() => setScopeF(scopeF === 'general' ? 'all' : 'general')} title="Used in all your notes">
              <GlobeI size={11} /> General <span>{generalCount}</span>
            </button>
            {notebooks.map((nb) => (
              <button key={nb.id} className={`${scopeF === nb.id ? 'on' : ''} ${nb.id === here?.id ? 'here' : ''}`} onClick={() => setScopeF(scopeF === nb.id ? 'all' : nb.id)} title={nb.id === here?.id ? 'The section open now' : `Only used in ${nb.title}`}>
                <Book size={11} /> {nb.title.length > 20 ? `${nb.title.slice(0, 20)}…` : nb.title} <span>{nb.n}</span>
              </button>
            ))}
          </div>
          <div className="mem-filter">
            <button className={kindF === 'all' ? 'on' : ''} onClick={() => setKindF('all')}>All kinds</button>
            {MEMORY_KINDS.map((k) => (
              <button key={k.kind} className={kindF === k.kind ? 'on' : ''} style={{ '--k': k.color } as React.CSSProperties} onClick={() => setKindF(kindF === k.kind ? 'all' : k.kind)} title={k.hint}>
                <i />
                {k.label} <span>{kindCounts[k.kind] || 0}</span>
              </button>
            ))}
            <div className="spacer" />
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} title="Order">
              <option value="scope">By scope</option>
              <option value="recent">Recently changed</option>
              <option value="used">Most used</option>
            </select>
          </div>
        </div>
      )}

      <div className="mem-list">
        {mem.items.length === 0 ? (
          <div className="mem-empty">
            <p>Two kinds of memory: <b>general</b> (true in all your notes, like how you like answers) and <b>section</b> (just for one course, like how its diagrams look). Try one:</p>
            {EXAMPLES.map((e) => (
              <button
                key={e.text}
                className="mem-example"
                style={{ '--k': kindInfo(e.kind).color } as React.CSSProperties}
                onClick={() => {
                  setDraft(e.text)
                  setDraftKind(e.kind)
                  pickDraftScope(e.notebook && here ? here : null)
                }}
              >
                <i />
                <span>{e.text}</span>
                <em>{e.notebook ? (here ? here.title : 'a course') : 'General'}</em>
              </button>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="mem-empty"><p>No memory matches.</p></div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className={`mem-group ${g.general ? 'general' : g.nb ? 'nb' : ''}`}>
              {grouped && (
                <div className={`mem-group-head ${g.nb?.id && g.nb.id === here?.id ? 'here' : ''}`}>
                  {g.general ? <GlobeI size={13} /> : <Book size={13} />}
                  <span>{g.general ? 'General' : g.nb!.title}</span>
                  <em>{g.general ? 'all notes, every chat' : g.nb!.id === here?.id ? 'open now: in use' : 'only in this section'}</em>
                  <span className="mem-group-line" />
                  <b>{g.items.length}</b>
                </div>
              )}
              {g.items.length === 0 && <div className="mem-group-empty">Nothing general yet.</div>}
              {g.items.map((m) => (
                <Row key={m.id} m={m} focus={focus === m.id} here={here} showScope={!grouped} onForget={forget} />
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
