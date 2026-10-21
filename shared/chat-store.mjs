/**
 * Agent chats: kept as one JSON file per chat on this computer, and synced
 * through Supabase (table agent_chats, see supabase/schema.sql) so the same
 * conversations show on every computer.
 *
 * Merging never loses a message: two copies of a chat are joined message by
 * message (by id). When both copies changed the same message, the one with
 * the higher `v` (bumped on every edit of that message) wins.
 *
 * Attachments (images, PDFs) are stored by content hash in `blobs/` and go to
 * the same content addressed Storage folder the notes use.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const PUSH_DELAY = 800
const POLL_MS = 60_000
const MAX_TRIES = 5

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '')
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const stable = (v) => JSON.stringify(v)
const hash = (v) => crypto.createHash('sha1').update(stable(v)).digest('hex')

async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

function newer(a, b) {
  if ((a.v || 0) !== (b.v || 0)) return (a.v || 0) > (b.v || 0) ? a : b
  return stable(a) >= stable(b) ? a : b
}

/**
 * Order of chat messages. Older chats can hold messages made in the same
 * millisecond (a reply starts the instant a message is sent); for those the
 * natural order is the person's message, then tool results, then replies.
 */
const ROLE_ORDER = { user: 0, tool: 1, assistant: 2 }
export function messageOrder(x, y) {
  return (x.at || 0) - (y.at || 0) || (ROLE_ORDER[x.role] ?? 3) - (ROLE_ORDER[y.role] ?? 3) || String(x.id).localeCompare(String(y.id))
}

/** Joins two copies of a chat without dropping anything either one has. */
export function mergeChats(a, b) {
  if (!a) return b
  if (!b) return a
  const byId = new Map()
  for (const m of a.messages || []) byId.set(m.id, m)
  for (const m of b.messages || []) byId.set(m.id, byId.has(m.id) ? newer(byId.get(m.id), m) : m)
  const messages = [...byId.values()].sort(messageOrder)
  const titled = (a.titleAt || 0) >= (b.titleAt || 0) ? a : b
  return {
    id: a.id,
    title: titled.title,
    titleAt: titled.titleAt || 0,
    createdAt: Math.min(a.createdAt || Infinity, b.createdAt || Infinity),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    deleted: Boolean(a.deleted || b.deleted),
    messages,
    chosen: mergeChosen(a.chosen, b.chosen),
    ...(a.voice || b.voice ? { voice: true } : {}),
  }
}

/** Branch choices: per fork, the most recent choice wins. */
function mergeChosen(a, b) {
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b || {})) if (!out[k] || (v?.at || 0) > (out[k].at || 0)) out[k] = v
  return out
}

/** Every attachment hash a chat refers to. */
function blobsOf(chat) {
  const out = new Set()
  for (const m of chat.messages || []) for (const a of m.attachments || []) if (a.sha) out.add(a.sha)
  return [...out]
}

export class ChatStore {
  /**
   * @param {{ dir: string, device: string, onChange?: (ev: any) => void, onStatus?: (s: any) => void, log?: (...a: any[]) => void }} opts
   */
  constructor({ dir, device, onChange, onStatus, log }) {
    this.dir = dir
    this.device = device
    this.onChange = onChange || (() => {})
    this.onStatusCb = onStatus || (() => {})
    this.log = log || (() => {})
    this.remote = null
    this.timer = null
    this.poll = null
    this.unsub = null
    this.running = null
    this.again = false
    this.statusInfo = { phase: 'off', error: null, lastSync: 0 }
    this.state = this.loadState()
    this.uploaded = new Set(this.state.uploaded || [])
  }

  chatFile(id) {
    return path.join(this.dir, 'chats', `${safeId(id)}.json`)
  }

  blobFile(sha) {
    return path.join(this.dir, 'blobs', safeId(sha))
  }

