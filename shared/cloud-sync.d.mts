import type { VaultSync, SyncKind } from './vault-sync.mjs'

export interface CloudStatus {
  phase: 'off' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error'
  email: string
  lastSyncAt: number
  lastError: string
  skipped: string[]
  pending: number
  signedIn: boolean
}

export interface CloudRemote {
  session(): Promise<{ email: string; userId: string } | null>
  signIn?(email: string, password: string): Promise<{ email: string; userId: string } | null>
  signOut?(): Promise<void>
  docsSince(seq: number): Promise<any[]>
  docRevs(): Promise<any[]>
  getDoc(kind: string, docId: string): Promise<any | null>
  pushDoc(a: any): Promise<{ ok: boolean; rev?: number; change_seq?: number }>
  filesSince(seq: number): Promise<any[]>
  fileRevs(): Promise<any[]>
  getFile(path: string): Promise<any | null>
  pushFile(a: any): Promise<{ ok: boolean; rev?: number; change_seq?: number }>
  hasBlob(sha: string): Promise<boolean>
  uploadBlob(sha: string, buf: Buffer): Promise<void>
  downloadBlob(sha: string): Promise<Buffer>
  subscribe(onChange: (table: string) => void, onStatus?: (s: string) => void): () => void
}

export class CloudSync {
  constructor(opts: { vault: VaultSync; stateDir: string; onStatus?(s: CloudStatus): void; log?(...a: any[]): void })
  setVaultDir(dir: string): void
  setRemote(remote: CloudRemote | null): void
  stop(): void
  status(): CloudStatus
  markDirty(kind: SyncKind, id: string | undefined, info?: { deleted?: boolean }): void
  schedule(ms: number): void
  syncNow(): Promise<void>
}
