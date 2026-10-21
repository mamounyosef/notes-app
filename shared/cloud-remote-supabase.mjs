/**
 * The cloud side of CloudSync, backed by Supabase (tables, RPCs and the
 * storage bucket made by supabase/schema.sql).
 *
 * Every method throws on a network or server error, so CloudSync can retry.
 */
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'

const PAGE = 500
const BUCKET = 'vault'

function check({ data, error }) {
  if (error) throw Object.assign(new Error(error.message || String(error)), { cause: error })
  return data
}

/**
 * @param {{ url: string, key: string, storage: { getItem(k: string): any, setItem(k: string, v: string): any, removeItem(k: string): any } }} opts
 */
export function createSupabaseRemote({ url, key, storage }) {
  const sb = createClient(url, key, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    // Electron's Node has no built in WebSocket.
    realtime: { transport: WebSocket },
  })

  let userId = null
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

  const blobPath = async (sha) => `${await uid()}/blobs/${sha}`

  async function pageAll(build) {
    const out = []
    for (let from = 0; ; from += PAGE) {
      const rows = check(await build().range(from, from + PAGE - 1))
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  return {
    async session() {
      const { data } = await sb.auth.getSession()
      const s = data.session
      return s ? { email: s.user?.email || '', userId: s.user?.id || '' } : null
    },

    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }))
      return this.session()
    },

    async signOut() {
      await sb.auth.signOut().catch(() => {})
      userId = null
    },

    /* ---------- notes ---------- */

    async docsSince(seq) {
      return pageAll(() =>
        sb.from('docs').select('kind, doc_id, data, rev, change_seq, deleted').gt('change_seq', seq).order('change_seq'),
      )
    },

    async docRevs() {
      return pageAll(() => sb.from('docs').select('kind, doc_id, rev, change_seq').order('change_seq'))
    },

    async getDoc(kind, docId) {
      const rows = check(
        await sb.from('docs').select('kind, doc_id, data, rev, change_seq, deleted').eq('kind', kind).eq('doc_id', docId).limit(1),
      )
      return rows[0] || null
    },

    async pushDoc({ kind, docId, data, expectedRev, deleted, device }) {
      return check(
        await sb.rpc('push_doc', {
          p_kind: kind,
          p_doc_id: docId,
          p_data: data,
          p_expected_rev: expectedRev,
          p_deleted: deleted,
          p_device: device,
        }),
      )
    },

    /* ---------- files ---------- */

    async filesSince(seq) {
      return pageAll(() =>
        sb.from('files').select('path, sha, size, rev, change_seq, deleted').gt('change_seq', seq).order('change_seq'),
      )
    },

    async fileRevs() {
      return pageAll(() => sb.from('files').select('path, sha, size, rev, change_seq, deleted').order('change_seq'))
    },

    async getFile(p) {
      const rows = check(await sb.from('files').select('path, sha, size, rev, change_seq, deleted').eq('path', p).limit(1))
      return rows[0] || null
    },

    async pushFile({ path, sha, size, expectedRev, deleted, device }) {
      return check(
        await sb.rpc('push_file', {
          p_path: path,
          p_sha: sha,
          p_size: size,
          p_expected_rev: expectedRev,
          p_deleted: deleted,
          p_device: device,
        }),
      )
    },

    async hasBlob(sha) {
      const { data, error } = await sb.storage.from(BUCKET).exists(await blobPath(sha))
      if (error) return false
      return Boolean(data)
    },

    async uploadBlob(sha, buffer) {
      // Blobs are named by their content, so an existing one is already right.
      const { error } = await sb.storage
        .from(BUCKET)
        .upload(await blobPath(sha), buffer, { upsert: true, contentType: 'application/octet-stream' })
      if (error) throw new Error(error.message)
    },

    async downloadBlob(sha) {
      const blob = check(await sb.storage.from(BUCKET).download(await blobPath(sha)))
      return Buffer.from(await blob.arrayBuffer())
    },

    /* ---------- agent chats ---------- */

    async chatsSince(seq) {
      return pageAll(() =>
        sb.from('agent_chats').select('id, data, rev, change_seq, deleted').gt('change_seq', seq).order('change_seq'),
      )
    },

    async chatRevs() {
      return pageAll(() => sb.from('agent_chats').select('id, rev, change_seq').order('change_seq'))
    },

    async getChat(id) {
      const rows = check(await sb.from('agent_chats').select('id, data, rev, change_seq, deleted').eq('id', id).limit(1))
      return rows[0] || null
    },

    async pushChat({ id, data, expectedRev, deleted, device }) {
      return check(
        await sb.rpc('push_chat', {
          p_id: id,
          p_data: data,
          p_expected_rev: expectedRev,
          p_deleted: deleted,
          p_device: device,
        }),
      )
    },

    subscribeChats(onChange) {
      const channel = sb
        .channel('agent-chats')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_chats' }, () => onChange())
        .subscribe()
      return () => {
        sb.removeChannel(channel).catch(() => {})
      }
    },

    /* ---------- live updates ---------- */

    subscribe(onChange, onStatus) {
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
