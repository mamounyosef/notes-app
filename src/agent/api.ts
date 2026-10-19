/** The desktop bridge for the agent (see electron/agent.ts). */

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
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  count: number
  preview: string
}

const desk = (window as any).notes

export const agentAvailable = Boolean(desk?.agent)

export const agentApi = {
  keyStatus: (): Promise<{ hasKey: boolean; masked: string }> =>
    desk?.agent ? desk.agent.keyStatus() : Promise.resolve({ hasKey: false, masked: '' }),
  setKey: (key: string): Promise<{ ok: boolean; error?: string }> =>
    desk?.agent ? desk.agent.setKey(key) : Promise.resolve({ ok: false, error: 'Desktop app only' }),
  chat: (reqId: string, body: unknown): Promise<{ ok: boolean; error?: string; aborted?: boolean }> =>
    desk?.agent ? desk.agent.chat(reqId, body) : Promise.resolve({ ok: false, error: 'The agent needs the desktop app.' }),
  abort: (reqId: string) => desk?.agent?.abort(reqId),
  /** One reply without streaming. Messages may carry images ("sha:<hash>" or base64); timeout_ms defaults to 30 s. */
  complete: (body: unknown): Promise<{ ok: boolean; content?: string; error?: string }> =>
    desk?.agent ? desk.agent.complete(body) : Promise.resolve({ ok: false }),
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
