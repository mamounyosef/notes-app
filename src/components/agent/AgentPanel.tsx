import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgent, goToTarget } from '../../agent/store'
import { activePath, versionsOf } from '../../agent/branches'
import { agentApi, chatApi, type ChatAttachment, type ChatMessage } from '../../agent/api'
import { canUndo } from '../../agent/tools'
import { PROVIDER_LABEL } from '../../agent/models'
import { renderMarkdown } from '../../agent/render'
import { pathTo, useStore } from '../../store'
import { AttachmentThumb, Lightbox, type LightboxItem } from './Lightbox'
import Composer from './Composer'
import SelChip from './SelChip'
import { RunMark, SessionStrip, runLine } from './Sessions'
import { AttachmentTray, useAddFiles } from './AttachmentTray'
import { ContextRing, ContextInspector } from './ContextMeter'
import {
  AssistantOrb, StopI, Plus, History, Dock, Float, X, Brain, Chevron, Eye, Undo, Check, Copy, Retry, Trash, Pencil, File as FileIcon, Bolt, Clock, AudioLines, Mic,
} from '../Icons'
import { waitText } from './QueueDeck'
import VoiceDock, { HearingBubble, VoiceEmpty } from '../voice/VoiceDock'
import { useVoiceConversation } from '../../voice/useVoiceConversation'
import { useVoicePrefs } from '../../voice/voicePrefs'
import { voiceApi, warmVoice } from '../../voice/voiceSession'
import { clearSaying, followSaying } from '../../voice/sayingHighlight'

/** What a spoken message says, without the note for the model that it cut the last reply short. */
const spoken = (t: string) => t.replace(/^\(You were interrupted\.\)\s*/, '')


/* ------------------------------------------------------------------ *
 * Grouping: a "turn" is one user message and everything after it.
 * ------------------------------------------------------------------ */

interface Turn {
  user: ChatMessage | null
  items: ChatMessage[]
}

function toTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  // messages is the shown branch, in order (see branches.ts).
  for (const m of messages) {
    if (m.role === 'user') turns.push({ user: m, items: [] })
    else {
      if (!turns.length) turns.push({ user: null, items: [] })
      turns[turns.length - 1].items.push(m)
    }
  }
  return turns
}

const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function relDay(t: number) {
  const d = new Date(t)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  if (Date.now() - t < 7 * 864e5) return 'This week'
  if (Date.now() - t < 31 * 864e5) return 'This month'
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' })
}

/** Format a timestamp as a short AM/PM string for the chat list. */
function chatTime(t: number) {
  const d = new Date(t)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
  if (d.toDateString() === today.toDateString()) return time
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`
  if (Date.now() - t < 7 * 864e5) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/* ------------------------------------------------------------------ *
 * Pieces of a message
 * ------------------------------------------------------------------ */

function Markdown({ text, live }: { text: string; live?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const ref = useRef<HTMLDivElement>(null)
  // Copy buttons on code blocks.
  useEffect(() => {
    const el = ref.current
    if (!el || live) return
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.md-copy')) return
      const b = document.createElement('button')
      b.className = 'md-copy'
      b.textContent = 'Copy'
      b.onclick = () => {
        navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent || '')
        b.textContent = 'Copied'
        setTimeout(() => (b.textContent = 'Copy'), 1200)
      }
      pre.appendChild(b)
    })
  }, [html, live])
  // Note links: show where each one points, and mark ones whose page no longer exists.
  const tree = useStore((s) => s.workspace.tree)
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLAnchorElement>('a.note-ref').forEach((a) => {
      const path = pathTo(tree, a.dataset.page || '')
      a.classList.toggle('missing', !path.length)
      a.title = path.length ? `Open ${path.map((n) => n.title).join(' > ')}${a.dataset.cell ? ' (jumps to the cell)' : ''}` : 'This page no longer exists'
    })
  }, [html, tree])
  return (
    <div
      ref={ref}
      className={`md ${live ? 'live' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.note-ref')
        if (!a) return
        e.preventDefault()
        if (!a.classList.contains('missing')) goToTarget({ pageId: a.dataset.page, cellId: a.dataset.cell })
      }}
    />
  )
}

