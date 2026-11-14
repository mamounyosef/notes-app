#!/usr/bin/env node
/*
 * Notes phone server: the Android APK download page, the app's update feed,
 * and a remote MCP server (OAuth 2.1) so Claude on the phone can use Notes.
 *
 * Listens on 127.0.0.1 only. It is published through Tailscale Funnel at
 *   https://mamoun.tail27d0a5.ts.net/notes   (path mount: download page, update feed)
 *   https://mamoun.tail27d0a5.ts.net:10000   (root mount: MCP connector + OAuth)
 * Every route works with or without a leading /notes, and all HTML links are relative.
 *
 * Usage:
 *   node server/phone-server.mjs                   start the server
 *   node server/phone-server.mjs --reset-passcode  new passcode, sign everyone out, then exit
 *   node server/phone-server.mjs --set-passcode "my own pass"   your own passcode, same sign out
 *
 * Env: NOTES_PHONE_PORT (default 4790), NOTES_MCP_PUBLIC_URL, NOTES_MCP_ALLOW_LOOPBACK=1 (tests),
 *      NOTES_PHONE_NO_PRIVATE_LINKS=1 (tests), NOTES_PHONE_RELEASE_DIR (tests).
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleMessage } from './phone/mcp.mjs'
import { bearerCheck, createOAuth } from './phone/oauth.mjs'
import { downloadPage, loginPage } from './phone/pages.mjs'
import { OAuthStore, Secrets, normalizePasscode, writePrivateLinks } from './phone/state.mjs'
import {
  HttpError,
  RateLimiter,
  clientIp,
  hmac,
  parseCookies,
  readBody,
  readParams,
  redirect,
  safeEqual,
  send,
  sendFile,
  sendHtml,
  sendJson,
} from './phone/util.mjs'

/* ---------------- config ---------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const HOST = 'https://mamoun.tail27d0a5.ts.net'
const cfg = {
  port: Number(process.env.NOTES_PHONE_PORT) || 4790,
  publicUrl: (process.env.NOTES_MCP_PUBLIC_URL || `${HOST}:10000`).replace(/\/+$/, ''),
  downloadUrl: `${HOST}/notes/`,
  mcpUrl: `${(process.env.NOTES_MCP_PUBLIC_URL || `${HOST}:10000`).replace(/\/+$/, '')}/mcp`,
  allowLoopback: process.env.NOTES_MCP_ALLOW_LOOPBACK === '1',
  privateLinks: process.env.NOTES_PHONE_NO_PRIVATE_LINKS !== '1',
  releaseDir: path.resolve(process.env.NOTES_PHONE_RELEASE_DIR || path.join(REPO, 'release-phone')),
}
const COOKIE = 'notes_dl'
const COOKIE_DAYS = 90
const ALLOWED_ORIGINS = new Set(['https://claude.ai', 'https://claude.com', 'https://www.claude.ai', 'https://www.claude.com'])

const secrets = new Secrets()
const store = new OAuthStore()

function refreshPrivateLinks() {
  if (!cfg.privateLinks) return
  try {
    writePrivateLinks(REPO, cfg, secrets.get().passcode)
  } catch (e) {
    console.error('Could not write PRIVATE-LINKS.md:', e.message)
  }
}

const setAt = process.argv.indexOf('--set-passcode')
if (setAt >= 0) {
  const own = process.argv.slice(setAt + 1).join(' ').trim()
  // Typed with spaces or dashes, any case: what counts is the letters and digits.
  if (normalizePasscode(own).replace(/-/g, '').length < 8) {
    console.error('Give a passcode of at least 8 letters or digits, for example:\n  npm run phone-server -- --set-passcode "my own pass 42"')
    process.exit(1)
  }
  secrets.resetPasscode(own)
  store.revokeAll()
  refreshPrivateLinks()
  console.log('Passcode set. All Claude connections and browser sessions are signed out; sign in again with your new passcode.')
  process.exit(0)
}

if (process.argv.includes('--reset-passcode')) {
  secrets.resetPasscode()
  store.revokeAll()
  refreshPrivateLinks()
  console.log(`Passcode reset. All Claude connections and browser sessions are signed out. New passcode: ${cfg.privateLinks ? 'see PRIVATE-LINKS.md' : `in ${secrets.file}`}`)
  process.exit(0)
}

fs.mkdirSync(path.join(cfg.releaseDir, 'ota'), { recursive: true })
refreshPrivateLinks()

// Wrong passcodes: 5 per 15 minutes per client, 20 per hour in total.
const limiter = new RateLimiter({ perKey: 5, keyWindowMs: 15 * 60 * 1000, global: 20, globalWindowMs: 60 * 60 * 1000 })
// Client registrations: 10 per hour per client, 60 per hour in total.
const registerLimiter = new RateLimiter({ perKey: 10, keyWindowMs: 60 * 60 * 1000, global: 60, globalWindowMs: 60 * 60 * 1000 })
const oauth = createOAuth({ cfg, secrets, store, limiter, registerLimiter })

/* ---------------- auth helpers ---------------- */

