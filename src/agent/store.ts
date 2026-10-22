/**
 * State of the agent panel and the agent loop: send a message with a fresh
 * app context, stream the reply, run the tools it asks for, repeat until it
 * answers. Chats are saved through electron/agent.ts (synced via Supabase).
 */
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { agentApi, chatApi, type Chat, type ChatAttachment, type ChatMessage, type ChatSummary } from './api'
import { buildContext } from './context'
import { SYSTEM_PROMPT, voicePrompt } from './prompt'
import { TOOL_DEFS, READ_ONLY, eyesFor, TurnRecorder, keepSnapshot, runTool, undoTurn, scrollToCell } from './tools'
import { storage } from '../lib/storage'
import { useStore, findNode } from '../store'
import type { LiveSelection } from './selection'
import { activePath, messageOrder, PENDING, parentKey, ROOT, tipOf, treeOf } from './branches'
export { messageOrder }

import { DEFAULT_MODEL, MODELS, PROVIDER_LABEL, VISION_MODEL, modelInfo, thinkValue, costOf, type Provider } from './models'
import { readVoicePrefs, recordSpeed } from '../voice/voicePrefs'
export { DEFAULT_MODEL }
const MAX_STEPS = 30
const PREFS_KEY = 'agent-prefs-v1'

export interface Mention {
  id: string
  title: string
  kind: string
}

export interface Prefs {
  open: boolean
  mode: 'pane' | 'overlay'
  width: number
  /** Position and size of the floating panel, in window pixels. */
  float?: { x: number; y: number; w: number; h: number }
  model: string
  think: boolean
  showThinking: boolean
}

const defaultPrefs: Prefs = { open: false, mode: 'pane', width: 400, model: DEFAULT_MODEL, think: true, showThinking: true }

function loadPrefs(): Prefs {
  try {
    const p: Prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }
    // A model that was taken off the list falls back to the default.
    if (!MODELS.some((m) => m.id === p.model)) p.model = DEFAULT_MODEL
    return p
  } catch {
    return defaultPrefs
  }
}

/** A message typed while the agent was working, waiting for its turn. */
export interface Queued {
  id: string
  chatId: string
  text: string
  attachments: ChatAttachment[]
  mentions: Mention[]
  quote: string | null
  /** The selection when it was queued, so it is not lost while waiting. */
  selection: LiveSelection | null
  at: number
}

const QUEUE_KEY = 'agent-queue-v1'

function loadQueue(): Queued[] {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')
    return Array.isArray(q) ? q : []
  } catch {
    return []
  }
}

function saveQueue(q: Queued[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
  } catch {
    /* ignore */
  }
}

interface AgentState {
  /** Messages waiting to be sent, oldest first, for every chat. */
  queue: Queued[]
  /** Chats whose queue is on hold, with the reason shown to the user. */
  queueHold: Record<string, string>
  /** Puts the composer's message in the queue. */
  enqueue(): void
  /** Sends a queued message (or the composer's) right away, cutting the running reply short. */
  sendNow(id?: string): Promise<void>
  unqueue(id: string): void
  editQueued(id: string, text: string): void
  /** Moves a queued message to a new position (index in this chat's queue). */
  moveQueued(id: string, to: number): void
  resumeQueue(): void
  clearQueue(): void

  prefs: Prefs
  setPrefs(p: Partial<Prefs>): void
  toggle(open?: boolean): void

  hasKey: boolean | null
  refreshKey(): Promise<void>

  chats: ChatSummary[]
  chat: Chat | null
  /** Chats with something going on (on screen or not): working, asking you something, or a reply you have not seen. */
  runs: Record<string, RunInfo>
  /** True when the chat has a live session (open, running, or waiting for you). */
  hasSession(id: string): boolean
  syncStatus: { phase: string; error: string | null } | null
  loadChats(): Promise<void>
  openChat(id: string): Promise<void>
  newChat(): void
  deleteChat(id: string): Promise<void>
  renameChat(id: string, title: string): Promise<void>
  /** Folds a copy from disk or the cloud into the open chat without losing anything held only in memory. */
  mergeRemote(c: Chat): void

  busy: boolean
  /** The assistant message being streamed right now. */
  live: ChatMessage | null
  /** What the agent is doing between messages (tool running, thinking...). */
  activity: string
  pendingAsk: { messageId: string; resolve(answer: string): void } | null
  error: string | null
  /** Token counts Ollama reported for the latest request. */
  usage: { prompt: number; output: number; cached: number; ms: number; at: number; model?: string } | null

  draft: string
  attachments: ChatAttachment[]
  mentions: Mention[]
  quote: string | null
  /** Live selection in the notes, and the one the user dismissed with x. */
  selection: LiveSelection | null
  selectionDismissed: string | null
  dismissSelection(): void
  setDraft(t: string): void
  addAttachment(a: ChatAttachment): void
  removeAttachment(sha: string): void
  addMention(m: Mention): void
  removeMention(id: string): void
  setQuote(q: string | null): void
  /** Opens the panel with text (and a quote) ready to send. */
  prefill(text: string, quote?: string | null): void

  send(text?: string): Promise<void>
  answerAsk(answer: string): void
  /** Stops a chat's reply (the open chat by default). */
  stop(chatId?: string): void
  undo(turnId: string): Promise<void>
  retry(): Promise<void>
  /** Sends a changed version of one of your messages as a new branch from the same point. */
  /** Sends a new version of one of your messages; `attachments` replaces its pictures and files when given. */
  editMessage(id: string, text: string, attachments?: ChatAttachment[]): Promise<void>
  /** A new reply to one of your messages, as another version beside the old one. */
  regenerate(userMessageId: string): Promise<void>
  /** Shows another version at a fork (parent key from versionsOf). */
  showVersion(parent: string, id: string): void

  /** Voice mode is on: replies are spoken, with the voice model and the voice prompt. */
  voiceOn: boolean
  setVoiceOn(on: boolean): void
  /** Bumped to ask the panel to start voice mode (the shortcut works from anywhere). */
  voiceRequest: number
  requestVoice(): void
  /** Something said in voice mode: answers a question card, or goes out as a message (cutting a running reply short). Resolves when it is sent. */
  sendVoice(text: string): Promise<void>
}

export interface RunInfo {
  state: 'working' | 'asking' | 'unread' | 'error'
  title: string
  /** What it is doing right now (working) or the question being asked. */
  activity: string
  /** When the run started. */
  since: number
}

