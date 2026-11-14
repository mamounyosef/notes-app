// Small shared helpers: hashing, constant-time compares, bodies, cookies, responses, rate limits.
import crypto from 'node:crypto'
import fs from 'node:fs'

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest()
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
export const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url')

/** Constant-time string compare: both sides are hashed first so lengths always match. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return crypto.timingSafeEqual(sha256(a), sha256(b))
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** Atomic JSON write: temp file next to the target, then rename. */
export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Reads a request body up to `limit` bytes (413 beyond that). */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > limit) return reject(new HttpError(413, 'Request body too large'))
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        reject(new HttpError(413, 'Request body too large'))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })
}

/** Parses a form or JSON body into a flat object of strings. */
export async function readParams(req) {
  const buf = await readBody(req)
  const type = String(req.headers['content-type'] || '').toLowerCase()
  if (type.includes('application/json')) {
    let obj
    try {
      obj = JSON.parse(buf.toString('utf8') || '{}')
    } catch {
      throw new HttpError(400, 'Invalid JSON')
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new HttpError(400, 'Invalid JSON')
    const out = {}
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
    return out
  }
  return Object.fromEntries(new URLSearchParams(buf.toString('utf8')))
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim()
  }
  return out
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * The client's IP. Behind Tailscale the socket is loopback, so the proxy's
 * X-Forwarded-For is used. The LAST entry is taken: it is the one the proxy
 * itself added, while earlier entries can be sent by the client.
 */
export function clientIp(req) {
  const sock = req.socket.remoteAddress || ''
  if (LOOPBACK.has(sock)) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (xff.length) return xff[xff.length - 1].slice(0, 64)
  }
  return sock
}

/** Counts failures per key and globally inside sliding windows. */
export class RateLimiter {
  constructor({ perKey, keyWindowMs, global, globalWindowMs }) {
    Object.assign(this, { perKey, keyWindowMs, global, globalWindowMs })
    this.keys = new Map()
    this.all = []
  }
  prune(now = Date.now()) {
    this.all = this.all.filter((t) => now - t < this.globalWindowMs)
    for (const [k, list] of this.keys) {
      const kept = list.filter((t) => now - t < this.keyWindowMs)
      if (kept.length) this.keys.set(k, kept)
      else this.keys.delete(k)
    }
  }
  blocked(key) {
    this.prune()
    return (this.keys.get(key) || []).length >= this.perKey || this.all.length >= this.global
  }
  fail(key) {
    const now = Date.now()
    this.all.push(now)
    const list = this.keys.get(key) || []
    list.push(now)
    this.keys.set(key, list)
    if (this.keys.size > 10000) this.prune(now)
  }
  succeed(key) {
    this.keys.delete(key)
  }
}

/* ---------------- responses ---------------- */

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
}

export const DEFAULT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return res.end()
  const buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  // Some local web filters (seen with Avast on this PC) rewrite responses to URLs ending in /mcp:
  // they swap Content-Length for "Transfer-Encoding: chunked" without chunking the body, which
  // corrupts the response. Letting Node chunk the body itself passes through them intact.
  const mcpPath = /\/mcp(\?|$)/.test(String(res.req.url || ''))
  const length = buf && !mcpPath ? { 'content-length': buf.length } : {}
  res.writeHead(status, { ...BASE_HEADERS, ...length, ...headers })
  res.end(buf && res.req.method !== 'HEAD' ? buf : undefined)
}

export function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', ...headers })
}

export function sendHtml(res, status, html, { csp = DEFAULT_CSP, headers = {} } = {}) {
  send(res, status, html, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    ...headers,
  })
}

export function redirect(res, location, headers = {}) {
  send(res, 302, null, { location, 'cache-control': 'no-store', ...headers })
}

/** Streams a file with single-range support (206) for resumable downloads. */
export function sendFile(req, res, file, type, extra = {}) {
  let stat
  try {
    stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    return sendJson(res, 404, { error: 'not_found' })
  }
  const size = stat.size
  const headers = {
    ...BASE_HEADERS,
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'last-modified': stat.mtime.toUTCString(),
    ...extra,
  }
  let start = 0
  let end = size - 1
  let status = 200
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    let ok = Boolean(m) && (m[1] !== '' || m[2] !== '')
    if (ok) {
      if (m[1] === '') {
        const n = Number(m[2])
        start = Math.max(0, size - n)
        ok = n > 0
      } else {
        start = Number(m[1])
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1)
      }
      ok = ok && start <= end && start < size
    }
    if (!ok) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 })
      return res.end()
    }
    status = 206
    headers['content-range'] = `bytes ${start}-${end}/${size}`
  }
  headers['content-length'] = size === 0 ? 0 : end - start + 1
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || size === 0) return res.end()
  const stream = fs.createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
