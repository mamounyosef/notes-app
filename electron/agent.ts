/**
 * Main process side of the in-app agent:
 *  - keeps the Ollama and OpenRouter API keys, encrypted by Windows, out of the page,
 *  - streams chat requests to Ollama Cloud or OpenRouter and relays the chunks,
 *  - when a key is out of credit, moves the request to the next key of the
 *    same service (never to another service), and remembers that for a while,
 *  - stores chats and their attachments (shared/chat-store.mjs), synced
 *    through Supabase when this computer is signed in.
 */
import { app, ipcMain, safeStorage, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ChatStore } from '../shared/chat-store.mjs'
import { OPENROUTER, errorText, postWithFallback, relayStream, toOpenRouter } from './openrouter'

const OLLAMA = 'https://ollama.com/api'

type Provider = 'ollama' | 'openrouter'
const providerOf = (p: unknown): Provider => (p === 'openrouter' ? 'openrouter' : 'ollama')
/** The single key file from before several keys per service could be saved. */
const keyFile = (p: Provider = 'ollama') => path.join(app.getPath('userData'), `${p}-key.bin`)
/** Every key for a service, in the order they are tried, as an encrypted JSON list. */
const keysFile = (p: Provider) => path.join(app.getPath('userData'), `${p}-keys.bin`)

const decrypt = (raw: Buffer) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'))
const encrypt = (text: string) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8'))

/** A service's keys in the order they are tried (the older single key file, or the environment, if no list is saved). */
function readKeys(p: Provider = 'ollama'): string[] {
  try {
    const list = JSON.parse(decrypt(fs.readFileSync(keysFile(p))))
    if (Array.isArray(list)) return list.map((k) => String(k || '').trim()).filter(Boolean)
  } catch {
    /* no list yet */
  }
  try {
    const one = decrypt(fs.readFileSync(keyFile(p))).trim()
    if (one) return [one]
  } catch {
    /* no older key either */
  }
  const env = (p === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.OLLAMA_API_KEY) || ''
  return env ? [env] : []
}

function writeKeys(p: Provider, keys: string[]) {
  const list = [...new Set(keys.map((k) => k.trim()).filter(Boolean))]
  fs.mkdirSync(path.dirname(keysFile(p)), { recursive: true })
  if (list.length) fs.writeFileSync(keysFile(p), encrypt(JSON.stringify(list)))
  else try { fs.unlinkSync(keysFile(p)) } catch { /* none */ }
  // The list replaces the older single key file.
  try { fs.unlinkSync(keyFile(p)) } catch { /* none */ }
}

const mask = (k: string) => (k ? `${k.slice(0, 4)}...${k.slice(-4)}` : '')

const LABEL: Record<Provider, string> = { ollama: 'Ollama', openrouter: 'OpenRouter' }

/** An HTTP failure from a service, with what it said. */
class ServiceError extends Error {
  constructor(public provider: Provider, public status: number, public detail: string) {
    super(`${provider === 'openrouter' ? 'OpenRouter: ' : ''}${status ? `${status} ` : ''}${detail}`.trim())
  }
}

/** The service refused because the key's credit, plan usage or daily free allowance is used up. */
class OutOfCredit extends Error {
  constructor(public provider: Provider, public detail: string, public retryAt: number) {
    super(`${LABEL[provider]} is out of credit: ${detail}`)
  }
}

const CREDIT_TEXT = /credit|insufficient|balance|quota|usage limit|limit (?:reached|exceeded)|reached your|exceeded your|upgrade|billing|payment|subscription|free-models-per-day|per[- ]day|daily|weekly|monthly/i

