export type SyncKind = 'page' | 'workspace' | 'settings'

export interface SyncResult<T = any> {
  data: T | null
  seq: number
  skipped?: boolean
  damaged?: boolean
}

export interface ConflictList {
  cells: { pageId: string; pageTitle: string; cellId: string; cellTitle: string; reason: string; of: string | null }[]
  orphans: { pageId: string; title: string; conflicts: number }[]
}

export function loadDeviceId(stateDir: string): string

export class VaultSync {
  constructor(opts: { stateDir: string; emit(ev: any): void; log?(...a: any[]): void })
  device: string
  vault: string | null
  setVault(vault: string): void
  stop(): void
  scan(): Promise<void>
  status(): { deviceId: string; vault: string | null; watching: boolean; pollMs: number; lastRemoteAt: number; lastScanAt: number }
  read(kind: SyncKind, id?: string): Promise<SyncResult>
  write(kind: SyncKind, id: string | undefined, data: any, base: any, touched?: any): Promise<SyncResult>
  deletePage(id: string): Promise<boolean>
  listConflicts(): Promise<ConflictList>
}
