/**
 * The cloud side, backed by the same Supabase project as the computers
 * (tables, RPCs and the storage bucket from supabase/schema.sql). A browser
 * twin of shared/cloud-remote-supabase.mjs: same queries, same RPCs.
 *
 * Every method throws on a network or server error, so the sync can retry.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const PAGE = 500
const BUCKET = 'vault'

function check<T = any>({ data, error }: { data: any; error: any }): T {
  if (error) throw Object.assign(new Error(error.message || String(error)), { cause: error })
  return data
}

export type Remote = ReturnType<typeof createRemote>

export function createRemote(url: string, key: string) {
  const sb: SupabaseClient = createClient(url, key, {
    auth: { storage: localStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'notes-mobile-auth' },
    realtime: { params: { eventsPerSecond: 2 } },
  })

  let userId: string | null = null
  const uid = async () => {
    if (userId) return userId
    const { data } = await sb.auth.getSession()
    userId = data.session?.user?.id || null
    if (!userId) throw new Error('Not signed in')
    return userId
  }
  sb.auth.onAuthStateChange((_evt, session) => {
    userId = session?.user?.id || null
  })

  const blobPath = async (sha: string) => `${await uid()}/blobs/${sha}`

  async function pageAll(build: () => any): Promise<any[]> {
    const out: any[] = []
    for (let from = 0; ; from += PAGE) {
      const rows = check<any[]>(await build().range(from, from + PAGE - 1))
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  return {
    client: sb,

    async session(): Promise<{ email: string; userId: string } | null> {
      const { data } = await sb.auth.getSession()
      const s = data.session
      return s ? { email: s.user?.email || '', userId: s.user?.id || '' } : null
    },

    async signIn(email: string, password: string) {
      check(await sb.auth.signInWithPassword({ email, password }))
      return this.session()
    },

    async signOut() {
      await sb.auth.signOut().catch(() => {})
      userId = null
    },

    /* ---------- notes ---------- */

    docsSince(seq: number) {
      return pageAll(() => sb.from('docs').select('kind, doc_id, data, rev, change_seq, deleted').gt('change_seq', seq).order('change_seq'))
    },

    docRevs() {
      return pageAll(() => sb.from('docs').select('kind, doc_id, rev, change_seq').order('change_seq'))
    },

    async getDoc(kind: string, docId: string) {
      const rows = check<any[]>(
        await sb.from('docs').select('kind, doc_id, data, rev, change_seq, deleted').eq('kind', kind).eq('doc_id', docId).limit(1),
      )
      return rows[0] || null
    },

    async pushDoc(a: { kind: string; docId: string; data: unknown; expectedRev: number; deleted: boolean; device: string }) {
      return check<any>(
        await sb.rpc('push_doc', {
          p_kind: a.kind,
          p_doc_id: a.docId,
          p_data: a.data,
          p_expected_rev: a.expectedRev,
          p_deleted: a.deleted,
          p_device: a.device,
        }),
      ) as { ok: boolean; rev?: number; change_seq?: number }
    },

    /* ---------- files ---------- */

    filesSince(seq: number) {
      return pageAll(() => sb.from('files').select('path, sha, size, rev, change_seq, deleted').gt('change_seq', seq).order('change_seq'))
    },

    fileRevs() {
      return pageAll(() => sb.from('files').select('path, sha, size, rev, change_seq, deleted').order('change_seq'))
    },

    async getFile(p: string) {
      const rows = check<any[]>(await sb.from('files').select('path, sha, size, rev, change_seq, deleted').eq('path', p).limit(1))
      return rows[0] || null
    },

    async pushFile(a: { path: string; sha: string | null; size: number; expectedRev: number; deleted: boolean; device: string }) {
      return check<any>(
        await sb.rpc('push_file', {
          p_path: a.path,
          p_sha: a.sha,
          p_size: a.size,
          p_expected_rev: a.expectedRev,
          p_deleted: a.deleted,
          p_device: a.device,
        }),
      ) as { ok: boolean; rev?: number; change_seq?: number }
    },

    async hasBlob(sha: string) {
      const { data, error } = await sb.storage.from(BUCKET).exists(await blobPath(sha))
      if (error) return false
      return Boolean(data)
    },

    async uploadBlob(sha: string, bytes: Uint8Array) {
      const { error } = await sb.storage
        .from(BUCKET)
        .upload(await blobPath(sha), bytes, { upsert: true, contentType: 'application/octet-stream' })
      if (error) throw new Error(error.message)
    },

    async downloadBlob(sha: string): Promise<Uint8Array> {
      const blob = check<Blob>(await sb.storage.from(BUCKET).download(await blobPath(sha)))
      return new Uint8Array(await blob.arrayBuffer())
    },

    /* ---------- live updates ---------- */

    subscribe(onChange: (table: string) => void, onStatus?: (s: string) => void) {
      const channel = sb
        .channel('notes-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, () => onChange('docs'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'files' }, () => onChange('files'))
        .subscribe((status) => onStatus?.(status))
      return () => {
        sb.removeChannel(channel).catch(() => {})
      }
    },
  }
}
