/**
 * Main process side of the in-app agent:
 *  - keeps the Ollama and OpenRouter API keys, encrypted by Windows, out of the page,
 *  - streams chat requests to Ollama Cloud or OpenRouter and relays the chunks,
 *  - switches a request to the other service when its own is out of credit
 *    (or has no key), and remembers that for a while,
 *  - stores chats and their attachments (shared/chat-store.mjs), synced
 *    through Supabase when this computer is signed in.
 */
import { app, ipcMain, safeStorage, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ChatStore } from '../shared/chat-store.mjs'
import { OPENROUTER, errorText, postWithFallback, relayStream, toOpenRouter } from './openrouter'

const OLLAMA = 'https://ollama.com/api'

type Provider = 'ollama' | 'openrouter'
const providerOf = (p: unknown): Provider => (p === 'openrouter' ? 'openrouter' : 'ollama')
const keyFile = (p: Provider = 'ollama') => path.join(app.getPath('userData'), `${p}-key.bin`)

function readKey(p: Provider = 'ollama'): string {
  try {
    const raw = fs.readFileSync(keyFile(p))
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
  } catch {
    return (p === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.OLLAMA_API_KEY) || ''
  }
}

function writeKey(key: string, p: Provider = 'ollama') {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8')
  fs.mkdirSync(path.dirname(keyFile(p)), { recursive: true })
  fs.writeFileSync(keyFile(p), data)
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

/** One model to try: the one asked for, or one on the other service to fall back to. */
interface Candidate {
  model: string
  provider: Provider
  think?: boolean | string
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

  /** Services that ran out of credit, so requests go to the other one until retryAt. */
  const exhausted = new Map<Provider, { retryAt: number; detail: string }>()
  const isExhausted = (p: Provider) => {
    const e = exhausted.get(p)
    if (e && e.retryAt <= Date.now()) exhausted.delete(p)
    return exhausted.has(p)
  }

  ipcMain.handle('agent:keyStatus', (_e, provider?: Provider) => {
    const k = readKey(providerOf(provider))
    return { hasKey: Boolean(k), masked: mask(k) }
  })

  ipcMain.handle('agent:setKey', async (_e, key: string, provider?: Provider) => {
    const p = providerOf(provider)
    const k = String(key || '').trim()
    if (!k) {
      try { fs.unlinkSync(keyFile(p)) } catch { /* none */ }
      return { ok: true }
    }
    // Check it before keeping it, so a typo shows up here and not mid chat.
    try {
      const res = await fetch(p === 'openrouter' ? `${OPENROUTER}/key` : `${OLLAMA}/tags`, { headers: { Authorization: `Bearer ${k}` } })
      if (res.status === 401 || res.status === 403) return { ok: false, error: `${p === 'openrouter' ? 'OpenRouter' : 'Ollama'} rejected this key.` }
    } catch {
      /* offline: keep it anyway */
    }
    writeKey(k, p)
    // A new key may well have credit: stop avoiding this service.
    exhausted.delete(p)
    return { ok: true }
  })

  /** Services being avoided because they ran out of credit, and when they are tried again. */
  ipcMain.handle('agent:creditStatus', () => {
    const now = Date.now()
    return [...exhausted].filter(([, v]) => v.retryAt > now).map(([provider, v]) => ({ provider, retryAt: v.retryAt, detail: v.detail }))
  })

  /** OpenRouter's free allowance for this key: requests left today. */
  ipcMain.handle('agent:openrouterLimits', async () => {
    const k = readKey('openrouter')
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
   * Runs a request on the model asked for and, if its service is out of
   * credit or has no key, on the fallbacks the page sent (models on the other
   * service). A service that ran out is remembered, so later requests go
   * straight to the other one until it is due to be tried again; if every
   * service is out, they are all tried anyway, in case one has recovered.
   * `run` must throw OutOfCredit only before it has sent anything on.
   */
  async function withFallback<T>(
    body: any,
    signal: AbortSignal,
    onSwitch: (to: Candidate, reason: string) => void,
    run: (c: Candidate, key: string, req: any) => Promise<T>,
  ): Promise<{ result: T; used: Candidate; switched?: { from: string; to: string; reason: string } }> {
    const { provider, fallbacks, ...rest } = body || {}
    const first: Candidate = { model: rest.model, provider: providerOf(provider), think: rest.think }
    const all: Candidate[] = [first]
    for (const f of Array.isArray(fallbacks) ? fallbacks : []) {
      const c: Candidate = { model: String(f?.model || ''), provider: providerOf(f?.provider), think: f?.think }
      if (c.model && !all.some((x) => x.model === c.model && x.provider === c.provider)) all.push(c)
    }
    const order = [...all.filter((c) => !isExhausted(c.provider)), ...all.filter((c) => isExhausted(c.provider))]
    const why: string[] = []
    // Skipped ahead of time because its service ran out earlier: say so.
    if (order[0] !== first) {
      const at = new Date(exhausted.get(first.provider)!.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      why.push(`${LABEL[first.provider]} ran out of credit earlier (tried again after ${at})`)
    }
    let lastError: Error | null = null
    for (const c of order) {
      if (signal.aborted) throw new Error('aborted')
      const key = readKey(c.provider)
      if (!key) {
        why.push(`no ${LABEL[c.provider]} key`)
        continue
      }
      if (c !== first) {
        const reason = why.length ? why.join(', ') : `${LABEL[first.provider]} is out of credit`
        onSwitch(c, reason)
      }
      const req: any = { ...rest, model: c.model }
      if (c.think === undefined) delete req.think
      else req.think = c.think
      try {
        const result = await run(c, key, req)
        exhausted.delete(c.provider)
        const switched = c === first ? undefined : { from: first.model, to: c.model, reason: why.join(', ') || `${LABEL[first.provider]} is out of credit` }
        return { result, used: c, switched }
      } catch (e: any) {
        if (signal.aborted || !(e instanceof OutOfCredit)) throw e
        exhausted.set(c.provider, { retryAt: e.retryAt, detail: e.detail })
        opts.log('agent: out of credit', c.provider, e.detail)
        why.push(`${LABEL[c.provider]} is out of credit (${e.detail.slice(0, 160)})`)
        lastError = e
      }
    }
    if (lastError) throw new Error(why.join('; '))
    // No service that could run this had a key.
    throw new Error('NO_KEY')
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
      const messages = await withImages(body?.messages || [])
      const { used, switched } = await withFallback(
        { ...body, messages, stream: true },
        ctrl.signal,
        // Lets the page show the switch while the other model starts.
        (to, reason) => emit({ switched: { from: body?.model, to: to.model, reason } }),
        (c, key, req) => (c.provider === 'openrouter' ? streamOpenRouter(key, req, ctrl.signal, emit) : streamOllama(key, req, ctrl.signal, emit)),
      )
      return { ok: true, model: used.model, switched }
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

  /** Ollama's web search and page fetch, with the same key. */
  ipcMain.handle('agent:web', async (_e, kind: 'search' | 'fetch', arg: any) => {
    const key = readKey()
    if (!key) return { ok: false, error: 'No Ollama API key.' }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30_000)
    try {
      const body = kind === 'search' ? { query: String(arg.query || ''), max_results: Math.min(10, Math.max(1, Number(arg.max_results) || 5)) } : { url: String(arg.url || '') }
      const res = await fetch(`${OLLAMA}/web_${kind}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}` }
      return { ok: true, data: await res.json() }
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
      const messages = await withImages(rest.messages || [])
      const { result, used, switched } = await withFallback({ ...rest, messages }, ctrl.signal, () => {}, async (c, key, req) => {
        if (c.provider === 'openrouter') {
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
      return { ok: true, content: result, model: used.model, switched }
    } catch (e: any) {
      if (ctrl.signal.aborted) return { ok: false, error: 'Timed out.' }
      return { ok: false, error: e?.message === 'NO_KEY' ? 'No API key for this service.' : e?.message || String(e) }
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
      const img = await win.webContents.capturePage()
      return { ok: true, png: img.toPNG().toString('base64'), width, height, errors: info?.errors || [], done: Boolean(info?.done) }
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
