/** The desktop bridge for the agent (see electron/agent.ts). */
import { modelInfo, type Provider } from './models'

export interface ChatAttachment {
  sha: string
  mime: string
  name: string
  size: number
  kind: 'image' | 'pdf' | 'text' | 'doc'
  /** Extracted text for PDFs, documents and text files. */
  text?: string
  /** For PDFs without much text: images of its pages, for the model to read. */
  pages?: string[]
  /** Page count for PDFs. */
  pageCount?: number
  /** For images changed in the editor: how, and the untouched original. */
  edit?: ImageEdit
}

export interface ImageEdit {
  orig: { sha: string; mime: string; size: number }
  /** Quarter turns clockwise, applied after the mirrors. */
  rot: number
  flipH: boolean
  flipV: boolean
  /** Part kept, as fractions of the turned picture. */
  crop: { x: number; y: number; w: number; h: number }
  /** Percent; 100 is unchanged. */
  bright: number
  contrast: number
  gray: boolean
}

export interface ToolCall {
  id?: string
  name: string
  arguments: any
}

export interface ChatMessage {
  id: string
  at: number
  /** Bumped on every edit of this message, so merges keep the latest. */
  v?: number
  /**
   * The message this one follows (null: the first). Edits and regenerations
   * add siblings, so a chat is a tree. Missing on chats from before branching:
   * then it follows the message before it.
   */
  parent?: string | null
  role: 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  thinkingMs?: number
  toolCalls?: ToolCall[]
  toolName?: string
  attachments?: ChatAttachment[]
  meta?: {
    /** The app context sent with a user message. */
    context?: string
    /** Short form of it for older turns. */
    brief?: string
    /** Pages the user mentioned with @. */
    mentions?: { id: string; title: string; kind: string }[]
    /** Quoted selection sent with "Ask the agent". */
    quote?: string
    /** What the user had selected when sending (unless they dismissed it). */
    selection?: { kind: 'text' | 'cells'; label: string; text: string; cellIds: string[]; cellTitle?: string }
    /** A question the agent asked (ask_user) and the answer. */
    ask?: { question: string; options?: string[]; multi?: boolean; answer?: string }
    /** One line per tool call result, for the chips in the chat. */
    summary?: string
    ok?: boolean
    /** Set on the first assistant message of a turn that changed notes. */
    turnId?: string
    undone?: boolean
    error?: string
    stopped?: boolean
    /** Sent from the queue (waited ms), or sent now over a running reply. */
    queued?: { waitedMs: number }
    /** Pictures a tool handed to a model that can see ("sha:<hash>"). */
    images?: string[]
    sentNow?: boolean
    /** The reply came through a later key because the ones before it were out of credit. */
    switched?: KeySwitch
    /** Said out loud in voice mode, not typed. */
    voice?: boolean
    device?: string
  }
}

export interface Chat {
  id: string
  title: string
  titleAt: number
  createdAt: number
  updatedAt: number
  deleted?: boolean
  /** Every message of every branch. The shown conversation is activePath(chat). */
  messages: ChatMessage[]
  /**
   * Which branch is shown after each fork: parent id ("root" for the first
   * message) to the chosen child. "pending" waits for a reply being made.
   */
  chosen?: Record<string, { id: string; at: number }>
  /** A spoken conversation (voice mode). */
  voice?: boolean
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  count: number
  preview: string
  voice?: boolean
}

const desk = (window as any).notes

/** Tells the main process which service runs the request's model. */
const withProvider = (body: any) => ({ ...body, provider: modelInfo(body?.model).provider })

/** Set when a request ran on a later key of its service because the ones before it were out of credit. */
export interface KeySwitch {
  provider: Provider
  /** The key that answered, counting from 1. */
  key: number
  keys: number
  reason: string
}

/** One saved key, as Settings shows it. */
export interface KeyInfo {
  masked: string
  /** Out of credit: skipped until this time (ms). */
  outUntil: number | null
  detail: string
}

export const agentAvailable = Boolean(desk?.agent)

