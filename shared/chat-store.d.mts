export interface ChatAttachment {
  sha: string
  mime: string
  name: string
  size: number
  kind: 'image' | 'pdf' | 'text' | 'doc'
  /** Extracted text for PDFs, documents and text files. */
  text?: string
  /** For PDFs: hashes of page images rendered for the model. */
  pages?: string[]
}

export interface ChatMessage {
  id: string
  at: number
  /** Bumped on every edit of this message, so merges keep the latest. */
  v?: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  thinkingMs?: number
  toolCalls?: { id?: string; name: string; arguments: any }[]
  toolName?: string
  attachments?: ChatAttachment[]
  /** Extra data for the interface: context summary, ask cards, undo state, errors. */
  meta?: Record<string, any>
}

export interface Chat {
  id: string
  title: string
  titleAt: number
  createdAt: number
  updatedAt: number
  deleted?: boolean
  messages: ChatMessage[]
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  count: number
  preview: string
}

export function mergeChats(a: Chat | null, b: Chat | null): Chat | null

export class ChatStore {
  constructor(opts: { dir: string; device: string; onChange?: (ev: any) => void; onStatus?: (s: any) => void; log?: (...a: any[]) => void })
  status(): { phase: string; error: string | null; lastSync: number }
  read(id: string): Promise<Chat | null>
  list(): Promise<ChatSummary[]>
  put(chat: Chat): Promise<Chat>
  remove(id: string): Promise<void>
  saveBlob(buf: Buffer): Promise<string>
  readBlob(sha: string): Promise<Buffer | null>
  setRemote(remote: any): Promise<void>
  schedule(ms?: number): void
  syncNow(): Promise<void>
  stop(): void
}