/** The model and thinking a reply uses right now: voice mode has its own pick. */
export function activeModel(s: { prefs: Prefs; voiceOn: boolean }): { model: string; think: boolean } {
  if (!s.voiceOn) return { model: s.prefs.model || DEFAULT_MODEL, think: s.prefs.think }
  const v = readVoicePrefs()
  // Voice continues the conversation on the chat's own model; only thinking is set for voice.
  return { model: s.prefs.model || DEFAULT_MODEL, think: v.think }
}

let lastStamp = 0
/** Message times that always increase, so a reply never sorts before the message it answers. */
function stamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}

/** One chat's run: chats work in parallel, each with its own reply, question and error. */
interface Session {
  chat: Chat
  busy: boolean
  live: ChatMessage | null
  activity: string
  pendingAsk: AgentState['pendingAsk']
  error: string | null
  usage: AgentState['usage']
  stopped: boolean
  currentReq: string | null
  /** The run in progress, so "send now" can wait for it to wind down. */
  running: Promise<void> | null
  /** Set while "send now" cuts a reply short, so the queue does not pause for it. */
  jumping: boolean
  /** A reply came in (or failed) while you were in another chat. */
  unread: boolean
  /** When the current run started, for "working 2 min". */
  since: number
  saveTimer: any
  /** What you were typing here when you switched away. */
  composer?: { draft: string; attachments: ChatAttachment[]; mentions: Mention[]; quote: string | null }
}

const sessions = new Map<string, Session>()
/** The chat on screen. */
let openId = ''

/** Fields of the open chat's session that the panel reads from the store. */
const MIRROR = ['chat', 'busy', 'live', 'activity', 'pendingAsk', 'error', 'usage'] as const

function makeSession(chat: Chat): Session {
  const s: Session = { chat, busy: false, live: null, activity: '', pendingAsk: null, error: null, usage: lastUsage(chat), stopped: false, currentReq: null, running: null, jumping: false, unread: false, since: 0, saveTimer: null }
  sessions.set(chat.id, s)
  return s
}

function persist(s: Session) {
  clearTimeout(s.saveTimer)
  s.saveTimer = setTimeout(() => {
    s.saveTimer = null
    chatApi.put(s.chat).catch(() => {})
  }, 400)
}

function flushPersist(s: Session) {
  clearTimeout(s.saveTimer)
  s.saveTimer = null
  return chatApi.put(s.chat).catch(() => s.chat)
}

/** The chat's title, or its first words while it has none yet. */
function chatLabel(c: Chat) {
  if (c.titleAt || c.title !== 'New chat') return c.title
  const first = c.messages.find((m) => m.role === 'user')
  const words = first?.content.replace(/\s+/g, ' ').trim()
  return words ? (words.length > 40 ? `${words.slice(0, 40)}...` : words) : c.title
}

function emptyChat(voice = false): Chat {
  const t = Date.now()
  return { id: nanoid(14), title: 'New chat', titleAt: 0, createdAt: t, updatedAt: t, messages: [], ...(voice ? { voice: true } : {}) }
}

/** Voice timing: when the running turn was sent, and whether its first word was timed yet. */
let turnStart = 0
let turnTimed = true

/* ---------------- building the request ---------------- */

function attachmentText(a: ChatAttachment) {
  const id = `attachment:${a.sha}`
  if (a.kind === 'image') return `[image ${a.name} (${id})]`
  if (a.kind === 'pdf') {
    const pages = a.pages?.length ? ` Page images attached: ${a.pages.map((p, i) => `page ${i + 1} = attachment:${p}`).join(', ')}.` : ''
    return `<attachment name="${a.name}" type="pdf" pages="${a.pageCount || '?'}" id="${id}">${pages}\n${(a.text || '(no text layer)').slice(0, 120_000)}\n</attachment>`
  }
  return `<attachment name="${a.name}" type="${a.kind}" id="${id}">\n${(a.text || '').slice(0, 120_000)}\n</attachment>`
}

function toRequestMessages(chat: Chat, model = DEFAULT_MODEL, voice = false): any[] {
  const canSee = modelInfo(model).vision
  // Only the branch being shown: other versions are not part of this conversation.
  const msgs = activePath(chat)
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user')
  // Images only for the last few messages that carried any, to keep requests light.
  const withImages = new Set(
    msgs.filter((m) => m.role === 'user' && m.attachments?.some((a) => a.kind === 'image' || a.pages?.length)).slice(-4).map((m) => m.id),
  )
  // Pictures tools handed over: only the last few go along, to keep requests light.
  const toolPics = new Set(msgs.filter((m) => m.role === 'tool' && m.meta?.images?.length).slice(-4).map((m) => m.id))
  // Pictures the model already gets with a message, so a tool never sends one twice.
  const sentPics = new Set<string>()
  if (canSee)
    for (const m of msgs)
      if (withImages.has(m.id))
        for (const a of m.attachments || []) {
          if (a.kind === 'image') sentPics.add(`sha:${a.sha}`)
          for (const p of (a.pages || []).slice(0, 20)) sentPics.add(`sha:${p}`)
        }
  const out: any[] = [{ role: 'system', content: voice ? SYSTEM_PROMPT + voicePrompt() : SYSTEM_PROMPT }]
  // They follow the whole run of tool results, since results must come right after their calls.
  let pics: any[] = []
  const flushPics = () => {
    out.push(...pics)
    pics = []
  }
  msgs.forEach((m, i) => {
    if (m.role !== 'tool') flushPics()
    const recent = i > lastUserIdx - 1
    if (m.role === 'user') {
      const parts: string[] = []
      if (i === lastUserIdx && m.meta?.context) parts.push(`<app_context>\n${m.meta.context}\n</app_context>`)
      else if (m.meta?.brief) parts.push(`<app_context_then>${m.meta.brief}</app_context_then>`)
      if (m.meta?.quote) parts.push(`The user quoted this from their notes:\n"""${m.meta.quote}"""`)
      if (m.meta?.selection) {
        const s = m.meta.selection
        const where =
          s.kind === 'text'
            ? `text in cell ${s.cellIds[0] ? `[${s.cellIds[0]}]` : ''}${s.cellTitle ? ` "${s.cellTitle}"` : ''}`
            : `cells ${s.cellIds.map((id) => `[${id}]`).join(', ')}`
        parts.push(`THE USER HAS THIS SELECTED (${where}); "this" most likely means it:\n"""${s.text}"""`)
      }
      if (m.meta?.mentions?.length) parts.push(`Mentioned: ${m.meta.mentions.map((x) => `${x.kind} "${x.title}" [${x.id}]`).join(', ')}`)
      for (const a of m.attachments || []) parts.push(attachmentText(a))
      if (m.meta?.ask?.answer !== undefined) parts.push(m.content)
      else parts.push(m.content || '(no text)')
      const msg: any = { role: 'user', content: parts.join('\n\n') }
      if (withImages.has(m.id)) {
        const imgs: string[] = []
        for (const a of m.attachments || []) {
          if (a.kind === 'image') imgs.push(`sha:${a.sha}`)
          for (const p of (a.pages || []).slice(0, 20)) imgs.push(`sha:${p}`)
        }
        if (imgs.length && canSee) msg.images = imgs
        else if (imgs.length)
          msg.content += `

(${imgs.length} image(s) attached: ${imgs.map((r) => `attachment:${r.slice(4)}`).join(', ')}. You cannot see images yourself, so call view_image on them to read or describe them before answering. Never ask them to switch models for this.)`
      }
      out.push(msg)
    } else if (m.role === 'assistant') {
      // Question cards are interface only; the answer reaches the model as the ask_user result.
      if (m.meta?.ask) return
      const msg: any = { role: 'assistant', content: m.content || '' }
      if (recent && m.thinking) msg.thinking = m.thinking
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments || {} } }))
      out.push(msg)
    } else if (m.role === 'tool') {
      const body = recent ? m.content : m.content.length > 1500 ? `${m.content.slice(0, 1500)}\n...(older result cut)` : m.content
      const imgs = m.meta?.images || []
      // The same picture already went along with a message: say so instead of sending it again.
      if (imgs.length && canSee && imgs.every((r) => sentPics.has(r))) {
        out.push({ role: 'tool', tool_name: m.toolName, content: `${body}\n(It is the same picture already attached above, which you can see: look at it there. Use region to zoom into a part.)` })
      } else if (imgs.length && canSee && toolPics.has(m.id)) {
        out.push({ role: 'tool', tool_name: m.toolName, content: body })
        pics.push({ role: 'user', content: `(The picture${imgs.length > 1 ? 's' : ''} from ${m.toolName}, as real image input:)`, images: imgs })
      } else if (imgs.length) {
        const why = canSee ? 'no longer attached (older)' : 'not visible to you: call view_image to have it read'
        out.push({ role: 'tool', tool_name: m.toolName, content: `${body}\n(The picture is ${why}.)` })
      } else out.push({ role: 'tool', tool_name: m.toolName, content: body })
    }
  })
  flushPics()
  return out
}

