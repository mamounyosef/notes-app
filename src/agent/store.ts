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

import { DEFAULT_MODEL, MODELS, VISION_MODEL, modelInfo, thinkValue, costOf } from './models'
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
  stop(): void
  undo(turnId: string): Promise<void>
  retry(): Promise<void>
  /** Sends a changed version of one of your messages as a new branch from the same point. */
  editMessage(id: string, text: string): Promise<void>
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

/** The model and thinking a reply uses right now: voice mode has its own pick. */
export function activeModel(s: { prefs: Prefs; voiceOn: boolean }): { model: string; think: boolean } {
  if (!s.voiceOn) return { model: s.prefs.model || DEFAULT_MODEL, think: s.prefs.think }
  const v = readVoicePrefs()
  return { model: v.model || s.prefs.model || DEFAULT_MODEL, think: v.think }
}

let lastStamp = 0
/** Message times that always increase, so a reply never sorts before the message it answers. */
function stamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}

let currentReq: string | null = null
let stopped = false
/** The agent run in progress, so "send now" can wait for it to wind down. */
let running: Promise<void> | null = null
/** Set while "send now" cuts a reply short, so the queue does not pause for it. */
let jumping = false
let saveTimer: any = null

function persist(chat: Chat) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    chatApi.put(chat).catch(() => {})
  }, 400)
}

