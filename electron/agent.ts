/**
 * Main process side of the in-app agent:
 *  - keeps the Ollama API key, encrypted by Windows, out of the page,
 *  - streams chat requests to Ollama Cloud and relays the chunks,
 *  - stores chats and their attachments (shared/chat-store.mjs), synced
 *    through Supabase when this computer is signed in.
 */
import { app, ipcMain, safeStorage, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ChatStore } from '../shared/chat-store.mjs'

const OLLAMA = 'https://ollama.com/api'

const keyFile = () => path.join(app.getPath('userData'), 'ollama-key.bin')

function readKey(): string {
  try {
    const raw = fs.readFileSync(keyFile())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
  } catch {
    return process.env.OLLAMA_API_KEY || ''
  }
}

function writeKey(key: string) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8')
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true })
  fs.writeFileSync(keyFile(), data)
}

const mask = (k: string) => (k ? `${k.slice(0, 4)}...${k.slice(-4)}` : '')

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

  ipcMain.handle('agent:keyStatus', () => {
    const k = readKey()
    return { hasKey: Boolean(k), masked: mask(k) }
  })

  ipcMain.handle('agent:setKey', async (_e, key: string) => {
    const k = String(key || '').trim()
    if (!k) {
      try { fs.unlinkSync(keyFile()) } catch { /* none */ }
      return { ok: true }
    }
    // Check it before keeping it, so a typo shows up here and not mid chat.
    try {
      const res = await fetch(`${OLLAMA}/tags`, { headers: { Authorization: `Bearer ${k}` } })
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Ollama rejected this key.' }
    } catch {
      /* offline: keep it anyway */
    }
    writeKey(k)
    return { ok: true }
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

  async function post(body: any, signal: AbortSignal) {
    const key = readKey()
    if (!key) throw new Error('NO_KEY')
    return fetch(`${OLLAMA}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  ipcMain.handle('agent:chat', async (_e, reqId: string, body: any) => {
    const ctrl = new AbortController()
    running.set(reqId, ctrl)
    try {
      const req = { ...body, stream: true, messages: await withImages(body.messages || []) }
      let res = await post(req, ctrl.signal)
      if (res.status === 400 && req.think !== undefined) {
        // Some models refuse the think switch: ask again without it.
        const text = await res.text()
        if (/think/i.test(text)) {
          delete req.think
          res = await post(req, ctrl.signal)
        } else throw new Error(text || 'Bad request')
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        let msg = text
        try { msg = JSON.parse(text).error || text } catch { /* plain text */ }
        throw new Error(`${res.status} ${msg}`.trim())
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
          if (chunk.error) throw new Error(chunk.error)
          send('agent:chunk', reqId, chunk)
        }
      }
      if (buf.trim()) {
        try { send('agent:chunk', reqId, JSON.parse(buf)) } catch { /* partial */ }
      }
      return { ok: true }
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

  /** One short non streaming call (chat titles). */
  ipcMain.handle('agent:complete', async (_e, body: any) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30_000)
    try {
      const res = await post({ ...body, stream: false }, ctrl.signal)
      if (!res.ok) return { ok: false, error: `${res.status}` }
      const j: any = await res.json()
      return { ok: true, content: j?.message?.content || '' }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    } finally {
      clearTimeout(t)
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
