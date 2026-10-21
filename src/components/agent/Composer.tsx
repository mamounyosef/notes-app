import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useAgent, type Mention } from '../../agent/store'
import { agentApi } from '../../agent/api'
import { fileToAttachment, prettySize } from '../../agent/files'
import { useStore, walk, pathTo } from '../../store'
import { AttachmentThumb, type LightboxItem } from './Lightbox'
import ModelPicker from './ModelPicker'
import QueueDeck from './QueueDeck'
import { Send, StopI, Mic, Plus, X, AtI, File as FileIcon, Book, Folder, Bolt, QueueI, AudioLines } from '../Icons'
import { warmVoice } from '../../voice/voiceSession'
import type { TreeNode } from '../../types'

interface Pending {
  id: number
  name: string
  status: string
  error?: string
}

let pendingSeq = 0

const Composer = forwardRef<{ addFiles(files: File[]): void }, { onImage(items: LightboxItem[], i: number): void; onVoice?(): void }>(function Composer({ onImage, onVoice }, ref) {
  const draft = useAgent((s) => s.draft)
  const setDraft = useAgent((s) => s.setDraft)
  const attachments = useAgent((s) => s.attachments)
  const mentions = useAgent((s) => s.mentions)
  const quote = useAgent((s) => s.quote)
  const busy = useAgent((s) => s.busy)
  const asking = useAgent((s) => Boolean(s.pendingAsk))
  const prefs = useAgent((s) => s.prefs)
  const selection = useAgent((s) => s.selection)
  const dismissed = useAgent((s) => s.selectionDismissed)
  const send = useAgent((s) => s.send)
  const stop = useAgent((s) => s.stop)
  const [pending, setPending] = useState<Pending[]>([])
  const [mention, setMention] = useState<{ q: string; start: number; index: number } | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      const id = ++pendingSeq
      setPending((p) => [...p, { id, name: f.name || 'pasted image', status: 'Adding' }])
      try {
        const att = await fileToAttachment(f, (status) => setPending((p) => p.map((x) => (x.id === id ? { ...x, status } : x))))
        useAgent.getState().addAttachment(att)
        setPending((p) => p.filter((x) => x.id !== id))
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        setPending((p) => p.map((x) => (x.id === id ? { ...x, error } : x)))
        setTimeout(() => setPending((p) => p.filter((x) => x.id !== id)), 6000)
      }
    }
  }
  useImperativeHandle(ref, () => ({ addFiles }))

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(220, el.scrollHeight)}px`
  }, [draft])

  useEffect(() => {
    if (prefs.open) setTimeout(() => ta.current?.focus(), 60)
  }, [prefs.open])

  /* ---------- @ mentions ---------- */
  const tree = useStore((s) => s.workspace.tree)
  const options = useMemo(() => {
    if (!mention) return []
    const q = mention.q.toLowerCase()
    const out: { node: TreeNode; path: string }[] = []
    walk(tree, (n) => {
      if (n.archived) return
      if (!q || n.title.toLowerCase().includes(q)) out.push({ node: n, path: pathTo(tree, n.id).slice(0, -1).map((x) => x.title).join(' / ') })
    })
    const rank = (t: string) => (t.toLowerCase().startsWith(q) ? 0 : 1)
    return out.sort((a, b) => rank(a.node.title) - rank(b.node.title) || (a.node.kind === 'page' ? -1 : 1)).slice(0, 8)
  }, [mention, tree])

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(before)
    if (m) setMention((cur) => ({ q: m[2], start: caret - m[2].length - 1, index: cur?.q === m[2] ? cur.index : 0 }))
    else setMention(null)
  }

  const pickMention = (n: TreeNode) => {
    if (!mention) return
    const el = ta.current!
    const caret = el.selectionStart
    const next = draft.slice(0, mention.start) + draft.slice(caret)
    setDraft(next)
    const m: Mention = { id: n.id, title: n.title, kind: n.kind }
    useAgent.getState().addMention(m)
    setMention(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(mention.start, mention.start)
    })
  }

  const canSend = Boolean(draft.trim() || attachments.length) && !pending.some((p) => !p.error)
  const images = attachments.filter((a) => a.kind === 'image')
  const imgItems: LightboxItem[] = images.map((a) => ({ sha: a.sha, mime: a.mime, name: a.name }))

  return (
    <div className="ag-composer">
      {mention && options.length > 0 && (
        <div className="ag-mention-pop">
          {options.map((o, i) => (
            <button
              key={o.node.id}
              className={`ag-mention-opt ${i === mention.index ? 'on' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pickMention(o.node)
              }}
            >
              {o.node.kind === 'page' ? <FileIcon size={13} /> : o.node.kind === 'section' ? <Folder size={13} /> : <Book size={13} />}
              <span className="t">{o.node.title}</span>
              <span className="p">{o.path}</span>
            </button>
          ))}
        </div>
      )}

      <QueueDeck />
      <div className={`ag-box ${asking ? 'asking' : ''}`}>
        {(quote || mentions.length > 0 || attachments.length > 0 || pending.length > 0) && (
          <div className="ag-chips">
            {quote && (
              <div className="ag-chip quote" title={quote}>
                <span className="q">"{quote.slice(0, 80)}{quote.length > 80 ? '...' : ''}"</span>
                <button onClick={() => useAgent.getState().setQuote(null)}><X size={11} /></button>
              </div>
            )}
            {mentions.map((m) => (
              <div key={m.id} className="ag-chip mention">
                <AtI size={12} /> {m.title}
                <button onClick={() => useAgent.getState().removeMention(m.id)}><X size={11} /></button>
              </div>
            ))}
            {images.map((a, i) => (
              <div key={a.sha} className="ag-chip img">
                <AttachmentThumb att={a} onClick={() => onImage(imgItems, i)} />
                <button className="x" onClick={() => useAgent.getState().removeAttachment(a.sha)}><X size={11} /></button>
              </div>
            ))}
            {attachments.filter((a) => a.kind !== 'image').map((a) => (
              <div key={a.sha} className="ag-chip file" title={a.name}>
                <FileIcon size={13} />
                <span className="n">{a.name}</span>
                <em>{a.pageCount ? `${a.pageCount} pages` : prettySize(a.size)}</em>
                <button onClick={() => useAgent.getState().removeAttachment(a.sha)}><X size={11} /></button>
              </div>
            ))}
            {pending.map((p) => (
              <div key={p.id} className={`ag-chip file ${p.error ? 'err' : 'busy'}`} title={p.error || p.status}>
                <span className="n">{p.error || `${p.name}: ${p.status}`}</span>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={ta}
          className="agent-input"
          rows={1}
          placeholder={asking ? 'Type your answer...' : busy ? 'Working... Enter queues your next message, Ctrl+Enter sends it now' : 'Ask or tell me what to change. @ to point at a page'}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            updateMention(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            if (mention && options.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const d = e.key === 'ArrowDown' ? 1 : -1
                setMention({ ...mention, index: (mention.index + d + options.length) % options.length })
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickMention(options[mention.index].node)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMention(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // Ctrl+Enter while it works: cut the reply short and send this now.
              if ((e.ctrlKey || e.metaKey) && busy && !asking) {
                if (canSend) useAgent.getState().sendNow()
                return
              }
              if (canSend || asking) send()
              return
            }
            // Up in an empty box takes the last queued message back to edit.
            if (e.key === 'ArrowUp' && !draft && !attachments.length && !asking) {
              const s = useAgent.getState()
              const last = s.queue.filter((q) => q.chatId === s.chat?.id).pop()
              if (last) {
                e.preventDefault()
                s.unqueue(last.id)
                useAgent.setState({ draft: last.text, attachments: last.attachments, mentions: last.mentions, quote: last.quote })
                return
              }
            }
            if (e.key === 'Escape' && busy) {
              e.preventDefault()
              stop()
            }
            if (e.key === 'Backspace' && !draft && mentions.length && ta.current?.selectionStart === 0) {
              useAgent.getState().removeMention(mentions[mentions.length - 1].id)
            }
          }}
          onKeyUp={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              addFiles(files)
            }
          }}
        />

        <div className="ag-bar">
          <button className="ag-plus" title="Add images, PDFs or documents" onClick={() => fileInput.current?.click()}><Plus size={15} /></button>
          <button
            className="ag-icon-btn"
            title="Point at a page, section or notebook (@)"
            onClick={() => {
              const el = ta.current!
              const pos = el.selectionStart
              const pre = draft.slice(0, pos)
              const ins = pre && !/\s$/.test(pre) ? ' @' : '@'
              const next = pre + ins + draft.slice(pos)
              setDraft(next)
              requestAnimationFrame(() => {
                el.focus()
                const c = pos + ins.length
                el.setSelectionRange(c, c)
                updateMention(next, c)
              })
            }}
          >
            <AtI size={15} />
          </button>
          <button
            className="ag-icon-btn"
            title="Voice typing (Windows, Win+H)"
            onClick={() => {
              ta.current?.focus()
              setTimeout(() => agentApi.dictate(), 80)
            }}
          >
            <Mic size={15} />
          </button>
          {onVoice && (
            <button className="ag-icon-btn ag-voice-btn" title="Voice mode: talk with the assistant (Ctrl+Shift+Space)" onMouseEnter={warmVoice} onClick={onVoice}>
              <AudioLines size={15} />
            </button>
          )}
          <button
            className={`ag-think-toggle ${prefs.think ? 'on' : ''}`}
            role="switch"
            aria-checked={prefs.think}
            title={prefs.think ? 'Thinking on: better at multi step edits. Click for faster replies.' : 'Thinking off: faster replies. Click to think first.'}
            onClick={() => useAgent.getState().setPrefs({ think: !prefs.think })}
          >
            <span className="track"><i /></span>
            Think
          </button>
          <ModelPicker />
          {selection && selection.key !== dismissed && (
            <span className="ag-sel" title={`${selection.cellTitle ? `In "${selection.cellTitle}": ` : ''}${selection.text.slice(0, 600)}`}>
              <span className="ag-sel-dot" />
              <span className="ag-sel-label">{selection.label}</span>
              <button aria-label="Do not send the selection" title="Don't include this selection" onClick={() => useAgent.getState().dismissSelection()}>
                <X size={11} />
              </button>
            </span>
          )}
          <div className="spacer" />
          {busy && !asking ? (
            <span className="ag-send-group">
              {canSend && (
                <>
                  <button className="ag-send now" title="Send now (Ctrl+Enter): cut the reply short and send this" onClick={() => useAgent.getState().sendNow()}>
                    <Bolt size={14} />
                  </button>
                  <button className="ag-send queue" title="Queue it (Enter): sends when the reply ends" onClick={() => send()}>
                    <QueueI size={15} />
                  </button>
                </>
              )}
              <button className="ag-send stop" title="Stop (Esc)" onClick={() => stop()}><StopI size={14} /></button>
            </span>
          ) : (
            <button className="ag-send" title="Send (Enter)" disabled={!canSend && !asking} onClick={() => send()}><Send size={15} /></button>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
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
})

export default Composer