function flushPersist(chat: Chat) {
  clearTimeout(saveTimer)
  return chatApi.put(chat).catch(() => chat)
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
  const update = (fn: (c: Chat) => Chat, save = true) => {
    const c = get().chat
    if (!c) return
    const next = { ...fn(c), updatedAt: Date.now() }
    set({ chat: next })
    if (save) persist(next)
  }

  /** Adds a message after the last shown one (or after m.parent), and shows it at that fork. */
  const pushMsg = (m: ChatMessage) =>
    update((c) => {
      const parent = m.parent !== undefined ? m.parent : tipOf(c)
      const key = parent ?? ROOT
      return {
        ...c,
        messages: [...c.messages, { ...m, parent }],
        chosen: { ...(c.chosen || {}), [key]: { id: m.id, at: stamp() } },
      }
    })
  const patchMsg = (id: string, patch: Partial<ChatMessage>) =>
    update((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch, v: (m.v || 0) + 1 } : m)) }))

  /** Streams one model reply. Returns it, or null if stopped or failed. */
  async function streamOnce(chat: Chat, noThink = false): Promise<ChatMessage | null> {
    const voice = get().voiceOn
    const { model, think } = activeModel(get())
    const reqId = nanoid()
    currentReq = reqId
    let looping = false
    let checkedAt = 0
    const msg: ChatMessage = { id: nanoid(14), at: stamp(), v: 1, role: 'assistant', content: '', thinking: '', toolCalls: [] }
    set({ live: msg, activity: 'Thinking' })
    let thinkStart = 0
    let usage: { prompt: number; output: number; cached: number; ms: number } | null = null
    let thinkEnd = 0
    let frame = 0
    const flush = () => {
      frame = 0
      set({ live: { ...msg, toolCalls: [...(msg.toolCalls || [])] } })
    }
    const off = agentApi.onChunk((id, chunk) => {
      if (id !== reqId) return
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
      if (!frame) frame = requestAnimationFrame(flush) as any
    })
    const body: any = {
      model,
      messages: toRequestMessages(chat, model, voice),
      tools: TOOL_DEFS,
      options: { temperature: 0.4 },
    }
    body.think = noThink ? thinkValue(model, false) : thinkValue(model, think)
    const res = await agentApi.chat(reqId, body)
    off()
    if (frame) cancelAnimationFrame(frame)
    currentReq = null
    if (looping && !stopped) {
      set({ live: null, activity: 'Reasoning went in circles, answering directly' })
      return streamOnce(chat, true)
    }
    if (thinkStart) msg.thinkingMs = (thinkEnd || Date.now()) - thinkStart
    if (!res.ok) {
      set({ live: null })
      if (res.aborted || stopped) {
        if (msg.content || msg.thinking) pushMsg({ ...msg, meta: { stopped: true } })
        return null
      }
      const err = res.error === 'NO_KEY' ? 'Add your Ollama API key in Settings, AI.' : res.error || 'The model did not answer.'
      set({ error: err })
      if (res.error === 'NO_KEY') set({ hasKey: false })
      return null
    }
    set({ live: null })
    if (!msg.thinking) delete msg.thinking
    if (!msg.toolCalls?.length) delete msg.toolCalls
    const u = usage as { prompt: number; output: number; cached: number; ms: number } | null
    if (u) {
      msg.meta = { ...(msg.meta || {}), usage: { ...u, model } } as any
      set({ usage: { ...u, model, at: Date.now() } })
    }
    pushMsg(msg)
    return msg
  }

  async function runLoop() {
    let finished!: () => void
    running = new Promise<void>((r) => (finished = r))
    const runChat = get().chat?.id || ''
    try {
      await runTurn()
    } finally {
      finished()
      running = null
      afterRun(runChat)
    }
  }

  /** When a reply ends: send the next queued message, or hold the queue if the run did not end on its own. */
  function afterRun(chatId: string) {
    if (jumping || !chatId || !get().queue.some((q) => q.chatId === chatId)) return
    const why =
      get().chat?.id !== chatId ? 'Paused while you were in another chat'
      : stopped ? 'Paused because you stopped the reply'
      : get().error ? 'Paused after an error'
      : ''
    if (why) set({ queueHold: { ...get().queueHold, [chatId]: why } })
    else setTimeout(pump, 350)
  }

  /** Sends the next queued message of the open chat, if it is free to go. */
  function pump() {
    const s = get()
    const id = s.chat?.id
    if (!id || s.busy || s.pendingAsk || s.queueHold[id]) return
    const next = s.queue.find((q) => q.chatId === id)
    if (!next) return
    setQueue(s.queue.filter((q) => q.id !== next.id))
    sendItem(next, { queued: { waitedMs: Date.now() - next.at } })
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

  async function sendItem(item: Omit<Queued, 'id' | 'chatId' | 'at'>, mark: Partial<NonNullable<ChatMessage['meta']>> = {}) {
    if (!get().chat) get().newChat()
    // The first spoken message makes the chat a voice chat (a mark in the history).
    if (mark.voice && !get().chat?.voice) update((c) => ({ ...c, voice: true }), false)
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
    for (const m of get().chat?.messages || []) lastStamp = Math.max(lastStamp, m.at || 0)
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
    pushMsg(msg)
    await runLoop()
  }

  async function runTurn() {
    stopped = false
    turnStart = Date.now()
    turnTimed = !get().voiceOn
    const rec = new TurnRecorder()
    const turnId = nanoid(10)
    let firstAssistantId: string | null = null
    let emptyTries = 0
    set({ busy: true, error: null })
    const attachmentsOf = () => {
      const map = new Map<string, ChatAttachment>()
      for (const m of get().chat?.messages || []) for (const a of m.attachments || []) {
        map.set(a.sha, a)
        for (const p of a.pages || []) map.set(p, { ...a, sha: p, mime: 'image/png', kind: 'image' })
      }
      return map
    }
    try {
      for (let step = 0; step < MAX_STEPS && !stopped; step++) {
        const chat = get().chat
        if (!chat) break
        // After an empty answer, ask again without thinking: models that reason at length sometimes never get to the reply.
        const reply = await streamOnce(chat, emptyTries > 0)
        if (!reply) break
        // Now and then the model ends with nothing at all: ask again.
        if (!reply.content && !reply.toolCalls?.length) {
          update((c) => {
            // Its fork goes back to waiting for a reply, instead of falling back to an older version.
            const chosen = Object.fromEntries(Object.entries(c.chosen || {}).map(([k, v]) => [k, v.id === reply.id ? { id: PENDING, at: v.at } : v]))
            return { ...c, messages: c.messages.filter((m) => m.id !== reply.id), chosen }
          })
          // Tools already ran this turn: the work is done, a closing line is optional.
          if (firstAssistantId) break
          if (emptyTries++ < 2) {
            set({ activity: 'Empty answer, asking again' })
            continue
          }
          set({ error: `${modelInfo(activeModel(get()).model).name} sent back an empty answer three times. Send again, or try another model.` })
          break
        }
        if (!firstAssistantId) firstAssistantId = reply.id
        if (!reply.toolCalls?.length) break
        for (const call of reply.toolCalls) {
          if (stopped) break
          set({ activity: labelFor(call.name, activeModel(get()).model) })
          const env = {
            rec,
            attachments: attachmentsOf(),
            model: activeModel(get()).model,
            ask: (q: { question: string; options?: string[]; multi?: boolean }) =>
              new Promise<string>((resolve) => {
                const askMsg: ChatMessage = { id: nanoid(14), at: stamp(), v: 1, role: 'assistant', content: '', meta: { ask: { ...q } } }
                pushMsg(askMsg)
                set({ pendingAsk: { messageId: askMsg.id, resolve }, activity: 'Waiting for your answer' })
              }),
          }
          const result = await runTool(call.name, call.arguments || {}, env)
          if (!READ_ONLY.has(call.name) && rec.changed && result.ok && result.target?.cellId) {
            const st = useStore.getState()
            if (st.page?.id === result.target.pageId) scrollToCell(result.target.cellId, result.target.anchor)
          }
          pushMsg({
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
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      if (rec.changed && firstAssistantId) {
        keepSnapshot(turnId, rec.snap)
        patchMsg(firstAssistantId, { meta: { ...(get().chat?.messages.find((m) => m.id === firstAssistantId)?.meta || {}), turnId } })
      }
      // A fork still waiting (the reply failed or was stopped) shows its newest version again.
      if (Object.values(get().chat?.chosen || {}).some((v) => v.id === PENDING))
        update((c) => {
          const kids = treeOf(c.messages).children
          const chosen = Object.fromEntries(
            Object.entries(c.chosen || {}).map(([k, v]) => [k, v.id === PENDING ? { id: kids.get(k)?.slice(-1)[0]?.id || '', at: stamp() } : v]),
          )
          return { ...c, chosen }
        })
      set({ busy: false, live: null, activity: '', pendingAsk: null })
      const c = get().chat
      if (c) {
        await flushPersist(c)
        if (!c.titleAt) nameChat(c).catch(() => {})
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
    const cur = get().chat
    if (cur && cur.id === c.id) {
      update((x) => ({ ...x, title, titleAt: Date.now() }))
    } else {
      const stored = await chatApi.get(c.id)
      if (stored) await chatApi.put({ ...stored, title, titleAt: Date.now() })
    }
    get().loadChats()
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
      const s = await agentApi.keyStatus()
      set({ hasKey: s.hasKey })
    },

    chats: [],
    chat: null,
    syncStatus: null,
    async loadChats() {
      set({ chats: await chatApi.list() })
    },
    async openChat(id) {
      if (get().busy) get().stop()
      const c = await chatApi.get(id)
      if (c) set({ chat: c, error: null, draft: '', attachments: [], mentions: [], quote: null, usage: lastUsage(c) })
      // Wait for the run being stopped to wind down before the queue may move.
      await running
      pump()
    },
    newChat() {
      if (get().busy) get().stop()
      set({ chat: emptyChat(get().voiceOn), error: null, live: null, attachments: [], mentions: [], quote: null, usage: null })
    },
    async deleteChat(id) {
      await chatApi.remove(id)
      if (get().chat?.id === id) get().newChat()
      await get().loadChats()
    },
    async renameChat(id, title) {
      const c = get().chat?.id === id ? get().chat : await chatApi.get(id)
      if (!c) return
      const next = { ...c, title, titleAt: Date.now() }
      if (get().chat?.id === id) set({ chat: next })
      await chatApi.put(next)
      await get().loadChats()
    },

    mergeRemote(remote) {
      const cur = get().chat
      if (!cur || cur.id !== remote.id) return
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
      set({ chat: { ...cur, ...(titled ? { title: remote.title, titleAt: remote.titleAt } : {}), messages, chosen } })
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

    async editMessage(id, text) {
      const c = get().chat
      const old = c?.messages.find((m) => m.id === id)
      if (!c || !old || get().busy || !text.trim()) return
      for (const m of c.messages) lastStamp = Math.max(lastStamp, m.at || 0)
      // Same place, attachments and selection as before; the screen context is fresh.
      const ctx = buildContext({ mentions: old.meta?.mentions || [], mentionPages: {}, ignoreSelection: true })
      pushMsg({
        ...old,
        id: nanoid(14),
        at: stamp(),
        v: 1,
        parent: parentKey(c, id) === ROOT ? null : parentKey(c, id),
        content: text.trim(),
        meta: { ...old.meta, context: ctx.full, brief: ctx.brief },
      })
      await runLoop()
    },

    async regenerate(userMessageId) {
      const c = get().chat
      if (!c || get().busy || !c.messages.some((m) => m.id === userMessageId)) return
      for (const m of c.messages) lastStamp = Math.max(lastStamp, m.at || 0)
      // Show the conversation up to that message; the new reply becomes the chosen one when it arrives.
      update((x) => ({ ...x, chosen: { ...(x.chosen || {}), [userMessageId]: { id: PENDING, at: stamp() } } }))
      await runLoop()
    },

    showVersion(parent, id) {
      if (get().busy) return
      update((x) => ({ ...x, chosen: { ...(x.chosen || {}), [parent]: { id, at: stamp() } } }))
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
      const chatId = get().chat?.id
      if (!chatId) return
      const item = takeComposer()
      if (!item) return
      setQueue([...get().queue, { ...item, id: nanoid(10), chatId, at: Date.now() }])
      // Nothing running (it finished as you typed): go now.
      if (!get().busy) pump()
    },
    async sendNow(id) {
      const s = get()
      const queued = id ? s.queue.find((q) => q.id === id) : null
      if (id && !queued) return
      const item = queued || takeComposer()
      if (!item) return
      if (queued) setQueue(get().queue.filter((q) => q.id !== id))
      const chatId = s.chat?.id
      const cut = s.busy
      if (cut) {
        jumping = true
        get().stop()
        await running
        jumping = false
      }
      if (chatId && get().queueHold[chatId]) {
        const { [chatId]: _, ...rest } = get().queueHold
        set({ queueHold: rest })
      }
      await sendItem(item, cut ? { sentNow: true } : {})
    },
    unqueue(id) {
      setQueue(get().queue.filter((q) => q.id !== id))
    },
    editQueued(id, text) {
      setQueue(get().queue.map((q) => (q.id === id ? { ...q, text: text.trim() } : q)).filter((q) => q.text || q.attachments.length))
    },
    moveQueued(id, to) {
      const chatId = get().chat?.id
      const mine = get().queue.filter((q) => q.chatId === chatId)
      const from = mine.findIndex((q) => q.id === id)
      if (from < 0) return
      const [it] = mine.splice(from, 1)
      mine.splice(Math.max(0, Math.min(mine.length, to)), 0, it)
      setQueue([...get().queue.filter((q) => q.chatId !== chatId), ...mine])
    },
    resumeQueue() {
      const chatId = get().chat?.id
      if (!chatId) return
      const { [chatId]: _, ...rest } = get().queueHold
      set({ queueHold: rest })
      pump()
    },
    clearQueue() {
      const chatId = get().chat?.id
      setQueue(get().queue.filter((q) => q.chatId !== chatId))
      const { [chatId || '']: _, ...rest } = get().queueHold
      set({ queueHold: rest })
    },

    answerAsk(answer) {
      const p = get().pendingAsk
      if (!p) return
      const m = get().chat?.messages.find((x) => x.id === p.messageId)
      if (m?.meta?.ask) patchMsg(m.id, { meta: { ...m.meta, ask: { ...m.meta.ask, answer } } })
      set({ pendingAsk: null, activity: 'Working' })
      // Voice timing counts from the answer, not from the question before it.
      turnStart = Date.now()
      p.resolve(answer)
    },

    stop() {
      stopped = true
      if (currentReq) agentApi.abort(currentReq)
      const p = get().pendingAsk
      if (p) {
        set({ pendingAsk: null })
        p.resolve('(The user stopped the task instead of answering.)')
      }
    },

    async undo(turnId) {
      const ok = await undoTurn(turnId)
      const c = get().chat
      const m = c?.messages.find((x) => x.meta?.turnId === turnId)
      if (m) patchMsg(m.id, { meta: { ...m.meta, undone: true } })
      if (!ok) set({ error: 'That change can no longer be undone on this computer.' })
    },

    async retry() {
      const c = get().chat
      if (!c || get().busy) return
      set({ error: null })
      // Drop a trailing partial reply, then run again from the last message.
      await runLoop()
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
      const cut = get().busy
      if (cut) {
        jumping = true
        get().stop()
        await running
        jumping = false
      }
      const chatId = get().chat?.id
      if (chatId && get().queueHold[chatId]) {
        const { [chatId]: _, ...rest } = get().queueHold
        set({ queueHold: rest })
      }
      set({ error: null })
      // Resolves once the message is in the chat, not when the reply is done:
      // the next thing said must never wait behind a whole reply.
      sendItem({ text: t, attachments: [], mentions: [], quote: null, selection: currentSelection() }, { voice: true, ...(cut ? { sentNow: true } : {}) }).catch((e) =>
        set({ error: e instanceof Error ? e.message : String(e) }),
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