  stateFile() {
    return path.join(this.dir, 'chat-sync.json')
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'))
    } catch {
      return { userId: null, cursor: 0, revs: {}, pushed: {}, uploaded: [] }
    }
  }

  async saveState() {
    this.state.uploaded = [...this.uploaded]
    await atomicWrite(this.stateFile(), JSON.stringify(this.state))
  }

  status() {
    return { ...this.statusInfo }
  }

  setStatus(patch) {
    this.statusInfo = { ...this.statusInfo, ...patch }
    this.onStatusCb(this.status())
  }

  /* ---------------- local chats ---------------- */

  async read(id) {
    try {
      return JSON.parse(await fsp.readFile(this.chatFile(id), 'utf8'))
    } catch {
      return null
    }
  }

  async list() {
    let names = []
    try {
      names = await fsp.readdir(path.join(this.dir, 'chats'))
    } catch {
      return []
    }
    const out = []
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      const c = await this.read(n.slice(0, -5))
      if (!c || c.deleted) continue
      const last = [...(c.messages || [])].reverse().find((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      out.push({
        id: c.id,
        title: c.title || 'New chat',
        createdAt: c.createdAt || 0,
        updatedAt: c.updatedAt || 0,
        count: (c.messages || []).filter((m) => m.role === 'user').length,
        preview: String(last?.content || '').slice(0, 140),
        ...(c.voice ? { voice: true } : {}),
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Saves a chat, joined with whatever is already on disk for it. */
  async put(chat) {
    const merged = mergeChats(await this.read(chat.id), chat)
    await atomicWrite(this.chatFile(chat.id), JSON.stringify(merged))
    this.schedule(PUSH_DELAY)
    return merged
  }

  async remove(id) {
    const c = await this.read(id)
    if (!c) return
    await atomicWrite(this.chatFile(id), JSON.stringify({ ...c, deleted: true, messages: [], updatedAt: Date.now() }))
    this.schedule(PUSH_DELAY)
  }

  /* ---------------- attachments ---------------- */

  async saveBlob(buf) {
    const sha = sha256(buf)
    const f = this.blobFile(sha)
    if (!fs.existsSync(f)) await atomicWrite(f, buf)
    return sha
  }

  /** The bytes of an attachment, fetched from the cloud when this computer lacks them. */
  async readBlob(sha) {
    try {
      return await fsp.readFile(this.blobFile(sha))
    } catch {
      if (!this.remote) return null
      try {
        const buf = await this.remote.downloadBlob(sha)
        await atomicWrite(this.blobFile(sha), buf)
        return buf
      } catch (e) {
        this.log('chat blob download failed', sha, e)
        return null
      }
    }
  }

  /* ---------------- cloud ---------------- */

  async setRemote(remote) {
    if (this.unsub) this.unsub()
    this.unsub = null
    clearInterval(this.poll)
    this.remote = remote
    if (!remote) {
      this.setStatus({ phase: 'off', error: null })
      return
    }
    const who = await remote.session().catch(() => null)
    if (!who) {
      this.remote = null
      this.setStatus({ phase: 'off', error: null })
      return
    }
    if (this.state.userId !== who.userId) {
      // A different account: start over so nothing leaks between them.
      this.state = { userId: who.userId, cursor: 0, revs: {}, pushed: {}, uploaded: [] }
      this.uploaded = new Set()
      await this.saveState()
    }
    try {
      this.unsub = remote.subscribeChats?.(() => this.schedule(300)) || null
    } catch (e) {
      this.log('chat realtime failed', e)
    }
    this.poll = setInterval(() => this.schedule(0), POLL_MS)
    this.schedule(0)
  }

  schedule(ms = 0) {
    if (!this.remote) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.syncNow().catch(() => {}), ms)
  }

  async syncNow() {
    if (!this.remote) return
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      let delay = 0
      try {
        do {
          this.again = false
          this.setStatus({ phase: 'syncing' })
          await this.pull()
          await this.push()
        } while (this.again)
        this.setStatus({ phase: 'idle', error: null, lastSync: Date.now() })
      } catch (e) {
        const msg = e?.message || String(e)
        this.log('chat sync failed', msg)
        const missing = /agent_chats|push_chat|schema cache|does not exist/i.test(msg)
        this.setStatus({ phase: 'error', error: missing ? 'Run supabase/schema.sql again to add the chats table.' : msg })
        delay = missing ? POLL_MS : 15_000
      } finally {
        this.running = null
        if (delay) this.schedule(delay)
      }
    })()
    return this.running
  }

  async pull() {
    const rows = await this.remote.chatsSince(this.state.cursor || 0)
    for (const row of rows) {
      await this.applyRow(row)
      this.state.cursor = Math.max(this.state.cursor || 0, Number(row.change_seq))
    }
    if (rows.length) await this.saveState()
  }

  async applyRow(row) {
    const local = await this.read(row.id)
    const remote = row.data ? { ...row.data, id: row.id, deleted: Boolean(row.deleted || row.data.deleted) } : null
    const merged = mergeChats(local, remote)
    if (!merged) return
    this.state.revs[row.id] = Number(row.rev)
    // What the cloud holds now counts as pushed, so only local news goes up.
    if (remote) this.state.pushed[row.id] = hash(remote)
    if (!local || stable(merged) !== stable(local)) {
      await atomicWrite(this.chatFile(row.id), JSON.stringify(merged))
      this.onChange({ type: 'chat-changed', id: row.id })
    }
  }

  async push() {
    let names = []
    try {
      names = await fsp.readdir(path.join(this.dir, 'chats'))
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      const id = n.slice(0, -5)
      const chat = await this.read(id)
      if (!chat) continue
      if (this.state.pushed[id] === hash(chat)) continue
      await this.pushChat(id, chat)
    }
  }

  async pushChat(id, chat) {
    for (const sha of blobsOf(chat)) {
      if (this.uploaded.has(sha)) continue
      let buf
      try {
        buf = await fsp.readFile(this.blobFile(sha))
      } catch {
        continue // not on this computer, so another one uploaded it
      }
      if (!(await this.remote.hasBlob(sha))) await this.remote.uploadBlob(sha, buf)
      this.uploaded.add(sha)
    }
    let data = chat
    for (let i = 0; i < MAX_TRIES; i++) {
      const rev = Number(this.state.revs[id] || 0)
      const res = await this.remote.pushChat({ id, data, expectedRev: rev, deleted: Boolean(data.deleted), device: this.device })
      if (res?.ok) {
        this.state.revs[id] = Number(res.rev)
        this.state.pushed[id] = hash(data)
        await this.saveState()
        return
      }
      // Someone else saved first: take theirs, join, try again.
      const row = await this.remote.getChat(id)
      if (row) {
        await this.applyRow(row)
        data = (await this.read(id)) || data
      } else {
        this.state.revs[id] = 0
      }
    }
    throw new Error('Chat kept changing on the other computer, will retry')
  }

  stop() {
    clearTimeout(this.timer)
    clearInterval(this.poll)
    if (this.unsub) this.unsub()
  }
}