function Thinking({ text, ms, live }: { text: string; ms?: number; live?: boolean }) {
  const show = useAgent((s) => s.prefs.showThinking)
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // Follows the reasoning as it streams, unless the user scrolled up to read.
  const follow = useRef(true)
  useEffect(() => {
    const el = body.current
    if (open && live && el && follow.current) el.scrollTop = el.scrollHeight
  }, [text, open, live])
  if (!show || !text) return null
  const secs = ms ? Math.max(1, Math.round(ms / 1000)) : 0
  return (
    <div className={`ag-think ${open ? 'open' : ''}`}>
      <button className="ag-think-head" onClick={() => setOpen(!open)}>
        <Brain size={13} />
        <span className={live ? 'shimmer' : ''}>{live ? 'Thinking' : secs ? `Thought for ${secs}s` : 'Thought'}</span>
        <Chevron size={12} className="ag-chev" />
      </button>
      {open && (
        <div
          ref={body}
          className="ag-think-body"
          onScroll={(e) => {
            const el = e.currentTarget
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {text}
        </div>
      )}
    </div>
  )
}

function ToolChip({ m }: { m: ChatMessage }) {
  const meta = m.meta as any
  const ok = meta?.ok !== false
  const target = meta?.target
  const helper = meta?.helper as { model: string; ms: number; text: string } | undefined
  const [open, setOpen] = useState(false)
  const chip = (
    <button
      className={`ag-tool ${ok ? '' : 'failed'} ${target ? 'link' : ''}`}
      title={ok ? (target ? 'Show it' : m.toolName) : m.content.slice(0, 300)}
      onClick={() => target && goToTarget(target)}
    >
      <span className="ag-tool-dot">{ok ? <Check size={11} /> : <X size={11} />}</span>
      <span className="ag-tool-text">
        {meta?.summary || m.toolName}
        {meta?.detail && <span className="ag-tool-detail">{meta.detail}</span>}
      </span>
    </button>
  )
  const pics: string[] = meta?.images || []
  // The chat model saw the picture itself: say so, and show what it was given.
  if (!helper && pics.length)
    return (
      <div className="ag-tool-row">
        <div className="ag-tool-line">
          {chip}
          <button
            className={`ag-helper native ${open ? 'open' : ''}`}
            onClick={() => setOpen(!open)}
            title={`${meta.eyes || 'The model'} looked at the picture itself, as real image input. Click to see it.`}
          >
            <Eye size={11} />
            <span>{meta.eyes || 'Model'}, own eyes</span>
            <Chevron size={11} className="ag-chev" />
          </button>
        </div>
        {open && (
          <div className="ag-helper-pics">
            {pics.map((r) => (
              <AttachmentThumb key={r} att={{ sha: r.replace(/^sha:/, ''), mime: 'image/png', name: 'What the model saw' }} big />
            ))}
          </div>
        )}
      </div>
    )
  if (!helper) return chip
  return (
    <div className="ag-tool-row">
      <div className="ag-tool-line">
        {chip}
        <button
          className={`ag-helper ${open ? 'open' : ''}`}
          onClick={() => setOpen(!open)}
          title={`${helper.model} looked at it. Click to see what it saw.`}
        >
          <Eye size={11} />
          <span>{helper.model}</span>
          <span className="ag-helper-ms">{Math.max(1, Math.round(helper.ms / 1000))}s</span>
          <Chevron size={11} className="ag-chev" />
        </button>
      </div>
      {open && <div className="ag-helper-body">{helper.text}</div>}
    </div>
  )
}

function AskCard({ m }: { m: ChatMessage }) {
  const ask = m.meta?.ask
  const pending = useAgent((s) => s.pendingAsk?.messageId === m.id)
  const answerAsk = useAgent((s) => s.answerAsk)
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  if (!ask) return null
  const submit = (v: string) => {
    if (v.trim()) answerAsk(v.trim())
  }
  return (
    <div className={`ag-ask ${pending ? 'pending' : 'answered'}`}>
      <div className="ag-ask-q">{ask.question}</div>
      {ask.answer !== undefined ? (
        <div className="ag-ask-a"><Check size={12} /> {ask.answer}</div>
      ) : pending ? (
        <>
          {ask.options?.length ? (
            <div className="ag-ask-opts">
              {ask.options.map((o) => (
                <button
                  key={o}
                  className={`ag-opt ${picked.includes(o) ? 'on' : ''}`}
                  onClick={() => (ask.multi ? setPicked(picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o]) : submit(o))}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : null}
          <div className="ag-ask-row">
            <input
              className="ag-ask-input"
              placeholder="Or type your answer..."
              value={text}
              autoFocus={!ask.options?.length}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit(text || picked.join(', '))
              }}
            />
            {(ask.multi || text) && (
              <button className="ag-btn primary sm" onClick={() => submit(text || picked.join(', '))} disabled={!text && !picked.length}>
                Answer
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="ag-ask-a dim">Not answered</div>
      )}
    </div>
  )
}

/** "‹ 2/3 ›" between the versions at a fork (edits of a message, or regenerated replies). */
function VersionNav({ m, label }: { m: ChatMessage; label: string }) {
  const chat = useAgent((s) => s.chat)
  const busy = useAgent((s) => s.busy)
  const show = useAgent((s) => s.showVersion)
  if (!chat) return null
  const { list, index, parent } = versionsOf(chat, m)
  if (list.length < 2) return null
  const go = (d: number) => {
    const next = list[index + d]
    if (next) show(parent, next.id)
  }
  return (
    <div className="ag-versions" title={`${list.length} ${label}`}>
      <button className="ag-icon-btn" disabled={busy || index === 0} onClick={() => go(-1)} title={`Previous ${label.replace(/s$/, '')}`}>
        <Chevron size={13} className="flip" />
      </button>
      <span>
        {index + 1}/{list.length}
      </span>
      <button className="ag-icon-btn" disabled={busy || index === list.length - 1} onClick={() => go(1)} title={`Next ${label.replace(/s$/, '')}`}>
        <Chevron size={13} />
      </button>
    </div>
  )
}

/** Seconds since this reply started, shown after a few seconds so a slow model visibly is still working. */
function Elapsed() {
  const [start] = useState(() => Date.now())
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.floor((Date.now() - start) / 1000)
  if (s < 3) return null
  return <span className="ag-elapsed">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>
}

function relTime(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return timeOf(t)
}

function UserBubble({ m, onImage }: { m: ChatMessage; onImage(items: LightboxItem[], i: number): void }) {
  const busy = useAgent((s) => s.busy)
  const [editing, setEditing] = useState(false)
  const images = (m.attachments || []).filter((a) => a.kind === 'image')
  const others = (m.attachments || []).filter((a) => a.kind !== 'image')
  const items: LightboxItem[] = images.map((a) => ({ sha: a.sha, mime: a.mime, name: a.name }))
  return (
    <div className="ag-user">
      {m.meta?.quote && <div className="ag-quote">{m.meta.quote}</div>}
      {m.meta?.selection && <SelChip sel={m.meta.selection} sent />}
      {!editing && images.length > 0 && (
        <div className={`ag-user-imgs n${Math.min(images.length, 3)}`}>
          {images.map((a, i) => (
            <AttachmentThumb key={a.sha} att={a} big onClick={() => onImage(items, i)} />
          ))}
        </div>
      )}
      {!editing && others.length > 0 && (
        <div className="ag-user-files">
          {others.map((a) => (
            <div key={a.sha} className="ag-file-pill" title={a.name}>
              <FileIcon size={13} /> <span>{a.name}</span>
              {a.pageCount ? <em>{a.pageCount} p</em> : null}
            </div>
          ))}
        </div>
      )}
      {editing ? (
        <EditBox
          initial={m.content}
          initialAttachments={m.attachments || []}
          onCancel={() => setEditing(false)}
          onSend={(text, attachments) => {
            setEditing(false)
            useAgent.getState().editMessage(m.id, text, attachments)
          }}
        />
      ) : (m.content || m.meta?.mentions?.length) && (
        <div className="ag-user-text" onDoubleClick={() => !busy && setEditing(true)}>
          {m.meta?.mentions?.map((x) => (
            <span key={x.id} className="ag-mention" onClick={() => x.kind === 'page' && goToTarget({ pageId: x.id })}>@{x.title}</span>
          ))}
          {m.meta?.voice ? spoken(m.content) : m.content}
        </div>
      )}
      {!editing && (
        <div className="ag-user-bar">
          {m.meta?.voice && (
            <span className="ag-sent-tag voice" title={/^\(You were interrupted\.\)/.test(m.content) ? 'Said out loud, cutting the last reply short' : 'Said out loud in voice mode'}>
              <Mic size={11} /> spoken
            </span>
          )}
          <span className="ag-when" title={new Date(m.at).toLocaleString()}>{relTime(m.at)}</span>
          {m.meta?.queued && (
            <span className="ag-sent-tag queued" title="You typed this while the agent was working; it went out when the reply ended.">
              <Clock size={11} /> from the queue, waited {waitText(m.meta.queued.waitedMs)}
            </span>
          )}
          {m.meta?.sentNow && (
            <span className="ag-sent-tag now" title="Sent now: the reply that was running was cut short for this.">
              <Bolt size={11} /> sent now
            </span>
          )}
          <button className="ag-icon-btn" disabled={busy} onClick={() => useAgent.getState().regenerate(m.id)} title="New reply (keeps this one as a version)">
            <Retry size={13} />
          </button>
          <button className="ag-icon-btn" disabled={busy} onClick={() => setEditing(true)} title="Edit and resend (keeps the original as a version)">
            <Pencil size={13} />
          </button>
          {m.content && <CopyText text={m.content} title="Copy message" />}
          <VersionNav m={m} label="versions of your message" />
        </div>
      )}
    </div>
  )
}

/**
 * In place editor for one of your messages: Enter sends, Shift+Enter breaks
 * a line, Esc cancels. Its pictures and files can be taken out, edited, or
 * added to (paste, drop, or the + button).
 */
function EditBox({
  initial,
  initialAttachments,
  onCancel,
  onSend,
}: {
  initial: string
  initialAttachments: ChatAttachment[]
  onCancel(): void
  onSend(text: string, attachments: ChatAttachment[]): void
}) {
  const [text, setText] = useState(initial)
  const [atts, setAtts] = useState(initialAttachments)
  const [dropping, setDropping] = useState(false)
  const { pending, addFiles, working } = useAddFiles(setAtts)
  const ta = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])
  const sameFiles = atts.length === initialAttachments.length && atts.every((a, i) => a.sha === initialAttachments[i].sha)
  const changed = text.trim() !== initial.trim() || !sameFiles
  const canSend = Boolean(text.trim() || atts.length) && !working
  // Same attachment even after an edit: compare by the untouched original.
  const key = (a: ChatAttachment) => a.edit?.orig.sha || a.sha
  const removed = initialAttachments.filter((a) => !atts.some((b) => key(b) === key(a)))
  return (
    <div
      className={`ag-edit ${dropping ? 'drop' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        const files = [...e.dataTransfer.files]
        if (files.length) addFiles(files)
      }}
    >
      <AttachmentTray attachments={atts} update={setAtts} pending={pending} />
      {removed.length > 0 && (
        <div className="ag-edit-removed">
          {removed.length === 1 ? `"${removed[0].name}" won't be sent.` : `${removed.length} attachments won't be sent.`}
          <button onClick={() => setAtts((list) => [...list, ...removed])}>Put back</button>
        </div>
      )}
      <textarea
        ref={ta}
        value={text}
        placeholder={atts.length ? 'Add a message, or send the attachments alone' : 'Your message'}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length) {
            e.preventDefault()
            addFiles(files)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (canSend) onSend(text, atts)
          }
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="ag-edit-bar">
        <button className="ag-icon-btn" title="Add pictures or files (or paste, or drop them here)" onClick={() => picker.current?.click()}>
          <Plus size={14} />
        </button>
        <span className="ag-edit-hint" title="The original stays one click away">Sends as a new version.</span>
        <button className="ag-btn sm" onClick={onCancel}>Cancel</button>
        <button className="ag-btn primary sm" disabled={!canSend} onClick={() => onSend(text, atts)}>
          {changed ? 'Send' : 'Resend'}
        </button>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept="image/*,.pdf,.docx,.txt,.md,.csv,.json,.tex,.py,.js,.ts,.html,.xml,.yaml,.yml"
        onChange={(e) => {
          const files = [...(e.target.files || [])]
          e.target.value = ''
          if (files.length) addFiles(files)
        }}
      />
    </div>
  )
}

function CopyText({ text, title, className }: { text: string; title: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`ag-icon-btn ${className || ''}`}
      title={title}
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function TurnView({ turn, last, onImage }: { turn: Turn; last: boolean; onImage(items: LightboxItem[], i: number): void }) {
  const busy = useAgent((s) => s.busy)
  const live = useAgent((s) => (last ? s.live : null))
  const activity = useAgent((s) => (last ? s.activity : ''))
  const undo = useAgent((s) => s.undo)
  const [copied, setCopied] = useState(false)
  const turnMeta = turn.items.find((m) => m.meta?.turnId)?.meta
  const working = last && busy
  const answer = [...turn.items].reverse().find((m) => m.role === 'assistant' && m.content)?.content || ''

  // Tool chips sit together; text and asks in order.
  const blocks: React.ReactNode[] = []
  let chips: ChatMessage[] = []
  const flushChips = (key: string) => {
    if (chips.length) blocks.push(<div key={`c${key}`} className="ag-tools">{chips.map((c) => <ToolChip key={c.id} m={c} />)}</div>)
    chips = []
  }
  let switchNoted = 0
  for (const m of turn.items) {
    // Once per turn (and again if it changes): this reply came through a later key of the service.
    const sw = m.meta?.switched
    if (sw && sw.key !== switchNoted) {
      switchNoted = sw.key
      blocks.push(<div key={`w${m.id}`} className="ag-note" title={sw.reason}>Answered with {PROVIDER_LABEL[sw.provider]} key {sw.key} of {sw.keys}{sw.reason ? `: ${sw.reason}` : ''}</div>)
    }
    if (m.role === 'tool') {
      if (m.toolName !== 'ask_user') chips.push(m)
      continue
    }
    flushChips(m.id)
    // Each step's reasoning sits where it happened, before what it led to.
    if (m.thinking) blocks.push(<Thinking key={`t${m.id}`} text={m.thinking} ms={m.thinkingMs} />)
    if (m.meta?.ask) {
      blocks.push(<AskCard key={m.id} m={m} />)
      continue
    }
    if (m.content) blocks.push(<Markdown key={m.id} text={m.content} />)
    if (m.meta?.stopped) blocks.push(<div key={`s${m.id}`} className="ag-note">Stopped</div>)
  }
  flushChips('end')

  // The step running now: its reasoning comes last, under everything done so far.
  const liveThinking = live?.thinking && !live.content && !live.toolCalls?.length

  return (
    <div className="ag-turn">
      {turn.user && <UserBubble m={turn.user} onImage={onImage} />}
      <div className="ag-reply">
        {blocks}
        {live?.thinking ? <Thinking text={live.thinking} live={Boolean(liveThinking)} /> : null}
        {live?.content ? <Markdown text={live.content} live /> : null}
        {working && (
          <div className="ag-activity">
            <span className="ag-dots"><i /><i /><i /></span>
            <span className="shimmer">{activity || 'Working'}</span>
            <Elapsed />
          </div>
        )}
        {!working && turn.user && (answer || turnMeta?.turnId) && (
          <div className="ag-actions">
            {answer && (
              <button
                className="ag-icon-btn"
                title="Copy reply"
                onClick={() => {
                  navigator.clipboard.writeText(answer)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            )}
            {turnMeta?.turnId && !turnMeta.undone && canUndo(turnMeta.turnId) && (
              <button className="ag-undo" onClick={() => undo(turnMeta.turnId!)} title="Put back everything this reply changed">
                <Undo size={13} /> Undo changes
              </button>
            )}
            {turnMeta?.undone && <span className="ag-note">Changes undone</span>}
            {turn.items[0] && <VersionNav m={turn.items[0]} label="replies" />}
            <span className="ag-time">{timeOf(turn.items[turn.items.length - 1]?.at || turn.user.at)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Empty state, key setup, history
 * ------------------------------------------------------------------ */

function Suggestions({ onVoice }: { onVoice?(): void }) {
  const send = useAgent((s) => s.send)
  const page = useStore((s) => s.page)
  const has = Boolean(page?.cells.length)
  const list = has
    ? [
        'Summarize what is on my screen',
        'Fix spelling and grammar on this page',
        'Make the key terms bold and color the definitions',
        'Turn this page into a study sheet with questions',
        'Tidy the layout of this page',
        'What is missing from these notes?',
      ]
    : [
        'Create a page outline for a new topic',
        'Turn a photo of my notes into a page',
        'Set up a weekly planner page',
        'Switch to a calm light theme',
      ]
  return (
    <div className="ag-empty">
      <div className="ag-empty-mark"><AssistantOrb size={40} /></div>
      <div className="ag-empty-title">What should we do?</div>
      <div className="ag-empty-sub">I can see your screen, read any page, and change anything in the app. Paste a photo of notes, attach a PDF, or point at a page with @.</div>
      <div className="ag-sugs">
        {list.map((t) => (
          <button key={t} className="ag-sug" onClick={() => send(t)}>{t}</button>
        ))}
        {onVoice && (
          <button className="ag-sug vd-talk" onClick={onVoice} onMouseEnter={warmVoice} title="A spoken conversation (Ctrl+Shift+Space)">
            <span className="vd-talk-icon"><AudioLines size={14} /></span>
            <span><b>Talk instead</b> · a spoken conversation</span>
          </button>
        )}
      </div>
    </div>
  )
}

function KeySetup() {
  const refreshKey = useAgent((s) => s.refreshKey)
  const [key, setKey] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="ag-empty">
      <div className="ag-empty-mark"><AssistantOrb size={40} /></div>
      <div className="ag-empty-title">Connect Ollama Cloud</div>
      <div className="ag-empty-sub">Paste your Ollama API key (ollama.com, Settings, Keys). It is stored encrypted on this computer only.</div>
      <div className="ag-key">
        <input type="password" placeholder="Ollama API key" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
        <button
          className="ag-btn primary"
          disabled={!key.trim() || busy}
          onClick={async () => {
            setBusy(true)
            setErr('')
            const r = await agentApi.setKey(key.trim())
            setBusy(false)
            if (!r.ok) setErr(r.error || 'Could not save the key.')
            else refreshKey()
          }}
        >
          {busy ? 'Checking...' : 'Save'}
        </button>
      </div>
      {err && <div className="ag-error-text">{err}</div>}
    </div>
  )
}

function HistoryView({ onClose }: { onClose(): void }) {
  const chats = useAgent((s) => s.chats)
  const current = useAgent((s) => s.chat?.id)
  const openChat = useAgent((s) => s.openChat)
  const deleteChat = useAgent((s) => s.deleteChat)
  const renameChat = useAgent((s) => s.renameChat)
  const sync = useAgent((s) => s.syncStatus)
  const runs = useAgent((s) => s.runs)
  const [q, setQ] = useState('')
  const [now, setNow] = useState(Date.now())
  const anyWorking = Object.values(runs).some((r) => r.state === 'working')
  useEffect(() => {
    if (!anyWorking) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [anyWorking])
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const list = chats.filter((c) => !q || `${c.title} ${c.preview}`.toLowerCase().includes(q.toLowerCase()))
  let lastDay = ''
  return (
    <div className="ag-history">
      <input className="ag-search" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="ag-history-list">
        {list.length === 0 && <div className="ag-note center">No chats yet.</div>}
        {list.map((c) => {
          const day = relDay(c.updatedAt)
          const head = day !== lastDay ? <div className="ag-day">{day}</div> : null
          lastDay = day
          const run = runs[c.id]
          return (
            <React.Fragment key={c.id}>
              {head}
              <div
                className={`ag-chat-row ${c.id === current ? 'active' : ''} ${run ? `run-${run.state}` : ''}`}
                onClick={() => {
                  if (editing) return
                  openChat(c.id)
                  onClose()
                }}
              >
                {editing === c.id ? (
                  <input
                    className="ag-rename"
                    value={title}
                    autoFocus
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        renameChat(c.id, title.trim() || c.title)
                        setEditing(null)
                      }
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="ag-chat-main">
                    <div className="ag-chat-title">
                      {run && <RunMark state={run.state} />}
                      {c.voice && <AudioLines size={11} className="ag-chat-voice" />}
                      <span className="ag-chat-name">{run?.title || c.title}</span>
                      <span className="ag-chat-time">{chatTime(c.updatedAt)}</span>
                    </div>
                    {run ? (
                      <div className={`ag-chat-prev run ${run.state}`}>{runLine(run, now)}</div>
                    ) : (
                      <div className="ag-chat-prev">{c.preview || `${c.count} messages`}</div>
                    )}
                  </div>
                )}
                <div className="ag-chat-btns">
                  {run?.state === 'working' && (
                    <button
                      className="ag-icon-btn"
                      title="Stop this chat"
                      onClick={(e) => {
                        e.stopPropagation()
                        useAgent.getState().stop(c.id)
                      }}
                    >
                      <StopI size={11} />
                    </button>
                  )}
                  <button
                    className="ag-icon-btn"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(c.id)
                      setTitle(c.title)
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="ag-icon-btn danger"
                    title="Delete chat"
                    onClick={async (e) => {
                      e.stopPropagation()
                      const { askConfirm } = await import('../../lib/confirm')
                      if (await askConfirm(`Delete the chat "${c.title}"?`, 'Delete')) deleteChat(c.id)
                    }}
                  >
                    <Trash size={12} />
                  </button>
                </div>
              </div>
            </React.Fragment>
          )
        })}
      </div>
      <div className="ag-sync-line">
        {sync?.phase === 'error' ? <span className="err">Chat sync: {sync.error}</span> : sync?.phase === 'off' || !sync ? 'Chats sync between computers when you are signed in to cloud sync.' : sync.phase === 'syncing' ? 'Syncing chats...' : 'Chats synced across your computers'}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

const voiceAvailable = voiceApi.available
/** The last Ctrl+Shift+Space acted on (module wide: the request may come while the panel is still closed). */
let handledVoiceRequest = 0

export default function AgentPanel() {
  const prefs = useAgent((s) => s.prefs)
  const setPrefs = useAgent((s) => s.setPrefs)
  const toggle = useAgent((s) => s.toggle)
  const chat = useAgent((s) => s.chat)
  const busy = useAgent((s) => s.busy)
  const error = useAgent((s) => s.error)
  const hasKey = useAgent((s) => s.hasKey)
  const newChat = useAgent((s) => s.newChat)
  const retry = useAgent((s) => s.retry)
  const live = useAgent((s) => s.live)
  const [showHistory, setShowHistory] = useState(false)
  const [showCtx, setShowCtx] = useState(false)

  // Voice mode: the same chat, heard and spoken. The dock takes the composer's place.
  const [voicePrefs] = useVoicePrefs()
  const voice = useVoiceConversation(voicePrefs)
  const voiceOn = useAgent((s) => s.voiceOn)
  const voiceRequest = useAgent((s) => s.voiceRequest)
  const startVoice = useCallback(() => {
    setShowHistory(false)
    setShowCtx(false)
    void voice.start()
  }, [voice])
  // Ctrl+Shift+Space (from anywhere): voice mode on, or off again.
  useEffect(() => {
    if (voiceRequest <= handledVoiceRequest) return
    handledVoiceRequest = voiceRequest
    if (voice.active) voice.stop()
    else startVoice()
  }, [voiceRequest, voice, startVoice])
  // The sentence being said lights up in the chat.
  useEffect(() => (voice.saying && voicePrefs.follow ? followSaying(scrollRef.current, voice.saying) : clearSaying()), [voice.saying, voicePrefs.follow])
  useEffect(() => () => clearSaying(), [])
  const hearing = voiceOn && voice.active && !voice.heardFinal && (voice.phase === 'hearing' || Boolean(voice.heard))
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const composerRef = useRef<{ addFiles(files: File[]): void } | null>(null)

  useEffect(() => {
    useAgent.getState().refreshKey()
    useAgent.getState().loadChats()
    chatApi.status().then((s) => useAgent.setState({ syncStatus: s }))
    const off1 = chatApi.onStatus((s) => useAgent.setState({ syncStatus: s }))
    const off2 = chatApi.onEvent(async (ev) => {
      useAgent.getState().loadChats()
      const st = useAgent.getState()
      if (ev?.id && st.hasSession(ev.id)) {
        const c = await chatApi.get(ev.id)
        // Merge, never replace: a message sent while this was loading must survive.
        if (c) useAgent.getState().mergeRemote(c)
      }
    })
    return () => {
      off1()
      off2()
    }
  }, [])

  // Follow the conversation unless the person scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat?.messages.length, live?.content, live?.thinking, busy, hearing, voice.heard])

  const onImage = useCallback((items: LightboxItem[], index: number) => setLightbox({ items, index }), [])

  const turns = useMemo(() => toTurns(activePath(chat)), [chat])
  const overlay = prefs.mode === 'overlay'
  const fl = clampFloat(prefs.float || defaultFloat())
  const floatStyle: React.CSSProperties = { left: fl.x, top: fl.y, width: fl.w, height: fl.h }

  // Keep the floating panel on screen when the window shrinks.
  useEffect(() => {
    if (!overlay) return
    const fit = () => setPrefs({ float: clampFloat(useAgent.getState().prefs.float || defaultFloat()) })
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [overlay, setPrefs])

  const startMove = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, a')) return
    e.preventDefault()
    const start = { mx: e.clientX, my: e.clientY, ...fl }
    const move = (ev: MouseEvent) =>
      setPrefs({ float: clampFloat({ ...start, x: start.x + ev.clientX - start.mx, y: start.y + ev.clientY - start.my }) })
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'grabbing'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <>
      {!overlay && <PanelResizer />}
      <aside
        className={`agent-panel ${overlay ? 'floating' : 'docked'} ${dragOver ? 'drag-over' : ''}`}
        style={overlay ? floatStyle : { width: prefs.width }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          // A message being edited takes its own drops.
          if ((e.target as HTMLElement).closest?.('.ag-edit')) return
          const files = [...e.dataTransfer.files]
          if (files.length) composerRef.current?.addFiles(files)
        }}
      >
        {overlay && <FloatHandles />}
        <header className="ag-head" onMouseDown={overlay ? startMove : undefined} title={overlay ? 'Drag to move' : undefined}>
          <div className="ag-brand"><AssistantOrb size={20} busy={busy} /></div>
          <button className="ag-title" onClick={() => setShowHistory(!showHistory)} title="All chats">
            <span>{showHistory ? 'Chats' : chat?.title || 'New chat'}</span>
            <Chevron size={12} className={`ag-chev ${showHistory ? 'up' : ''}`} />
          </button>
          <div className="spacer" />
          {voiceAvailable && hasKey !== false && (
            <button
              className={`ag-icon-btn ${voiceOn ? 'on voice-live' : ''}`}
              title={voiceOn ? 'End voice mode (Esc)' : 'Voice mode: talk with the assistant (Ctrl+Shift+Space)'}
              onMouseEnter={warmVoice}
              onClick={() => (voice.active || voiceOn ? voice.stop() : startVoice())}
            >
              <AudioLines size={15} />
            </button>
          )}
          {hasKey !== false && <ContextRing active={showCtx} onClick={() => setShowCtx(!showCtx)} />}
          <button className="ag-icon-btn" title="New chat (Ctrl+Shift+J)" onClick={() => { newChat(); setShowHistory(false); setShowCtx(false) }}><Plus size={15} /></button>
          <button className={`ag-icon-btn ${showHistory ? 'on' : ''}`} title="Chat history" onClick={() => { setShowHistory(!showHistory); setShowCtx(false) }}><History size={15} /></button>
          <button
            className="ag-icon-btn"
            title={overlay ? 'Dock as a side pane' : 'Float over the page'}
            onClick={() => setPrefs({ mode: overlay ? 'pane' : 'overlay' })}
          >
            {overlay ? <Dock size={15} /> : <Float size={15} />}
          </button>
          <button className="ag-icon-btn" title="Close (Ctrl+J)" onClick={() => toggle(false)}><X size={15} /></button>
        </header>

        {showCtx && <ContextInspector onClose={() => setShowCtx(false)} />}
        {!showHistory && <SessionStrip />}
        {showHistory ? (
          <HistoryView onClose={() => setShowHistory(false)} />
        ) : hasKey === false ? (
          <KeySetup />
        ) : (
          <>
            <div
              className="ag-scroll"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
              }}
            >
              {turns.length === 0 && !hearing ? (
                voiceOn ? <VoiceEmpty /> : <Suggestions onVoice={voiceAvailable ? startVoice : undefined} />
              ) : (
                turns.map((t, i) => <TurnView key={t.user?.id || i} turn={t} last={i === turns.length - 1} onImage={onImage} />)
              )}
              {hearing && <HearingBubble text={voice.heard} />}
              {error && (
                <div className="ag-error">
                  <span>{error}</span>
                  {!busy && chat?.messages.length ? (
                    <button className="ag-btn sm" onClick={() => retry()}><Retry size={12} /> Retry</button>
                  ) : null}
                </div>
              )}
            </div>
            {voiceOn ? (
              <VoiceDock voice={voice} onSettings={() => window.dispatchEvent(new CustomEvent('notes:open-settings', { detail: { tab: 'voice' } }))} />
            ) : (
              <Composer ref={composerRef} onVoice={voiceAvailable ? startVoice : undefined} />
            )}
          </>
        )}
        {dragOver && <div className="ag-drop">Drop images, PDFs or documents</div>}
      </aside>
      {lightbox && <Lightbox items={lightbox.items} index={lightbox.index} onClose={() => setLightbox(null)} />}
    </>
  )
}

function PanelResizer({ floating }: { floating?: boolean }) {
  const width = useAgent((s) => s.prefs.width)
  const setPrefs = useAgent((s) => s.setPrefs)
  const start = useRef<{ x: number; w: number } | null>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!start.current) return
      const w = Math.min(Math.max(300, start.current.w - (e.clientX - start.current.x)), Math.min(900, window.innerWidth - 360))
      setPrefs({ width: w })
    }
    const up = () => {
      if (!start.current) return
      start.current = null
      setOn(false)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [setPrefs])
  return (
    <div
      className={`resizer ${floating ? 'ag-float-resizer' : 'ag-resizer'} ${on ? 'dragging' : ''}`}
      title="Drag to resize"
      onMouseDown={(e) => {
        start.current = { x: e.clientX, w: width }
        setOn(true)
        document.body.style.cursor = 'col-resize'
        e.preventDefault()
      }}
    />
  )
}

/* ------------------------------------------------------------------ *
 * Floating panel: move by the header, resize from any edge or corner.
 * ------------------------------------------------------------------ */

const MIN_W = 320
const MIN_H = 360
const TOP = 40

function defaultFloat() {
  const w = 420
  const h = Math.max(MIN_H, window.innerHeight - TOP - 24)
  return { x: window.innerWidth - w - 16, y: TOP + 8, w, h }
}

function clampFloat(f: { x: number; y: number; w: number; h: number }) {
  const w = Math.min(Math.max(MIN_W, f.w), window.innerWidth - 16)
  const h = Math.min(Math.max(MIN_H, f.h), window.innerHeight - TOP - 8)
  const x = Math.min(Math.max(8, f.x), window.innerWidth - w - 8)
  const y = Math.min(Math.max(TOP, f.y), window.innerHeight - h - 8)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

function FloatHandles() {
  const setPrefs = useAgent((s) => s.setPrefs)
  const begin = (dir: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const s = { mx: e.clientX, my: e.clientY, ...clampFloat(useAgent.getState().prefs.float || defaultFloat()) }
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - s.mx
      const dy = ev.clientY - s.my
      let { x, y, w, h } = s
      if (dir.includes('e')) w = s.w + dx
      if (dir.includes('s')) h = s.h + dy
      if (dir.includes('w')) {
        w = Math.max(MIN_W, s.w - dx)
        x = s.x + s.w - w
      }
      if (dir.includes('n')) {
        h = Math.max(MIN_H, s.h - dy)
        y = s.y + s.h - h
      }
      setPrefs({ float: clampFloat({ x, y, w, h }) })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = getComputedStyle(e.currentTarget as Element).cursor
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <>
      {DIRS.map((d) => (
        <div key={d} className={`ag-fh ${d}`} onMouseDown={begin(d)} />
      ))}
    </>
  )
}