/** Next midnight UTC, when OpenRouter resets the free models' daily allowance. */
function nextUtcMidnight() {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

/**
 * When a failure means the key has run out (credit, plan usage or the daily
 * free allowance) rather than a passing problem: when to try that service
 * again, else 0. Status 0 is an error sent inside a stream, judged by its text.
 *  - 402 is "payment required" on both services.
 *  - 429 is out of credit only when the text says so (a daily or plan limit);
 *    otherwise it is a busy model, which is retried, not switched away from.
 *  - 403 is out of credit when the text says so (OpenRouter's key spending limit).
 */
function creditRetryAt(p: Provider, status: number, text: string): number {
  const credit = status === 402 || ((status === 429 || status === 403 || status === 0) && CREDIT_TEXT.test(text))
  if (!credit) return 0
  // The free models' daily allowance comes back at midnight UTC.
  if (p === 'openrouter' && /free-models-per-day|per[- ]day|daily/i.test(text)) return nextUtcMidnight()
  // Credit can be topped up or a plan limit can reset at any time: look again after a while.
  return Date.now() + 15 * 60_000
}

/** The error text a failed response carried, as one line. */
async function failureText(p: Provider, res: Response) {
  if (p === 'openrouter') return (await errorText(res)).replace(/^\d+\s*/, '')
  const text = await res.text().catch(() => '')
  try { return String(JSON.parse(text).error || text) } catch { return text }
}

/** Turns a failed response into the right error: out of credit, or a plain service error. */
async function failure(p: Provider, res: Response): Promise<Error> {
  const detail = (await failureText(p, res)).trim() || res.statusText || 'No answer'
  const retryAt = creditRetryAt(p, res.status, detail)
  return retryAt ? new OutOfCredit(p, `${res.status} ${detail}`, retryAt) : new ServiceError(p, res.status, detail)
}

/** Set when a request ran on a later key because the ones before it were out of credit: the page notes it on the reply. */
interface KeySwitch {
  provider: Provider
  /** Which key answered, counting from 1. */
  key: number
  keys: number
  reason: string
}

export function setupAgent(opts: {
  getWin(): BrowserWindow | null
  device: string
  log(...a: unknown[]): void
  saveAsset(buf: Buffer, ext: string): Promise<string>
}) {
  const send = (channel: string, ...args: unknown[]) => {
    const w = opts.getWin()
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }

  const chats = new ChatStore({
    dir: path.join(app.getPath('userData'), 'agent'),
    device: opts.device,
    onChange: (ev) => send('chats:event', ev),
    onStatus: (s) => send('chats:status', s),
    log: opts.log,
  })

  /* ---------------- API key ---------------- */

  /**
   * Keys that ran out of credit, so requests use the service's next key until
   * retryAt. Saved on this computer (by a hash of the key, never the key
   * itself), so a restart still skips the keys that are out.
   */
  const statusFile = path.join(app.getPath('userData'), 'key-status.json')
  const idOf = (k: string) => createHash('sha256').update(k).digest('hex').slice(0, 24)
  const saved: { out?: Record<string, { retryAt: number; detail: string }>; current?: Partial<Record<Provider, string>> } = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(statusFile, 'utf8')) || {}
      // The first version saved only the out of credit list.
      return j.out || j.current ? j : { out: j }
    } catch {
      return {}
    }
  })()
  const outById = saved.out || {}
  /** The key each service last answered with (its id): a reply is noted only when this changes. */
  const current: Partial<Record<Provider, string>> = saved.current || {}
  const saveStatus = () => {
    const now = Date.now()
    for (const [id, v] of Object.entries(outById)) if (!(v?.retryAt > now)) delete outById[id]
    try {
      fs.writeFileSync(statusFile, JSON.stringify({ out: outById, current }))
    } catch (e: any) {
      opts.log('key status not saved', e?.message)
    }
  }
  const exhausted = {
    get: (k: string) => outById[idOf(k)],
    set: (k: string, v: { retryAt: number; detail: string }) => {
      outById[idOf(k)] = v
      saveStatus()
    },
    delete: (k: string) => {
      if (!(idOf(k) in outById)) return
      delete outById[idOf(k)]
      saveStatus()
    },
  }
  const outInfo = (k: string) => {
    const e = exhausted.get(k)
    if (e && !(e.retryAt > Date.now())) exhausted.delete(k)
    return exhausted.get(k) || null
  }
  /** The key the next request goes to: the first one not out of credit (the first one if all are). */
  const inUseIndex = (p: Provider, keys = readKeys(p)) => {
    const i = keys.findIndex((k) => !outInfo(k))
    return keys.length ? Math.max(0, i) : -1
  }
  /** Records the key that answered last, so only a change of key is told. */
  const answeredWith = (p: Provider, k: string) => {
    if (current[p] === idOf(k)) return
    current[p] = idOf(k)
    saveStatus()
  }

  /** "Ollama" with one key, "Ollama key 2" with several. */
  const keyLabel = (p: Provider, i: number, n: number) => (n > 1 ? `${LABEL[p]} key ${i + 1}` : LABEL[p])

  ipcMain.handle('agent:keyStatus', (_e, provider?: Provider) => {
    const p = providerOf(provider)
    const keys = readKeys(p)
    return {
      hasKey: keys.length > 0,
      masked: mask(keys[0] || ''),
      keys: keys.map((k, i) => {
        const out = outInfo(k)
        return { masked: mask(k), outUntil: out?.retryAt ?? null, detail: out?.detail ?? '', inUse: i === inUseIndex(p, keys) }
      }),
    }
  })

  /** Asks the service whether it knows the key, so a typo shows up here and not mid chat. */
  async function checkKey(p: Provider, k: string): Promise<string> {
    try {
      const res = await fetch(p === 'openrouter' ? `${OPENROUTER}/key` : `${OLLAMA}/tags`, { headers: { Authorization: `Bearer ${k}` } })
      if (res.status === 401 || res.status === 403) return `${LABEL[p]} rejected this key.`
    } catch {
      /* offline: keep it anyway */
    }
    return ''
  }

  /** Replaces the first key (the one tried first); an empty key removes every key of the service. */
  ipcMain.handle('agent:setKey', async (_e, key: string, provider?: Provider) => {
    const p = providerOf(provider)
    const k = String(key || '').trim()
    if (!k) {
      writeKeys(p, [])
      return { ok: true }
    }
    const err = await checkKey(p, k)
    if (err) return { ok: false, error: err }
    writeKeys(p, [k, ...readKeys(p).slice(1)])
    // A new key may well have credit.
    exhausted.delete(k)
    return { ok: true }
  })

  /** Adds a key after the others: it is used when the ones before it run out of credit. */
  ipcMain.handle('agent:addKey', async (_e, key: string, provider?: Provider) => {
    const p = providerOf(provider)
    const k = String(key || '').trim()
    if (!k) return { ok: false, error: 'Paste a key first.' }
    const keys = readKeys(p)
    if (keys.includes(k)) return { ok: false, error: 'This key is already saved.' }
    const err = await checkKey(p, k)
    if (err) return { ok: false, error: err }
    writeKeys(p, [...keys, k])
    exhausted.delete(k)
    return { ok: true }
  })

  ipcMain.handle('agent:removeKey', (_e, provider: Provider, index: number) => {
    const p = providerOf(provider)
    const keys = readKeys(p)
    const i = Number(index)
    if (!(i >= 0 && i < keys.length)) return { ok: false, error: 'No such key.' }
    exhausted.delete(keys[i])
    writeKeys(p, keys.filter((_, j) => j !== i))
    return { ok: true }
  })

  /** Makes a key the one used: it moves to the top and its out of credit mark is cleared. */
  ipcMain.handle('agent:useKey', (_e, provider: Provider, index: number) => {
    const p = providerOf(provider)
    const keys = readKeys(p)
    const i = Number(index)
    if (!(i >= 0 && i < keys.length)) return { ok: false, error: 'No such key.' }
    const k = keys[i]
    exhausted.delete(k)
    writeKeys(p, [k, ...keys.filter((_, j) => j !== i)])
    return { ok: true }
  })

  /**
   * Asks the service whether a key works right now: OpenRouter reports the
   * key's limits; Ollama answers a one token request. Updates the key's mark.
   */
  ipcMain.handle('agent:testKey', async (_e, provider: Provider, index: number) => {
    const p = providerOf(provider)
    const k = readKeys(p)[Number(index)]
    if (!k) return { ok: false, error: 'No such key.' }
    try {
      let res: Response
      if (p === 'openrouter') {
        res = await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${k}` } })
        if (res.ok) {
          const d: any = (await res.json())?.data || {}
          const f = d.free_model_daily_requests
          if (typeof d.limit_remaining === 'number' && d.limit_remaining <= 0) {
            exhausted.set(k, { retryAt: Date.now() + 15 * 60_000, detail: 'Key spending limit reached' })
            return { ok: false, error: 'Its spending limit is used up.' }
          }
          if (f?.limit && f.used >= f.limit) {
            exhausted.set(k, { retryAt: nextUtcMidnight(), detail: 'Free requests for today used up' })
            return { ok: false, error: `All ${f.limit} free requests for today are used.` }
          }
          exhausted.delete(k)
          return { ok: true, info: f?.limit ? `Works. ${f.used ?? 0} of ${f.limit} free requests used today.` : 'Works.' }
        }
      } else {
        res = await postOllama(k, { model: 'gpt-oss:20b', messages: [{ role: 'user', content: 'Hi' }], stream: false, think: 'low', options: { num_predict: 1 } }, AbortSignal.timeout(30_000))
        if (res.ok) {
          exhausted.delete(k)
          return { ok: true, info: 'Works.' }
        }
      }
      const err = await failure(p, res)
      if (err instanceof OutOfCredit) exhausted.set(k, { retryAt: err.retryAt, detail: err.detail })
      return { ok: false, error: err instanceof OutOfCredit ? `Out of credit: ${err.detail}` : err.message }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  /** OpenRouter's free allowance for one key (the first by default): requests used today. */
  ipcMain.handle('agent:openrouterLimits', async (_e, index?: number) => {
    const k = readKeys('openrouter')[Number(index) || 0]
    if (!k) return { ok: false }
    try {
      const j: any = await (await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${k}` } })).json()
      const f = j?.data?.free_model_daily_requests
      return { ok: true, freeUsed: f?.used ?? null, freeLimit: f?.limit ?? null, freeTier: Boolean(j?.data?.is_free_tier) }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  /* ---------------- streaming chat ---------------- */

  const running = new Map<string, AbortController>()

  /** Swaps attachment references ("sha:<hash>") in `images` for the base64 bytes. */
  async function withImages(messages: any[]) {
    const out = []
    for (const m of messages) {
      if (!Array.isArray(m.images) || !m.images.length) {
        out.push(m)
        continue
      }
      const images: string[] = []
      for (const ref of m.images) {
        const sha = String(ref).startsWith('sha:') ? String(ref).slice(4) : null
        if (!sha) {
          images.push(String(ref))
          continue
        }
        const buf = await chats.readBlob(sha)
        if (buf) images.push(buf.toString('base64'))
      }
      out.push({ ...m, images })
    }
    return out
  }

  function postOllama(key: string, body: any, signal: AbortSignal) {
    return fetch(`${OLLAMA}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  /**
   * Runs a request with the service's keys in order: when one is out of
   * credit, the same request goes to the next key of the same service (never
   * another service or model). A key that ran out is remembered, so later
   * requests skip it until it is due to be tried again; if every key is out,
   * they are all tried anyway, in case one has recovered. `run` must throw
   * OutOfCredit only before it has sent anything on.
   */
  async function withKeys<T>(
    p: Provider,
    signal: AbortSignal,
    onSwitch: (sw: KeySwitch) => void,
    run: (key: string) => Promise<T>,
  ): Promise<{ result: T; switched?: KeySwitch }> {
    const keys = readKeys(p)
    if (!keys.length) throw new Error('NO_KEY')
    const n = keys.length
    // Keys still in credit, in order; only if none is left, all of them again.
    let tries = keys.map((k, i) => ({ k, i })).filter(({ k }) => !outInfo(k))
    if (!tries.length) tries = keys.map((k, i) => ({ k, i }))
    const why: string[] = []
    // Skipped ahead of time because they ran out earlier: say so.
    keys.forEach((k, i) => {
      if (tries.some((t) => t.k === k)) return
      const at = new Date(outInfo(k)!.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      why.push(`${keyLabel(p, i, n)} ran out of credit earlier (tried again after ${at})`)
    })
    for (const { k, i } of tries) {
      if (signal.aborted) throw new Error('aborted')
      // Told once, when the key differs from the one that answered last; not on every reply after.
      const fresh = current[p] !== idOf(k) && (Boolean(current[p]) || i > 0)
      const sw: KeySwitch | undefined = fresh ? { provider: p, key: i + 1, keys: n, reason: why.join(', ') } : undefined
      if (sw) onSwitch(sw)
      try {
        const result = await run(k)
        exhausted.delete(k)
        answeredWith(p, k)
        return { result, switched: sw }
      } catch (e: any) {
        if (signal.aborted || !(e instanceof OutOfCredit)) throw e
        exhausted.set(k, { retryAt: e.retryAt, detail: e.detail })
        const who = keyLabel(p, i, n)
        opts.log('agent: out of credit', who, e.detail)
        why.push(`${who} is out of credit (${e.detail.slice(0, 160)})`)
      }
    }
    throw new Error(n > 1 ? `Every ${LABEL[p]} key is out of credit: ${why.join('; ')}` : why.join('; '))
  }

  /** Streams one reply from OpenRouter, relayed as Ollama chunks. */
  async function streamOpenRouter(key: string, req: any, signal: AbortSignal, emit: (chunk: any) => void) {
    const orReq = toOpenRouter(req, true)
    let res = await postWithFallback(key, orReq, signal)
    // Free models are busy at times (429/5xx): try twice more before giving up,
    // unless the 429 says the credit or the daily free allowance is used up.
    for (let attempt = 1; attempt <= 2 && (res.status === 429 || res.status >= 500) && !signal.aborted; attempt++) {
      if (res.status === 429) {
        const text = await res.clone().text().catch(() => '')
        if (creditRetryAt('openrouter', 429, text)) break
      }
      await res.text().catch(() => '')
      await new Promise((r) => setTimeout(r, 2500 * attempt))
      res = await postWithFallback(key, orReq, signal)
    }
    if (!res.ok || !res.body) throw await failure('openrouter', res)
    let sent = false
    try {
      await relayStream(res, (chunk) => {
        sent = true
        emit(chunk)
      })
    } catch (e: any) {
      // Refused inside the stream before anything came: may still be out of credit.
      const retryAt = sent ? 0 : creditRetryAt('openrouter', 0, e?.message || '')
      if (retryAt) throw new OutOfCredit('openrouter', e.message, retryAt)
      throw e
    }
  }

  /** Streams one reply from Ollama Cloud. */
  async function streamOllama(key: string, req: any, signal: AbortSignal, emit: (chunk: any) => void) {
    let res = await postOllama(key, req, signal)
    if (res.status === 400 && req.think !== undefined) {
      // Some models refuse the think switch: ask again without it.
      const text = await res.clone().text()
      if (/think/i.test(text)) {
        await res.text().catch(() => '')
        delete req.think
        res = await postOllama(key, req, signal)
      }
    }
    // Ollama Cloud now and then answers 500/502/503 under load: try twice more before giving up.
    for (let attempt = 1; attempt <= 2 && res.status >= 500 && !signal.aborted; attempt++) {
      await res.text().catch(() => '')
      await new Promise((r) => setTimeout(r, 1500 * attempt))
      res = await postOllama(key, req, signal)
    }
    if (!res.ok || !res.body) throw await failure('ollama', res)
    let sent = false
    const handle = (chunk: any) => {
      if (chunk.error) {
        const msg = String(chunk.error)
        const retryAt = sent ? 0 : creditRetryAt('ollama', 0, msg)
        throw retryAt ? new OutOfCredit('ollama', msg, retryAt) : new Error(msg)
      }
      sent = true
      emit(chunk)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let chunk
        try { chunk = JSON.parse(line) } catch { continue }
        handle(chunk)
      }
    }
    if (buf.trim()) {
      let chunk
      try { chunk = JSON.parse(buf) } catch { /* partial */ }
      if (chunk) handle(chunk)
    }
  }

  ipcMain.handle('agent:chat', async (_e, reqId: string, body: any) => {
    const ctrl = new AbortController()
    running.set(reqId, ctrl)
    try {
      const emit = (chunk: any) => send('agent:chunk', reqId, chunk)
      const { provider, ...rest } = body || {}
      const p = providerOf(provider)
      const req = { ...rest, stream: true, messages: await withImages(rest.messages || []) }
      const { switched } = await withKeys(
        p,
        ctrl.signal,
        // Lets the page show the switch while the next key starts.
        (sw) => emit({ switched: sw }),
        // A copy per key: the Ollama path may drop the think switch from it.
        (key) => (p === 'openrouter' ? streamOpenRouter(key, { ...req }, ctrl.signal, emit) : streamOllama(key, { ...req }, ctrl.signal, emit)),
      )
      return { ok: true, switched }
    } catch (e: any) {
      if (ctrl.signal.aborted) return { ok: false, aborted: true }
      const msg = e?.message === 'NO_KEY' ? 'NO_KEY' : e?.message || String(e)
      opts.log('agent chat failed', msg)
      return { ok: false, error: msg }
    } finally {
      running.delete(reqId)
    }
  })

  ipcMain.handle('agent:abort', (_e, reqId: string) => {
    running.get(reqId)?.abort()
    return true
  })

  /** Ollama's web search and page fetch, with the Ollama keys (the next one when a key is out of credit). */
  ipcMain.handle('agent:web', async (_e, kind: 'search' | 'fetch', arg: any) => {
    const keys = readKeys('ollama')
    if (!keys.length) return { ok: false, error: 'No Ollama API key.' }
    const live = keys.filter((k) => !outInfo(k))
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30_000)
    try {
      const body = kind === 'search' ? { query: String(arg.query || ''), max_results: Math.min(10, Math.max(1, Number(arg.max_results) || 5)) } : { url: String(arg.url || '') }
      let error = ''
      for (const key of live.length ? live : keys) {
        const res = await fetch(`${OLLAMA}/web_${kind}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        if (res.ok) {
          exhausted.delete(key)
          return { ok: true, data: await res.json() }
        }
        const text = (await res.text().catch(() => '')).slice(0, 200)
        error = `${res.status} ${text}`
        const retryAt = creditRetryAt('ollama', res.status, text)
        if (!retryAt) break
        exhausted.set(key, { retryAt, detail: error })
      }
      return { ok: false, error }
    } catch (e: any) {
      return { ok: false, error: e?.name === 'AbortError' ? 'The web request timed out.' : e?.message || String(e) }
    } finally {
      clearTimeout(t)
    }
  })

  /** One short non streaming call (chat titles, reading images for models that cannot see). */
  ipcMain.handle('agent:complete', async (_e, body: any) => {
    const ctrl = new AbortController()
    // timeout_ms is ours, not Ollama's: reading a dense image can take a while.
    const { timeout_ms, ...rest } = body || {}
    const t = setTimeout(() => ctrl.abort(), Math.min(180_000, Number(timeout_ms) || 30_000))
    try {
      const { provider, ...req } = rest
      const p = providerOf(provider)
      req.messages = await withImages(req.messages || [])
      const { result, switched } = await withKeys(p, ctrl.signal, () => {}, async (key) => {
        if (p === 'openrouter') {
          const res = await postWithFallback(key, toOpenRouter(req, false), ctrl.signal)
          if (!res.ok) throw await failure('openrouter', res)
          const j: any = await res.json()
          return String(j?.choices?.[0]?.message?.content || '')
        }
        const res = await postOllama(key, { ...req, stream: false }, ctrl.signal)
        if (!res.ok) throw await failure('ollama', res)
        const j: any = await res.json()
        return String(j?.message?.content || '')
      })
      return { ok: true, content: result, switched }
    } catch (e: any) {
      if (ctrl.signal.aborted) return { ok: false, error: 'Timed out.' }
      return { ok: false, error: e?.message === 'NO_KEY' ? `No ${LABEL[providerOf(body?.provider)]} API key.` : e?.message || String(e) }
    } finally {
      clearTimeout(t)
    }
  })

  /**
   * Draws an HTML block off screen and returns a picture of it, its size and
   * any errors it reported, so the agent can check a diagram it just made.
   */
  ipcMain.handle('agent:renderWidget', async (_e, body: { html: string; width?: number }) => {
    const width = Math.max(240, Math.min(1600, Math.round(Number(body?.width) || 760)))
    const file = path.join(app.getPath('temp'), `notes-widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`)
    const win = new BrowserWindow({
      show: false,
      width,
      height: 600,
      useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (ev) => ev.preventDefault())
    try {
      await fsp.writeFile(file, String(body?.html || ''), 'utf8')
      await win.loadFile(file)
      let info: any = null
      for (let i = 0; i < 80 && !info?.done; i++) {
        await new Promise((r) => setTimeout(r, 150))
        info = await win.webContents.executeJavaScript('window.__widget || null', true).catch(() => null)
      }
      const height = Math.max(40, Math.min(3000, Math.ceil(info?.h || 400) + 4))
      win.setContentSize(width, height)
      await new Promise((r) => setTimeout(r, 350))
      // Measured problems (overlaps, lines through text, parts cut off), at the final size.
      const lint = await win.webContents.executeJavaScript('window.__lint ? window.__lint() : []', true).catch(() => [])
      const img = await win.webContents.capturePage()
      return { ok: true, png: img.toPNG().toString('base64'), width, height, errors: info?.errors || [], lint: Array.isArray(lint) ? lint : [], done: Boolean(info?.done) }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    } finally {
      win.destroy()
      fsp.rm(file, { force: true }).catch(() => {})
    }
  })

  /* ---------------- chats ---------------- */

  ipcMain.handle('chats:list', () => chats.list())
  ipcMain.handle('chats:get', (_e, id: string) => chats.read(id))
  ipcMain.handle('chats:put', (_e, chat: any) => chats.put(chat))
  ipcMain.handle('chats:remove', (_e, id: string) => chats.remove(id))
  ipcMain.handle('chats:status', () => chats.status())
  ipcMain.handle('chats:syncNow', () => chats.syncNow())

  ipcMain.handle('blob:save', async (_e, b64: string) => chats.saveBlob(Buffer.from(String(b64), 'base64')))
  ipcMain.handle('blob:get', async (_e, sha: string) => {
    const buf = await chats.readBlob(String(sha))
    return buf ? buf.toString('base64') : null
  })
  /** Puts a chat attachment into the notes folder so a cell can show it. */
  ipcMain.handle('blob:toAsset', async (_e, sha: string, mime: string) => {
    const buf = await chats.readBlob(String(sha))
    if (!buf) return null
    const ext = (String(mime).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5)
    return opts.saveAsset(buf, ext)
  })

  /** Reads a dropped or picked file from disk (PDFs, documents, images). */
  ipcMain.handle('file:read', async (_e, filePath: string) => {
    const st = await fsp.stat(filePath)
    if (st.size > 60 * 1024 * 1024) throw new Error('File is larger than 60 MB')
    const buf = await fsp.readFile(filePath)
    return { name: path.basename(filePath), size: st.size, b64: buf.toString('base64') }
  })

  /* ---------------- voice typing ---------------- */

  // Windows voice typing (Win+H) types into whatever has focus, in any
  // language Windows knows. A small PowerShell helper presses the keys; it
  // stays running so later presses are instant.
  let keyer: ChildProcessWithoutNullStreams | null = null
  const KEYER = [
    '$sig = \'[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);\'',
    'Add-Type -MemberDefinition $sig -Name K -Namespace W',
    'while ($true) { $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }',
    '  [W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero)',
    '  [W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero) }',
  ].join('\n')

  ipcMain.handle('agent:dictate', () => {
    if (process.platform !== 'win32') return false
    if (!keyer || keyer.exitCode !== null) {
      const script = path.join(app.getPath('userData'), 'voice-typing.ps1')
      fs.writeFileSync(script, KEYER, 'utf8')
      keyer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true })
      keyer.on('error', (e) => opts.log('dictation helper failed', e.message))
    }
    keyer.stdin.write('go\n')
    return true
  })
  app.on('will-quit', () => keyer?.kill())

  return { chats }
}