export const agentApi = {
  keyStatus: (provider: Provider = 'ollama'): Promise<{ hasKey: boolean; masked: string; keys?: KeyInfo[] }> =>
    desk?.agent ? desk.agent.keyStatus(provider) : Promise.resolve({ hasKey: false, masked: '', keys: [] }),
  /** Replaces the first key; an empty key removes all of the service's keys. */
  setKey: (key: string, provider: Provider = 'ollama'): Promise<{ ok: boolean; error?: string }> =>
    desk?.agent ? desk.agent.setKey(key, provider) : Promise.resolve({ ok: false, error: 'Desktop app only' }),
  /** Adds a key after the others, used when the ones before it run out of credit. */
  addKey: (key: string, provider: Provider): Promise<{ ok: boolean; error?: string }> =>
    desk?.agent?.addKey ? desk.agent.addKey(key, provider) : Promise.resolve({ ok: false, error: 'Desktop app only' }),
  removeKey: (provider: Provider, index: number): Promise<{ ok: boolean; error?: string }> =>
    desk?.agent?.removeKey ? desk.agent.removeKey(provider, index) : Promise.resolve({ ok: false }),
  /** Moves a key one place earlier in the order they are tried. */
  raiseKey: (provider: Provider, index: number): Promise<{ ok: boolean }> =>
    desk?.agent?.raiseKey ? desk.agent.raiseKey(provider, index) : Promise.resolve({ ok: false }),
  /** Free model requests used and allowed today on one OpenRouter key (the first by default). */
  openrouterLimits: (index = 0): Promise<{ ok: boolean; freeUsed?: number | null; freeLimit?: number | null; freeTier?: boolean }> =>
    desk?.agent?.openrouterLimits ? desk.agent.openrouterLimits(index) : Promise.resolve({ ok: false }),
  /** Streams a reply. `switched` is set when a later key answered because earlier ones were out of credit. */
  chat: (reqId: string, body: unknown): Promise<{ ok: boolean; error?: string; aborted?: boolean; switched?: KeySwitch }> =>
    desk?.agent ? desk.agent.chat(reqId, withProvider(body)) : Promise.resolve({ ok: false, error: 'The agent needs the desktop app.' }),
  abort: (reqId: string) => desk?.agent?.abort(reqId),
  /** One reply without streaming. Messages may carry images ("sha:<hash>" or base64); timeout_ms defaults to 30 s. */
  complete: (body: unknown): Promise<{ ok: boolean; content?: string; error?: string; switched?: KeySwitch }> =>
    desk?.agent ? desk.agent.complete(withProvider(body)) : Promise.resolve({ ok: false }),
  /** Draws an HTML block off screen: a PNG (base64) of it, its size and the errors it reported. */
  renderWidget: (body: { html: string; width?: number }): Promise<{ ok: boolean; png?: string; width?: number; height?: number; errors?: string[]; done?: boolean; error?: string }> =>
    desk?.agent?.renderWidget ? desk.agent.renderWidget(body) : Promise.resolve({ ok: false, error: 'Checking a drawing needs the desktop app.' }),
  onChunk: (cb: (reqId: string, chunk: any) => void): (() => void) => (desk?.agent ? desk.agent.onChunk(cb) : () => {}),
  web: (kind: 'search' | 'fetch', arg: unknown): Promise<{ ok: boolean; data?: any; error?: string }> =>
    desk?.agent?.web ? desk.agent.web(kind, arg) : Promise.resolve({ ok: false, error: 'Desktop app only' }),
  dictate: (): Promise<boolean> => (desk?.agent?.dictate ? desk.agent.dictate() : Promise.resolve(false)),
}

export const chatApi = {
  list: (): Promise<ChatSummary[]> => (desk?.chats ? desk.chats.list() : Promise.resolve([])),
  get: (id: string): Promise<Chat | null> => (desk?.chats ? desk.chats.get(id) : Promise.resolve(null)),
  put: (chat: Chat): Promise<Chat> => (desk?.chats ? desk.chats.put(chat) : Promise.resolve(chat)),
  remove: (id: string): Promise<void> => (desk?.chats ? desk.chats.remove(id) : Promise.resolve()),
  status: (): Promise<{ phase: string; error: string | null; lastSync: number }> =>
    desk?.chats ? desk.chats.status() : Promise.resolve({ phase: 'off', error: null, lastSync: 0 }),
  syncNow: () => desk?.chats?.syncNow(),
  saveBlob: (b64: string): Promise<string> => desk.chats.saveBlob(b64),
  getBlob: (sha: string): Promise<string | null> => (desk?.chats ? desk.chats.getBlob(sha) : Promise.resolve(null)),
  blobToAsset: (sha: string, mime: string): Promise<string | null> =>
    desk?.chats ? desk.chats.blobToAsset(sha, mime) : Promise.resolve(null),
  onEvent: (cb: (ev: any) => void): (() => void) => (desk?.chats ? desk.chats.onEvent(cb) : () => {}),
  onStatus: (cb: (s: any) => void): (() => void) => (desk?.chats ? desk.chats.onStatus(cb) : () => {}),
}

/** Small cache of attachment data URLs, so images do not load twice. */
const urlCache = new Map<string, Promise<string | null>>()

export function blobUrl(sha: string, mime: string): Promise<string | null> {
  const key = `${sha}|${mime}`
  let p = urlCache.get(key)
  if (!p) {
    p = chatApi.getBlob(sha).then((b64) => {
      if (!b64) {
        urlCache.delete(key)
        return null
      }
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return URL.createObjectURL(new Blob([bytes], { type: mime }))
    })
    urlCache.set(key, p)
  }
  return p
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(bin)
}