/**
 * True when reasoning is going in circles: its latest stretch already appeared
 * twice before, or it ran far past any useful length without an answer.
 */
export function thinkingIsStuck(t: string) {
  if (t.length > 24000) return true
  if (t.length < 3000) return false
  const tail = t.slice(-240).replace(/\s+/g, ' ').trim()
  if (tail.length < 120) return false
  const flat = t.slice(0, -240).replace(/\s+/g, ' ')
  let n = 0
  for (let i = flat.indexOf(tail.slice(0, 120)); i >= 0 && n < 2; i = flat.indexOf(tail.slice(0, 120), i + 1)) n++
  return n >= 2
}

function parseArgs(a: any) {
  if (a && typeof a === 'object') return a
  try {
    return JSON.parse(String(a || '{}'))
  } catch {
    return {}
  }
}

/* ---------------- the store ---------------- */

export const useAgent = create<AgentState>((set, get) => {
  /** Updates a chat's session, and the panel too when that chat is on screen. */
  const setS = (id: string, patch: Partial<Session>) => {
    const s = sessions.get(id)
    if (!s) return
    Object.assign(s, patch)
    if (id === openId) {
      const mirror: Record<string, unknown> = {}
      for (const k of MIRROR) if (k in patch) mirror[k] = patch[k]
      if (Object.keys(mirror).length) set(mirror as any)
    }
    if ('busy' in patch || 'pendingAsk' in patch || 'activity' in patch || 'error' in patch || 'unread' in patch || 'chat' in patch) refreshRun(id)
  }

  /** Keeps the list of chats with something going on up to date. */
  const refreshRun = (id: string) => {
    const s = sessions.get(id)
    const runs = get().runs
    let info: RunInfo | null = null
    if (s) {
      const state: RunInfo['state'] | null = s.pendingAsk ? 'asking' : s.busy ? 'working' : s.unread && s.error ? 'error' : s.unread ? 'unread' : null
      if (state) info = { state, title: chatLabel(s.chat), activity: s.activity, since: s.since }
    }
    const old = runs[id]
    if (!info && !old) return
    if (info && old && old.state === info.state && old.title === info.title && old.activity === info.activity && old.since === info.since) return
    const next = { ...runs }
    if (info) next[id] = info
    else delete next[id]
    set({ runs: next })
  }

  const update = (id: string, fn: (c: Chat) => Chat, save = true) => {
    const s = sessions.get(id)
    if (!s) return
    setS(id, { chat: { ...fn(s.chat), updatedAt: Date.now() } })
    if (save) persist(s)
  }

  /** Adds a message after the last shown one (or after m.parent), and shows it at that fork. */
  const pushMsg = (id: string, m: ChatMessage) =>
    update(id, (c) => {
      const parent = m.parent !== undefined ? m.parent : tipOf(c)
      const key = parent ?? ROOT
      return {
        ...c,
        messages: [...c.messages, { ...m, parent }],
        chosen: { ...(c.chosen || {}), [key]: { id: m.id, at: stamp() } },
      }
    })
  const patchMsg = (id: string, mid: string, patch: Partial<ChatMessage>) =>
    update(id, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === mid ? { ...m, ...patch, v: (m.v || 0) + 1 } : m)) }))

  /** Streams one model reply. Returns it, or null if stopped or failed. */
  async function streamOnce(id: string, noThink = false): Promise<ChatMessage | null> {
    const s = sessions.get(id)!
    const voice = get().voiceOn && id === openId
    const { model, think } = activeModel(get())
    const reqId = nanoid()
    s.currentReq = reqId
    let looping = false
    let checkedAt = 0
    const msg: ChatMessage = { id: nanoid(14), at: stamp(), v: 1, role: 'assistant', content: '', thinking: '', toolCalls: [] }
    setS(id, { live: msg, activity: 'Thinking' })
    let thinkStart = 0
    let usage: { prompt: number; output: number; cached: number; ms: number } | null = null
    let thinkEnd = 0
    let frame = 0
    const flush = () => {
      frame = 0
      setS(id, { live: { ...msg, toolCalls: [...(msg.toolCalls || [])] } })
    }
    const off = agentApi.onChunk((rid, chunk) => {
      if (rid !== reqId) return
      // A key is out of credit: the main process moved the request to the service's next key.
      if (chunk.switched) {
        setS(id, { activity: `Using ${PROVIDER_LABEL[chunk.switched.provider as Provider] || ''} key ${chunk.switched.key}` })
        return
      }
      const m = chunk.message || {}
      if (m.thinking) {
        if (!thinkStart) thinkStart = Date.now()
        msg.thinking += m.thinking
        // Models sometimes get stuck repeating their reasoning: cut it off and answer without thinking.
        if (!looping && !msg.content && msg.thinking!.length - checkedAt > 1500) {
          checkedAt = msg.thinking!.length
          if (thinkingIsStuck(msg.thinking!)) {
            looping = true
            agentApi.abort(reqId)
          }
        }
      }
      if (m.content) {
        if (thinkStart && !thinkEnd) thinkEnd = Date.now()
        msg.content += m.content
        // Voice mode: how long until the first word could be spoken, kept per model.
        if (voice && !turnTimed && /\w/.test(msg.content)) {
          turnTimed = true
          recordSpeed(model, think, Date.now() - turnStart)
        }
      }
      if (m.tool_calls?.length) {
        if (thinkStart && !thinkEnd) thinkEnd = Date.now()
        for (const tc of m.tool_calls) msg.toolCalls!.push({ id: tc.id, name: tc.function?.name, arguments: parseArgs(tc.function?.arguments) })
      }
      if (chunk.done) {
        usage = { prompt: Number(chunk.prompt_eval_count) || 0, output: Number(chunk.eval_count) || 0, cached: Number(chunk.prompt_eval_cached_count) || 0, ms: Math.round((chunk.total_duration || 0) / 1e6) }
      }
      // A chat in the background still streams, but only the one on screen repaints each frame.
      if (!frame) frame = (id === openId ? requestAnimationFrame(flush) : setTimeout(flush, 250)) as any
    })
    const body: any = {
      model,
      messages: toRequestMessages(s.chat, model, voice),
      tools: TOOL_DEFS,
      options: { temperature: 0.4 },
    }
    body.think = noThink ? thinkValue(model, false) : thinkValue(model, think)
    const res = await agentApi.chat(reqId, body)
    off()
    if (frame) {
      cancelAnimationFrame(frame)
      clearTimeout(frame)
    }
    s.currentReq = null
    if (looping && !s.stopped) {
      setS(id, { live: null, activity: 'Reasoning went in circles, answering directly' })
      return streamOnce(id, true)
    }
    if (thinkStart) msg.thinkingMs = (thinkEnd || Date.now()) - thinkStart
    if (!res.ok) {
      setS(id, { live: null })
      if (res.aborted || s.stopped) {
        if (msg.content || msg.thinking) pushMsg(id, { ...msg, meta: { stopped: true } })
        return null
      }
      const err = res.error === 'NO_KEY' ? `Add your ${PROVIDER_LABEL[modelInfo(model).provider]} API key in Settings, AI.` : res.error || 'The model did not answer.'
      setS(id, { error: err })
      if (res.error === 'NO_KEY') set({ hasKey: false })
      return null
    }
    setS(id, { live: null })
    if (!msg.thinking) delete msg.thinking
    if (!msg.toolCalls?.length) delete msg.toolCalls
    const u = usage as { prompt: number; output: number; cached: number; ms: number } | null
    if (res.switched) msg.meta = { ...(msg.meta || {}), switched: res.switched }
    if (u) {
      msg.meta = { ...(msg.meta || {}), usage: { ...u, model } } as any
      setS(id, { usage: { ...u, model, at: Date.now() } })
    }
    pushMsg(id, msg)
    return msg
  }

  async function runLoop(id: string) {
    const s = sessions.get(id)
    if (!s) return
    let finished!: () => void
    s.running = new Promise<void>((r) => (finished = r))
    try {
      await runTurn(id)
    } finally {
      finished()
      s.running = null
      afterRun(id)
    }
  }

  /** When a reply ends: send the chat's next queued message, or hold its queue if the run did not end on its own. */
  function afterRun(chatId: string) {
    const s = sessions.get(chatId)
    if (!s || s.jumping || !get().queue.some((q) => q.chatId === chatId)) return
    const why = s.stopped ? 'Paused because you stopped the reply' : s.error ? 'Paused after an error' : ''
    if (why) set({ queueHold: { ...get().queueHold, [chatId]: why } })
    else setTimeout(() => pump(chatId), 350)
  }

  /** Sends a chat's next queued message, if it is free to go (any chat, on screen or not). */
  function pump(id = openId) {
    const s = sessions.get(id)
    if (!s || s.busy || s.pendingAsk || get().queueHold[id]) return
    const next = get().queue.find((q) => q.chatId === id)
    if (!next) return
    setQueue(get().queue.filter((q) => q.id !== next.id))
    sendItem(next, { queued: { waitedMs: Date.now() - next.at } }, id)
  }

  function setQueue(queue: Queued[]) {
    set({ queue })
    saveQueue(queue)
  }

  /** The live selection, if it still points at cells on the open page and was not dismissed. */
  function currentSelection() {
    const live = get().selection
    const onPage = new Set(useStore.getState().page?.cells.map((c) => c.id) || [])
    return live && live.key !== get().selectionDismissed && live.cellIds.some((id) => onPage.has(id)) ? live : null
  }

  /** Takes what is in the composer, and empties it. */
  function takeComposer(textArg?: string): Omit<Queued, 'id' | 'chatId' | 'at'> | null {
    const text = (textArg ?? get().draft).trim()
    const { attachments, mentions, quote } = get()
    if (!text && !attachments.length) return null
    set({ draft: '', attachments: [], mentions: [], quote: null })
    return { text, attachments, mentions, quote, selection: currentSelection() }
  }

  /** The open chat's session (a new chat when there is none). */
  function openSession(): Session {
    if (!sessions.get(openId)) get().newChat()
    return sessions.get(openId)!
  }

  async function sendItem(item: Omit<Queued, 'id' | 'chatId' | 'at'>, mark: Partial<NonNullable<ChatMessage['meta']>> = {}, chatId?: string) {
    const id = chatId && sessions.has(chatId) ? chatId : openSession().chat.id
    const s = sessions.get(id)!
    // The first spoken message makes the chat a voice chat (a mark in the history).
    if (mark.voice && !s.chat.voice) update(id, (c) => ({ ...c, voice: true }), false)
    const { text, attachments, mentions, quote, selection: sel } = item
    // Pages pointed at with @ are read now, so the agent sees their content.
    const mentionPages: Record<string, any> = {}
    for (const m of mentions) {
      if (m.kind !== 'page') continue
      const st = useStore.getState()
      if (st.page?.id === m.id) mentionPages[m.id] = st.page
      else mentionPages[m.id] = (await storage.readPage(m.id).catch(() => null))?.data || null
    }
    const ctx = buildContext({ mentions, mentionPages, ignoreSelection: true })
    // Later than anything already in the chat, even if it came from a computer whose clock runs ahead.
    for (const m of s.chat.messages) lastStamp = Math.max(lastStamp, m.at || 0)
    const first = !s.chat.messages.length
    const msg: ChatMessage = {
      id: nanoid(14),
      at: stamp(),
      v: 1,
      role: 'user',
      content: text,
      attachments: attachments.length ? attachments : undefined,
      meta: {
        context: ctx.full,
        brief: ctx.brief,
        mentions: mentions.length ? mentions : undefined,
        quote: quote || undefined,
        selection: sel ? { kind: sel.kind, label: sel.label, text: sel.text.slice(0, 12000), cellIds: sel.cellIds, cellTitle: sel.cellTitle } : undefined,
        ...mark,
      },
    }
    pushMsg(id, msg)
    // A new chat shows in the list right away, so you can leave it running and find it again.
    if (first) flushPersist(s).then(() => get().loadChats())
    await runLoop(id)
  }

  async function runTurn(id: string) {
    const s = sessions.get(id)!
    s.stopped = false
    if (id === openId) {
      turnStart = Date.now()
      turnTimed = !get().voiceOn
    }
    const rec = new TurnRecorder()
    const turnId = nanoid(10)
    let firstAssistantId: string | null = null
    let emptyTries = 0
    setS(id, { busy: true, error: null, since: Date.now(), unread: false })
    const attachmentsOf = () => {
      const map = new Map<string, ChatAttachment>()
      for (const m of s.chat.messages) for (const a of m.attachments || []) {
        map.set(a.sha, a)
        for (const p of a.pages || []) map.set(p, { ...a, sha: p, mime: 'image/png', kind: 'image' })
      }
      return map
    }
    try {
      for (let step = 0; step < MAX_STEPS && !s.stopped; step++) {
        // After an empty answer, ask again without thinking: models that reason at length sometimes never get to the reply.
        const reply = await streamOnce(id, emptyTries > 0)
        if (!reply) break
        // Now and then the model ends with nothing at all: ask again.
        if (!reply.content && !reply.toolCalls?.length) {
          update(id, (c) => {
            // Its fork goes back to waiting for a reply, instead of falling back to an older version.
            const chosen = Object.fromEntries(Object.entries(c.chosen || {}).map(([k, v]) => [k, v.id === reply.id ? { id: PENDING, at: v.at } : v]))
            return { ...c, messages: c.messages.filter((m) => m.id !== reply.id), chosen }
          })
          // Tools already ran this turn: the work is done, a closing line is optional.
          if (firstAssistantId) break
          if (emptyTries++ < 2) {
            setS(id, { activity: 'Empty answer, asking again' })
            continue
          }
          setS(id, { error: `${modelInfo(activeModel(get()).model).name} sent back an empty answer three times. Send again, or try another model.` })
          break
        }
        if (!firstAssistantId) firstAssistantId = reply.id
        if (!reply.toolCalls?.length) break
        for (const call of reply.toolCalls) {
          if (s.stopped) break
          setS(id, { activity: labelFor(call.name, activeModel(get()).model) })
          const env = {
            rec,
            attachments: attachmentsOf(),
            model: activeModel(get()).model,
            ask: (q: { question: string; options?: string[]; multi?: boolean }) =>
              new Promise<string>((resolve) => {
                const askMsg: ChatMessage = { id: nanoid(14), at: stamp(), v: 1, role: 'assistant', content: '', meta: { ask: { ...q } } }
                pushMsg(id, askMsg)
                setS(id, { pendingAsk: { messageId: askMsg.id, resolve }, activity: 'Waiting for your answer' })
              }),
          }
          const result = await runTool(call.name, call.arguments || {}, env)
          // Only the chat on screen moves your view; one in the background leaves it alone.
          if (id === openId && !READ_ONLY.has(call.name) && rec.changed && result.ok && result.target?.cellId) {
            const st = useStore.getState()
            if (st.page?.id === result.target.pageId) scrollToCell(result.target.cellId, result.target.anchor)
          }
          pushMsg(id, {
            id: nanoid(14),
            at: stamp(),
            v: 1,
            role: 'tool',
            toolName: call.name,
            content: result.content,
            meta: {
              summary: result.summary,
              ok: result.ok,
              ...(result.target ? { target: result.target } : {}),
              ...(result.helper ? { helper: result.helper } : {}),
              ...(result.images ? { images: result.images, eyes: modelInfo(activeModel(get()).model).name } : {}),
            } as any,
          })
        }
      }
    } catch (e) {
      setS(id, { error: e instanceof Error ? e.message : String(e) })
    } finally {
      if (rec.changed && firstAssistantId) {
        keepSnapshot(turnId, rec.snap)
        patchMsg(id, firstAssistantId, { meta: { ...(s.chat.messages.find((m) => m.id === firstAssistantId)?.meta || {}), turnId } })
      }
      // A fork still waiting (the reply failed or was stopped) shows its newest version again.
      if (Object.values(s.chat.chosen || {}).some((v) => v.id === PENDING))
        update(id, (c) => {
          const kids = treeOf(c.messages).children
          const chosen = Object.fromEntries(
            Object.entries(c.chosen || {}).map(([k, v]) => [k, v.id === PENDING ? { id: kids.get(k)?.slice(-1)[0]?.id || '', at: stamp() } : v]),
          )
          return { ...c, chosen }
        })
      // Finished while you were elsewhere: flag it in the chat list (unless it was deleted).
      const gone = !sessions.has(id)
      setS(id, { busy: false, live: null, activity: '', pendingAsk: null, unread: id !== openId && !s.stopped })
      if (!gone) {
        await flushPersist(s)
        if (!s.chat.titleAt) nameChat(s.chat).catch(() => {})
        get().loadChats()
      }
    }
  }

  async function nameChat(c: Chat) {
    const first = activePath(c).find((m) => m.role === 'user')
    if (!first) return
    const res = await agentApi.complete({
      model: activeModel(get()).model,
      think: false,
      messages: [
        {
          role: 'system',
          content:
            'Name this chat in 2 to 6 words, describing its topic the way a person would label it in a list (examples: "Fix typos in Learning rate", "Gradient descent comparison table", "Photo of lecture notes"). Use the subject matter, not the action type, and never the words Request, Chat, Query, Conversation, Help or Assistance. Reply with the title only, no quotes, no punctuation at the end.',
        },
        {
          role: 'user',
          content: [
            `Message: ${first.content.slice(0, 1200) || first.attachments?.map((a) => a.name).join(', ') || '(attachment)'}`,
            first.meta?.brief ? `Where: ${first.meta.brief.slice(0, 300)}` : '',
            `Outcome: ${[...activePath(c)].reverse().find((m) => m.role === 'assistant' && m.content)?.content.slice(0, 600) || ''}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    })
    const title = (res.content || '').replace(/["*#\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)
    if (!title) return
    if (sessions.has(c.id)) {
      update(c.id, (x) => ({ ...x, title, titleAt: Date.now() }))
    } else {
      const stored = await chatApi.get(c.id)
      if (stored) await chatApi.put({ ...stored, title, titleAt: Date.now() })
    }
    get().loadChats()
  }

  /** Leaving the open chat: keep what was typed, and let an idle chat go (a running one carries on). */
  function leave() {
    const s = sessions.get(openId)
    if (!s) return
    const { draft, attachments, mentions, quote } = get()
    s.composer = draft.trim() || attachments.length || mentions.length || quote ? { draft, attachments, mentions, quote } : undefined
    const waiting = get().queue.some((q) => q.chatId === openId)
    if (!s.busy && !s.pendingAsk && !s.composer && !waiting) {
      if (s.saveTimer) flushPersist(s)
      sessions.delete(openId)
    }
    s.unread = false
    refreshRun(openId)
  }

  /** Shows a session in the panel. */
  function show(s: Session) {
    openId = s.chat.id
    s.unread = false
    const c = s.composer
    s.composer = undefined
    set({
      chat: s.chat,
      busy: s.busy,
      live: s.live,
      activity: s.activity,
      pendingAsk: s.pendingAsk,
      error: s.error,
      usage: s.usage,
      draft: c?.draft || '',
      attachments: c?.attachments || [],
      mentions: c?.mentions || [],
      quote: c?.quote || null,
    })
    refreshRun(openId)
  }

  return {
    prefs: loadPrefs(),
    setPrefs(p) {
      const prefs = { ...get().prefs, ...p }
      set({ prefs })
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      } catch {
        /* ignore */
      }
    },
    toggle(open) {
      get().setPrefs({ open: open ?? !get().prefs.open })
      if (get().prefs.open && !get().chat) get().newChat()
    },

    hasKey: null,
    async refreshKey() {
      // Either service's key lets the assistant run (a model whose service has no key says so when used).
      const [ollama, openrouter] = await Promise.all([agentApi.keyStatus('ollama'), agentApi.keyStatus('openrouter')])
      set({ hasKey: ollama.hasKey || openrouter.hasKey })
    },

    chats: [],
    chat: null,
    runs: {},
    syncStatus: null,
    async loadChats() {
      set({ chats: await chatApi.list() })
    },
    async openChat(id) {
      if (id === openId && sessions.has(id)) return
      let s = sessions.get(id)
      if (!s) {
        const c = await chatApi.get(id)
        if (!c) return
        // It may have started while this was loading.
        s = sessions.get(id) || makeSession(c)
      }
      leave()
      show(s)
      pump(id)
    },
    newChat() {
      leave()
      show(makeSession(emptyChat(get().voiceOn)))
    },
    async deleteChat(id) {
      const s = sessions.get(id)
      if (s?.busy) get().stop(id)
      if (s) clearTimeout(s.saveTimer)
      sessions.delete(id)
      refreshRun(id)
      setQueue(get().queue.filter((q) => q.chatId !== id))
      await chatApi.remove(id)
      if (openId === id) {
        openId = ''
        get().newChat()
      }
      await get().loadChats()
    },
    async renameChat(id, title) {
      if (sessions.has(id)) {
        update(id, (c) => ({ ...c, title, titleAt: Date.now() }), false)
        await flushPersist(sessions.get(id)!)
      } else {
        const c = await chatApi.get(id)
        if (!c) return
        await chatApi.put({ ...c, title, titleAt: Date.now() })
      }
      await get().loadChats()
    },
    hasSession: (id) => sessions.has(id),

    mergeRemote(remote) {
      const s = sessions.get(remote.id)
      if (!s) return
      const cur = s.chat
      const byId = new Map<string, ChatMessage>()
      for (const m of cur.messages) byId.set(m.id, m)
      for (const m of remote.messages || []) {
        const mine = byId.get(m.id)
        if (!mine || (m.v || 0) > (mine.v || 0)) byId.set(m.id, m)
      }
      const messages = [...byId.values()].sort(messageOrder)
      const same = messages.length === cur.messages.length && messages.every((m, i) => m === cur.messages[i])
      const titled = (remote.titleAt || 0) > (cur.titleAt || 0)
      // Branch choices: the most recent choice at each fork wins.
      const chosen = { ...(cur.chosen || {}) }
      let picked = false
      for (const [k, v] of Object.entries(remote.chosen || {})) {
        if (!chosen[k] || (v.at || 0) > (chosen[k].at || 0)) {
          chosen[k] = v
          picked = true
        }
      }
      if (same && !titled && !picked) return
      setS(remote.id, { chat: { ...cur, ...(titled ? { title: remote.title, titleAt: remote.titleAt } : {}), messages, chosen } })
    },

    busy: false,
    live: null,
    activity: '',
    pendingAsk: null,
    error: null,
    usage: null,

    draft: '',
    attachments: [],
    mentions: [],
    quote: null,
    selection: null,
    selectionDismissed: null,
    dismissSelection: () => set({ selectionDismissed: get().selection?.key || null }),
    setDraft: (draft) => set({ draft }),
    addAttachment: (a) => set({ attachments: [...get().attachments.filter((x) => x.sha !== a.sha), a] }),
    removeAttachment: (sha) => set({ attachments: get().attachments.filter((a) => a.sha !== sha) }),
    addMention: (m) => set({ mentions: [...get().mentions.filter((x) => x.id !== m.id), m] }),
    removeMention: (id) => set({ mentions: get().mentions.filter((m) => m.id !== id) }),
    setQuote: (quote) => set({ quote }),
    prefill(text, quote) {
      get().toggle(true)
      set({ draft: text, quote: quote ?? null })
      setTimeout(() => (document.querySelector('.agent-input') as HTMLTextAreaElement | null)?.focus(), 50)
    },

    async editMessage(mid, text, attachments) {
      const s = sessions.get(openId)
      const c = s?.chat
      const old = c?.messages.find((m) => m.id === mid)
      const atts = attachments ?? old?.attachments ?? []
      if (!s || !c || !old || s.busy || (!text.trim() && !atts.length)) return
      const id = openId
      for (const m of c.messages) lastStamp = Math.max(lastStamp, m.at || 0)
      // Same place and selection as before (attachments as edited); the screen context is fresh.
      const ctx = buildContext({ mentions: old.meta?.mentions || [], mentionPages: {}, ignoreSelection: true })
      pushMsg(id, {
        ...old,
        id: nanoid(14),
        at: stamp(),
        v: 1,
        parent: parentKey(c, mid) === ROOT ? null : parentKey(c, mid),
        content: text.trim(),
        attachments: atts.length ? atts : undefined,
        meta: { ...old.meta, context: ctx.full, brief: ctx.brief },
      })
      await runLoop(id)
    },

    async regenerate(userMessageId) {
      const s = sessions.get(openId)
      const c = s?.chat
      if (!s || !c || s.busy || !c.messages.some((m) => m.id === userMessageId)) return
      const id = openId
      for (const m of c.messages) lastStamp = Math.max(lastStamp, m.at || 0)
      // Show the conversation up to that message; the new reply becomes the chosen one when it arrives.
      update(id, (x) => ({ ...x, chosen: { ...(x.chosen || {}), [userMessageId]: { id: PENDING, at: stamp() } } }))
      await runLoop(id)
    },

    showVersion(parent, mid) {
      const s = sessions.get(openId)
      if (!s || s.busy) return
      update(openId, (x) => ({ ...x, chosen: { ...(x.chosen || {}), [parent]: { id: mid, at: stamp() } } }))
    },

    async send(textArg) {
      const text = (textArg ?? get().draft).trim()
      if (get().pendingAsk) {
        if (text) {
          set({ draft: '' })
          get().answerAsk(text)
        }
        return
      }
      // While it works, Enter lines the message up instead.
      if (get().busy) return get().enqueue()
      const item = takeComposer(textArg)
      if (item) await sendItem(item)
    },

    queue: loadQueue(),
    // Messages left from the last session wait until you say go.
    queueHold: Object.fromEntries(loadQueue().map((q) => [q.chatId, 'Left over from last time'])),
    enqueue() {
      const chatId = sessions.has(openId) ? openId : ''
      if (!chatId) return
      const item = takeComposer()
      if (!item) return
      setQueue([...get().queue, { ...item, id: nanoid(10), chatId, at: Date.now() }])
      // Nothing running (it finished as you typed): go now.
      if (!sessions.get(chatId)?.busy) pump(chatId)
    },
    async sendNow(qid) {
      const queued = qid ? get().queue.find((q) => q.id === qid) : null
      if (qid && !queued) return
      const item = queued || takeComposer()
      if (!item) return
      if (queued) setQueue(get().queue.filter((q) => q.id !== qid))
      const s = openSession()
      const chatId = s.chat.id
      const cut = s.busy
      if (cut) {
        s.jumping = true
        get().stop(chatId)
        await s.running
        s.jumping = false
      }
      if (get().queueHold[chatId]) {
        const { [chatId]: _, ...rest } = get().queueHold
        set({ queueHold: rest })
      }
      await sendItem(item, cut ? { sentNow: true } : {}, chatId)
    },
    unqueue(qid) {
      setQueue(get().queue.filter((q) => q.id !== qid))
    },
    editQueued(qid, text) {
      setQueue(get().queue.map((q) => (q.id === qid ? { ...q, text: text.trim() } : q)).filter((q) => q.text || q.attachments.length))
    },
    moveQueued(qid, to) {
      const chatId = openId
      const mine = get().queue.filter((q) => q.chatId === chatId)
      const from = mine.findIndex((q) => q.id === qid)
      if (from < 0) return
      const [it] = mine.splice(from, 1)
      mine.splice(Math.max(0, Math.min(mine.length, to)), 0, it)
      setQueue([...get().queue.filter((q) => q.chatId !== chatId), ...mine])
    },
    resumeQueue() {
      const chatId = openId
      if (!chatId) return
      const { [chatId]: _, ...rest } = get().queueHold
      set({ queueHold: rest })
      pump(chatId)
    },
    clearQueue() {
      const chatId = openId
      setQueue(get().queue.filter((q) => q.chatId !== chatId))
      const { [chatId]: _, ...rest } = get().queueHold
      set({ queueHold: rest })
    },

    answerAsk(answer) {
      const s = sessions.get(openId)
      const p = s?.pendingAsk
      if (!s || !p) return
      const m = s.chat.messages.find((x) => x.id === p.messageId)
      if (m?.meta?.ask) patchMsg(openId, m.id, { meta: { ...m.meta, ask: { ...m.meta.ask, answer } } })
      setS(openId, { pendingAsk: null, activity: 'Working' })
      // Voice timing counts from the answer, not from the question before it.
      turnStart = Date.now()
      p.resolve(answer)
    },

    stop(chatId = openId) {
      const s = sessions.get(chatId)
      if (!s) return
      s.stopped = true
      if (s.currentReq) agentApi.abort(s.currentReq)
      const p = s.pendingAsk
      if (p) {
        setS(chatId, { pendingAsk: null })
        p.resolve('(The user stopped the task instead of answering.)')
      }
    },

    async undo(turnId) {
      const ok = await undoTurn(turnId)
      const s = sessions.get(openId)
      const m = s?.chat.messages.find((x) => x.meta?.turnId === turnId)
      if (m) patchMsg(openId, m.id, { meta: { ...m.meta, undone: true } })
      if (!ok) setS(openId, { error: 'That change can no longer be undone on this computer.' })
    },

    async retry() {
      const s = sessions.get(openId)
      if (!s || s.busy) return
      setS(openId, { error: null })
      await runLoop(openId)
    },

    voiceOn: false,
    setVoiceOn(on) {
      set({ voiceOn: on })
    },
    voiceRequest: 0,
    requestVoice() {
      get().toggle(true)
      set({ voiceRequest: get().voiceRequest + 1 })
    },
    async sendVoice(text) {
      const t = text.trim()
      if (!t) return
      if (get().pendingAsk) {
        get().answerAsk(t)
        return
      }
      const s = openSession()
      const chatId = s.chat.id
      const cut = s.busy
      if (cut) {
        s.jumping = true
        get().stop(chatId)
        await s.running
        s.jumping = false
      }
      if (get().queueHold[chatId]) {
        const { [chatId]: _, ...rest } = get().queueHold
        set({ queueHold: rest })
      }
      setS(chatId, { error: null })
      // Resolves once the message is in the chat, not when the reply is done:
      // the next thing said must never wait behind a whole reply.
      sendItem({ text: t, attachments: [], mentions: [], quote: null, selection: currentSelection() }, { voice: true, ...(cut ? { sentNow: true } : {}) }, chatId).catch((e) =>
        setS(chatId, { error: e instanceof Error ? e.message : String(e) }),
      )
    },
  }
})

function labelFor(name: string, chatModel: string) {
  // These hand a picture to the vision model, so say which model is looking.
  const eyes = modelInfo(eyesFor(chatModel)).name
  if (eyes && name === 'view_image') return `${eyes} is reading the image`
  if (eyes && name === 'check_drawing') return `${eyes} is looking at the drawing`
  const map: Record<string, string> = {
    get_context: 'Looking at your screen',
    list_tree: 'Reading your notebooks',
    read_page: 'Reading the page',
    read_cell: 'Reading a cell',
    search_notes: 'Searching your notes',
    recent_notes: 'Looking at recent notes',
    view_image: 'Reading the image',
    check_drawing: 'Looking at the drawing',
    create_cells: 'Adding cells',
    update_cell: 'Updating a cell',
    edit_cell_text: 'Editing text',
    format_text: 'Styling text',
    delete_cells: 'Deleting cells',
    arrange_cells: 'Arranging cells',
    duplicate_cells: 'Copying cells',
    insert_image: 'Adding the image',
    focus: 'Showing you',
    page_edit: 'Editing the page',
    create_node: 'Creating',
    update_node: 'Updating',
    delete_node: 'Deleting',
    get_settings: 'Reading settings',
    update_settings: 'Changing settings',
    ask_user: 'Asking you',
    web_search: 'Searching the web',
    web_fetch: 'Reading a web page',
  }
  return map[name] || 'Working'
}

/** Jumps to what a tool changed. */
export async function goToTarget(t?: { pageId?: string; cellId?: string; anchor?: string }) {
  if (!t?.pageId) return
  const st = useStore.getState()
  if (!findNode(st.workspace.tree, t.pageId)) return
  if (st.activePageId !== t.pageId) await st.openPage(t.pageId)
  if (t.cellId) {
    useStore.getState().setSelection([t.cellId])
    scrollToCell(t.cellId, t.anchor)
  }
}

function lastUsage(c: Chat) {
  const m = [...activePath(c)].reverse().find((x) => (x.meta as any)?.usage)
  return m ? { ...(m.meta as any).usage, at: m.at } : null
}

/* ---------------- what fills the context window ---------------- */

export interface ContextPart {
  key: string
  label: string
  tokens: number
  detail?: string
}

/** Rough tokens for text: about 3.6 characters per token for English and code. */
export const estimateTokens = (text: string) => Math.ceil((text || '').length / 3.6)
const IMAGE_TOKENS = 560

/**
 * What the next request would hold, split by kind. Estimates are scaled so
 * they add up to the exact count Ollama reported for the last request.
 */
export function contextBreakdown(chat: Chat | null, liveContext?: string, model = DEFAULT_MODEL): { parts: ContextPart[]; total: number; exact: boolean } {
  const tools = JSON.stringify(TOOL_DEFS)
  const msgs = chat ? toRequestMessages(chat, model) : [{ role: 'system', content: SYSTEM_PROMPT }]
  let ctx = 0
  let history = 0
  let atts = 0
  let images = 0
  let toolResults = 0
  let thinking = 0
  for (const m of msgs.slice(1)) {
    const content = String(m.content || '')
    const ctxMatch = /<app_context>[\s\S]*?<\/app_context>/.exec(content)
    const attText = (content.match(/<attachment[\s\S]*?<\/attachment>/g) || []).join('')
    const ctxText = ctxMatch ? ctxMatch[0] : ''
    ctx += estimateTokens(ctxText)
    atts += estimateTokens(attText)
    if (m.role === 'tool') toolResults += estimateTokens(content)
    else history += estimateTokens(content) - estimateTokens(ctxText) - estimateTokens(attText)
    if (m.tool_calls) history += estimateTokens(JSON.stringify(m.tool_calls))
    if (m.thinking) thinking += estimateTokens(m.thinking)
    images += (m.images?.length || 0) * IMAGE_TOKENS
  }
  if (!chat?.messages.length && liveContext) ctx = estimateTokens(liveContext)
  const parts: ContextPart[] = [
    { key: 'system', label: 'System prompt', tokens: estimateTokens(SYSTEM_PROMPT), detail: 'How the assistant behaves' },
    { key: 'tools', label: 'Tool definitions', tokens: estimateTokens(tools), detail: `${TOOL_DEFS.length} tools` },
    { key: 'context', label: 'Screen and page context', tokens: ctx, detail: 'Fresh with every message' },
    { key: 'history', label: 'Conversation', tokens: Math.max(0, history), detail: 'Your messages and replies' },
    { key: 'tools-out', label: 'Tool results', tokens: toolResults, detail: 'What the tools returned' },
    { key: 'thinking', label: 'Reasoning (this turn)', tokens: thinking },
    { key: 'files', label: 'Documents', tokens: atts, detail: 'PDF, Word and text attachments' },
    { key: 'images', label: 'Images', tokens: images, detail: 'About 560 tokens each' },
  ].filter((p) => p.tokens > 0)
  const est = parts.reduce((a, p) => a + p.tokens, 0)
  const last = chat ? lastUsage(chat) : null
  // Scale to the real count when this chat has one and nothing new was added since.
  const tail = activePath(chat).slice(-1)[0]
  if (last && last.prompt && (tail?.meta as any)?.usage) {
    const f = last.prompt / Math.max(1, est)
    for (const p of parts) p.tokens = Math.round(p.tokens * f)
    return { parts, total: last.prompt, exact: true }
  }
  return { parts, total: est, exact: false }
}

/** What this chat has cost so far, from the token counts of every reply. */
export function chatCost(chat: Chat | null): { total: number; priced: boolean } {
  let total = 0
  let priced = true
  for (const m of chat?.messages || []) {
    const u = (m.meta as any)?.usage
    if (!u) continue
    const c = costOf(u.model || DEFAULT_MODEL, u)
    if (c === null) priced = false
    else total += c
  }
  return { total, priced }
}