const cookieSig = (exp) => hmac(secrets.get().cookieSecret, `dl:${exp}:${secrets.passcodeEpoch()}`)

function hasSession(req) {
  const v = parseCookies(req.headers.cookie)[COOKIE]
  if (!v) return false
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(v)
  if (!m || Number(m[1]) < Date.now()) return false
  return safeEqual(m[2], cookieSig(m[1]))
}

function sessionCookie() {
  const exp = Date.now() + COOKIE_DAYS * 24 * 3600 * 1000
  return `${COOKIE}=${exp}.${cookieSig(exp)}; Max-Age=${COOKIE_DAYS * 24 * 3600}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

/** The Android app's token, from the x-notes-app header or (for downloads) the ?t= query parameter. */
function hasAppToken(req, url, allowQuery) {
  const tok = secrets.get().otaToken
  const h = req.headers['x-notes-app']
  if (typeof h === 'string' && safeEqual(h, tok)) return true
  if (allowQuery) {
    const t = url.searchParams.get('t')
    if (t && safeEqual(t, tok)) return true
  }
  return false
}

const unauthorized = (res) => sendJson(res, 401, { error: 'unauthorized' }, { 'cache-control': 'no-store' })
const notFound = (res) => sendJson(res, 404, { error: 'not_found' })

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function apkInfo() {
  const info = readJson(path.join(cfg.releaseDir, 'apk.json'))
  if (!info || !fs.existsSync(path.join(cfg.releaseDir, 'notes.apk'))) return null
  return info
}

/* ---------------- routes ---------------- */

async function route(req, res, p, url) {
  const m = req.method === 'HEAD' ? 'GET' : req.method

  // Download page and login.
  if (p === '/' && m === 'GET') {
    if (!hasSession(req)) return sendHtml(res, 200, loginPage())
    return sendHtml(res, 200, downloadPage(apkInfo()))
  }
  if (p === '/login' && m === 'POST') {
    const ip = clientIp(req)
    if (limiter.blocked(ip)) {
      console.warn(`Passcode blocked (rate limit) for ${ip} on /login`)
      return sendHtml(res, 429, loginPage({ error: 'Too many wrong passcodes. Wait a while, then try again.' }))
    }
    const form = await readParams(req)
    if (!safeEqual(normalizePasscode(form.passcode), normalizePasscode(secrets.get().passcode))) {
      limiter.fail(ip)
      console.warn(`Wrong passcode from ${ip} on /login`)
      return sendHtml(res, 401, loginPage({ error: 'Wrong passcode.' }))
    }
    limiter.succeed(ip)
    return redirect(res, './', { 'set-cookie': sessionCookie() })
  }
  if (p === '/login' && m === 'GET') return redirect(res, './')

  // The Android app's web view (origin https://localhost) reads the update feed with fetch().
  const appOrigin = req.headers.origin === 'https://localhost' || req.headers.origin === 'http://localhost'
  if (appOrigin && (p === '/apk.json' || p === '/ota/manifest.json')) {
    res.setHeader('access-control-allow-origin', req.headers.origin)
    res.setHeader('vary', 'Origin')
    if (m === 'OPTIONS') {
      return send(res, 204, null, {
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'x-notes-app',
        'access-control-max-age': '86400',
      })
    }
  }

  // APK and update feed.
  if (p === '/notes.apk' && m === 'GET') {
    if (!hasSession(req) && !hasAppToken(req, url, true)) {
      if (String(req.headers.accept || '').includes('text/html')) return redirect(res, './')
      return unauthorized(res)
    }
    return sendFile(req, res, path.join(cfg.releaseDir, 'notes.apk'), 'application/vnd.android.package-archive', {
      'content-disposition': 'attachment; filename="Notes.apk"',
    })
  }
  if (p === '/apk.json' && m === 'GET') {
    if (!hasSession(req) && !hasAppToken(req, url, false)) return unauthorized(res)
    const info = readJson(path.join(cfg.releaseDir, 'apk.json'))
    return info ? sendJson(res, 200, info, { 'cache-control': 'no-store' }) : notFound(res)
  }
  if (p === '/ota/manifest.json' && m === 'GET') {
    if (!hasAppToken(req, url, false)) return unauthorized(res)
    const man = readJson(path.join(cfg.releaseDir, 'ota', 'manifest.json'))
    return man ? sendJson(res, 200, man, { 'cache-control': 'no-store' }) : notFound(res)
  }
  const zip = /^\/ota\/(bundle-[0-9A-Za-z._-]+\.zip)$/.exec(p)
  if (zip && m === 'GET') {
    if (!hasAppToken(req, url, true)) return unauthorized(res)
    const dir = path.join(cfg.releaseDir, 'ota')
    const file = path.join(dir, zip[1])
    if (path.dirname(file) !== dir || zip[1].includes('..')) return notFound(res)
    return sendFile(req, res, file, 'application/zip', { 'content-disposition': `attachment; filename="${zip[1]}"` })
  }

  // OAuth endpoints.
  if (await oauth(req, res, p, url)) return

  // Remote MCP (Streamable HTTP, stateless, JSON responses).
  if (p === '/mcp') return mcp(req, res, m)

  if (p === '/favicon.ico' || p === '/robots.txt') {
    if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' })
    return send(res, 204, null)
  }
  return notFound(res)
}

async function mcp(req, res, m) {
  const origin = req.headers.origin
  const cors = origin && ALLOWED_ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'www-authenticate, mcp-session-id' } : {}
  if (origin && !ALLOWED_ORIGINS.has(origin)) return sendJson(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } })
  if (m === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
      'access-control-max-age': '86400',
    })
    return res.end()
  }
  const auth = bearerCheck(req, store, cfg)
  if (!auth.grant) {
    // Drain any body so the connection stays healthy.
    if (m === 'POST') await readBody(req).catch(() => {})
    return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': auth.challenge, ...cors })
  }
  if (m === 'GET' || m === 'DELETE') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST', ...cors })
  if (m !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST', ...cors })

  const raw = await readBody(req)
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors)
  }
  if (Array.isArray(body)) {
    if (!body.length || body.length > 50) return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, cors)
    const out = (await Promise.all(body.map(handleMessage))).filter(Boolean)
    if (!out.length) return send(res, 202, null, cors)
    return sendJson(res, 200, out, cors)
  }
  const out = await handleMessage(body)
  if (!out) return send(res, 202, null, cors)
  return sendJson(res, 200, out, cors)
}

/* ---------------- server ---------------- */

function normalizePath(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://local')
  let p = url.pathname
  if (p === '/notes') return { url, p, bare: true }
  if (p.startsWith('/notes/')) p = p.slice('/notes'.length)
  return { url, p }
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now()
  let logPath = '?'
  res.on('finish', () => console.log(`${req.method} ${logPath} ${res.statusCode} ${Date.now() - t0}ms`))
  try {
    const { url, p, bare } = normalizePath(req.url)
    logPath = p.length > 120 ? `${p.slice(0, 120)}...` : p
    // "/notes" without the slash: add it, so relative links resolve inside the mount.
    if (bare) return redirect(res, 'notes/')
    await route(req, res, p, url)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error('Request failed:', (e && e.message) || e)
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'server_error' : e.message })
    else res.destroy()
  }
})
server.requestTimeout = 60 * 1000
server.headersTimeout = 20 * 1000
server.keepAliveTimeout = 30 * 1000
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  else socket.destroy()
})

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`Notes phone server on http://127.0.0.1:${cfg.port} (public MCP base ${cfg.publicUrl})`)
  console.log(`Release files: ${cfg.releaseDir}`)
})

process.on('uncaughtException', (e) => console.error('Uncaught:', (e && e.message) || e))
process.on('unhandledRejection', (e) => console.error('Unhandled:', (e && e.message) || e))
