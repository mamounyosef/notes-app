import type { CloudRemote } from './cloud-sync.mjs'

export function createSupabaseRemote(opts: {
  url: string
  key: string
  storage: { getItem(k: string): any; setItem(k: string, v: string): any; removeItem(k: string): any }
}): CloudRemote & {
  signIn(email: string, password: string): Promise<{ email: string; userId: string } | null>
  signOut(): Promise<void>
  chatsSince(seq: number): Promise<any[]>
  chatRevs(): Promise<{ id: string; rev: number }[]>
  getChat(id: string): Promise<any | null>
  pushChat(a: { id: string; data: unknown; expectedRev: number; deleted: boolean; device: string }): Promise<{ ok: boolean; rev?: number; change_seq?: number }>
  subscribeChats(onChange: () => void): () => void
}
