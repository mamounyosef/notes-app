/**
 * The phone's working copy of the notes, in IndexedDB.
 *
 * The same rules as shared/vault-sync.mjs on the computer, minus the folder
 * watching (nothing else writes this store):
 *  - every save is stamped (sync versions) and merged with what is stored at
 *    that moment, so a save never overwrites changes that just came from the cloud;
 *  - a version from the cloud is merged in (never replaces), and the screen is told.
 */
import * as core from '../../../shared/sync-core.mjs'
import type { Page, Settings, Workspace } from '../../../src/types'
import type { SyncResult, Touched, VaultEvent } from '../../../src/lib/storage'
import * as idb from './idb'

export type Kind = 'page' | 'workspace' | 'settings'

const KINDS = {
  page: { merge: core.mergePages, adopt: core.adoptLegacyPage },
  workspace: { merge: core.mergeWorkspaces, adopt: core.adoptLegacyWorkspace },
  settings: { merge: core.mergeSettings, adopt: (d: any) => d },
} as const

export const docKey = (kind: Kind, id?: string) => `${kind}:${id || ''}`

function randomId() {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return 'm' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export class MobileVault {
  device = ''
  seq = 0
  private queues = new Map<string, Promise<unknown>>()
  private listeners = new Set<(ev: VaultEvent) => void>()
  /** Told after every local change, so the cloud sync knows what to send. */
  onLocalChange: (kind: Kind, id: string | undefined, info?: { deleted?: boolean }) => void = () => {}
  /** Search keeps its own copy of page text; it is told about every change. */
  onPageStored: (id: string, page: Page | null) => void = () => {}
  ready: Promise<void>

  constructor() {
    this.ready = (async () => {
      let id = await idb.get<string>('meta', 'device')
      if (!id || !/^[a-z0-9]{6,32}$/i.test(id)) {
        id = randomId()
        await idb.put('meta', 'device', id)
      }
      this.device = id
    })()
  }

  on(cb: (ev: VaultEvent) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  emit(ev: VaultEvent) {
    for (const cb of this.listeners) {
      try {
        cb(ev)
      } catch (e) {
        console.error('vault listener', e)
      }
    }
  }

  /** One operation at a time per note, in order. */
  private queue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    this.queues.set(key, tail)
    tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return next
  }

  async read<T>(kind: Kind, id?: string): Promise<SyncResult<T>> {
    await this.ready
    const key = docKey(kind, id)
    return this.queue(key, async () => {
      const data = (await idb.get<T>('docs', key)) ?? null
      return { data, seq: this.seq }
    })
  }

  /** Saves local edits made on top of `base`; returns what is stored afterwards. */
  async write<T>(kind: Kind, id: string | undefined, data: T, base: T | null, touched: Touched | null): Promise<SyncResult<T>> {
    await this.ready
    const key = docKey(kind, id)
    return this.queue(key, async () => {
      const now = Date.now()
      let stamped: any
      let bumped: boolean
      if (kind === 'page') ({ page: stamped, bumped } = core.stampPage(base as any, data as any, this.device, touched, now))
      else if (kind === 'workspace') ({ workspace: stamped, bumped } = core.stampWorkspace(base as any, data as any, this.device, now))
      else ({ settings: stamped, bumped } = core.stampSettings(base as any, data as any, now))

      const stored = (await idb.get<any>('docs', key)) ?? null
      if (!bumped && base && stored) return { data: null, skipped: true, seq: this.seq }

      const k = KINDS[kind] as any
      let merged = stamped
      if (stored) merged = k.merge(merged, k.adopt(stored, base, now), 'a')
      if (core.stable(merged) !== core.stable(stored)) await idb.put('docs', key, merged)
      this.seq++
      if (kind === 'page') this.onPageStored(id!, merged)
      this.onLocalChange(kind, id)
      return { data: merged as T, seq: this.seq }
    })
  }

  /** What the phone has for a note right now, or null. */
  async current<T = any>(kind: Kind, id?: string): Promise<T | null> {
    await this.ready
    const key = docKey(kind, id)
    return this.queue(key, async () => (await idb.get<T>('docs', key)) ?? null)
  }

  /** Every note stored, as [kind, id] pairs. */
  async listDocs(): Promise<[Kind, string | undefined][]> {
    await this.ready
    return (await idb.keys('docs')).map((k) => {
      const i = k.indexOf(':')
      const kind = k.slice(0, i) as Kind
      const id = k.slice(i + 1)
      return [kind, kind === 'page' ? id : undefined]
    })
  }

  /** A version from the cloud: merged with what is stored (never replaces it) and shown. */
  async applyRemote<T>(kind: Kind, id: string | undefined, remote: T): Promise<T> {
    await this.ready
    const key = docKey(kind, id)
    return this.queue(key, async () => {
      const k = KINDS[kind] as any
      const now = Date.now()
      const stored = (await idb.get<any>('docs', key)) ?? null
      let merged: any = remote
      if (stored) {
        merged = core.mergeSettled(kind, k.adopt(stored, null, now), merged, () =>
          console.warn('sync: merge depended on the order, settled on one copy', kind, id || ''),
        )
      }
      const changed = !stored || core.stable(merged) !== core.stable(stored)
      if (changed) {
        await idb.put('docs', key, merged)
        this.seq++
        if (kind === 'page') this.onPageStored(id!, merged)
        this.emit({ type: kind, id: id as any, data: merged, seq: this.seq } as VaultEvent)
      }
      return merged as T
    })
  }

  /** The page was deleted elsewhere: set it aside here too. */
  async removeRemote(id: string): Promise<void> {
    await this.ready
    const key = docKey('page', id)
    return this.queue(key, async () => {
      const stored = await idb.get('docs', key)
      if (stored) await idb.put('trash', `${id}-cloud-deleted-${Date.now()}`, stored)
      await idb.del('docs', key)
      this.onPageStored(id, null)
      this.emit({ type: 'page-removed', id })
    })
  }

  /** Deleted here: kept in the trash store, and the cloud is told. */
  async deletePage(id: string): Promise<void> {
    await this.ready
    const key = docKey('page', id)
    return this.queue(key, async () => {
      const stored = await idb.get('docs', key)
      if (stored) await idb.put('trash', `${id}-${Date.now()}`, stored)
      await idb.del('docs', key)
      this.onPageStored(id, null)
      this.onLocalChange('page', id, { deleted: true })
    })
  }

  /** All stored pages (for search). */
  async allPages(): Promise<Page[]> {
    const out: Page[] = []
    for (const [k, v] of await idb.entries<Page>('docs')) if (k.startsWith('page:') && v) out.push({ ...v, id: k.slice(5) })
    return out
  }
}

export type { Page, Settings, Workspace }
