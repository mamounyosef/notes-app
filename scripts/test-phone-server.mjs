// End to end test for server/phone-server.mjs: download page gating, rate limits,
// APK and update feed, /notes prefix routing, OAuth 2.1 (DCR, PKCE, rotation) and remote MCP.
// Runs the server on a free port with a temp APPDATA and a fake Notes app. Never touches real data.
// Usage: node scripts/test-phone-server.mjs
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '../server/phone-server.mjs')
const BASE_PUBLIC = 'https://mamoun.tail27d0a5.ts.net:10000'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-phone-'))
const appData = path.join(tmp, 'appdata')
const releaseDir = path.join(tmp, 'release-phone')
fs.mkdirSync(path.join(appData, 'notesapp'), { recursive: true })
fs.mkdirSync(path.join(releaseDir, 'ota'), { recursive: true })

/* ---- release files ---- */
const apk = crypto.randomBytes(100 * 1024)
fs.writeFileSync(path.join(releaseDir, 'notes.apk'), apk)
fs.writeFileSync(
  path.join(releaseDir, 'apk.json'),
  JSON.stringify({ versionCode: 3, versionName: '1.2.0', sha256: 'x', size: apk.length, publishedAt: '2026-11-01T10:00:00Z', notes: 'Faster <sync>' }),
)
const zipBytes = crypto.randomBytes(5000)
fs.writeFileSync(path.join(releaseDir, 'ota', 'bundle-1.2.0.zip'), zipBytes)
fs.writeFileSync(path.join(releaseDir, 'ota', 'manifest.json'), JSON.stringify({ version: '1.2.0', file: 'bundle-1.2.0.zip' }))

/* ---- fake Notes app ---- */
const NOTES_TOKEN = 'fake-notes-token'
const TOOLS = [{ name: 'read_page', description: 'Read a page.', inputSchema: { type: 'object', properties: {} } }]
const calls = []
const fake = http.createServer((req, res) => {
  const out = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers['x-notes-token'] !== NOTES_TOKEN) return out(401, { error: 'bad token' })
  if (req.url === '/health') return out(200, { ok: true })
  if (req.url === '/tools') return out(200, { tools: TOOLS })
  if (req.url === '/call') {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const body = JSON.parse(b)
      calls.push(body)
      if (body.name === 'boom') return out(500, { error: 'tool exploded' })
      out(200, { content: [{ type: 'text', text: `ran ${body.name} for ${body.client}` }] })
    })
    return
  }
  out(404, {})
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(appData, 'notesapp', 'claude-link.json'), JSON.stringify({ port: fake.address().port, token: NOTES_TOKEN, pid: process.pid, exe: null }))

/* ---- helpers ---- */
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const port = await freePort()
const ORIGIN = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  APPDATA: appData,
  NOTES_PHONE_PORT: String(port),
  NOTES_MCP_ALLOW_LOOPBACK: '1',
  NOTES_PHONE_NO_PRIVATE_LINKS: '1',
  NOTES_PHONE_RELEASE_DIR: releaseDir,
}
delete env.NOTES_MCP_PUBLIC_URL

let serverLog = ''
const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (c) => (serverLog += c))
child.stderr.on('data', (c) => (serverLog += c))
for (let i = 0; i < 100 && !serverLog.includes('Notes phone server on'); i++) await new Promise((r) => setTimeout(r, 100))
if (!serverLog.includes('Notes phone server on')) {
  console.error('Server did not start:\n' + serverLog)
  process.exit(1)
}

const stateFile = path.join(appData, 'notesapp', 'phone-server.json')
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
let PASS = state().passcode
const OTA = state().otaToken

let lastPath = ""
async function req(p, { method = 'GET', headers = {}, body, ip } = {}) {
  const h = { ...headers }
  if (ip) h['x-forwarded-for'] = ip
  let r, buf
  try {
    r = await fetch(ORIGIN + p, { method, headers: h, body, redirect: 'manual' })
    buf = Buffer.from(await r.arrayBuffer())
  } catch (e) {
    throw new Error(`${method} ${p.split('?')[0]} failed: ${e.message} (${e.cause && e.cause.message})`)
  }
  lastPath = `${method} ${p.split('?')[0]} ${r.status} ${JSON.stringify([...r.headers])}`
  return { status: r.status, headers: r.headers, buf, text: buf.toString('utf8') }
}
const form = (obj) => ({ 'content-type': 'application/x-www-form-urlencoded' })
const enc = (obj) => new URLSearchParams(obj).toString()

try {
  /* ---- state and passcode ---- */
  check(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/.test(PASS), 'passcode is four words and two digits')
  check(OTA.length >= 43, 'OTA token generated')

  /* ---- download page gating ---- */
  let r = await req('/')
  check(r.status === 200 && r.text.includes('Notes for Android') && r.text.includes('action="login"'), 'GET / shows login page')
  check(!r.text.includes('Download Notes.apk'), 'login page does not leak the download')
  check(String(r.headers.get('content-security-policy')).includes("default-src 'none'"), 'CSP header on HTML')
  check(r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('referrer-policy') === 'no-referrer', 'nosniff and no-referrer headers')
  r = await req('/', { method: 'HEAD' })
  check(r.status === 200 && r.buf.length === 0, 'HEAD / works with no body')
  r = await req('/notes')
  check(r.status === 302 && r.headers.get('location') === 'notes/', '/notes redirects to notes/')
  r = await req('/notes/')
  check(r.status === 200 && r.text.includes('Notes for Android'), '/notes/ prefix routes to the login page')
  r = await req('/nope')
  check(r.status === 404 && r.text === '{"error":"not_found"}', 'unknown route is a bare 404')

  r = await req('/notes.apk')
  check(r.status === 401, 'APK without auth is 401')
  r = await req('/notes.apk', { headers: { accept: 'text/html' } })
  check(r.status === 302, 'APK without auth in a browser redirects to the login page')
  r = await req('/apk.json')
  check(r.status === 401, 'apk.json without auth is 401')

  /* ---- wrong passcode and per-IP rate limit ---- */
  for (let i = 0; i < 5; i++) {
    r = await req('/login', { method: 'POST', headers: form(), body: enc({ passcode: 'wrong-pass-' + i }), ip: '10.0.0.1' })
    if (i === 0) check(r.status === 401 && r.text.includes('Wrong passcode'), 'wrong passcode is refused')
  }
  r = await req('/login', { method: 'POST', headers: form(), body: enc({ passcode: PASS }), ip: '10.0.0.1' })
  check(r.status === 429 && !r.headers.get('set-cookie'), '6th try from the same IP is 429, even with the right passcode')
  r = await req('/login', { method: 'POST', headers: form(), body: 'passcode=' + 'a'.repeat(70 * 1024), ip: '10.0.0.9' })
  check(r.status === 413, 'body over 64 KB is 413')

  /* ---- cookie login ---- */
  const typed = PASS.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
  r = await req('/notes/login', { method: 'POST', headers: form(), body: enc({ passcode: typed }), ip: '10.0.0.2' })
  const setCookie = r.headers.get('set-cookie') || ''
  check(r.status === 302 && r.headers.get('location') === './', 'right passcode (typed with spaces and a capital) logs in')
  check(/HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Path=\//.test(setCookie), 'cookie is HttpOnly, Secure, SameSite=Lax, Path=/')
  const cookie = setCookie.split(';')[0]
  r = await req('/notes/', { headers: { cookie } })
  check(r.status === 200 && r.text.includes('Download Notes.apk') && r.text.includes('href="notes.apk"') && r.text.includes('1.2.0'), 'download page with cookie')
  check(r.text.includes('Faster &#60;sync&#62;'), 'release notes are HTML-escaped')
  r = await req('/', { headers: { cookie: cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA') } })
  check(r.status === 200 && !r.text.includes('Download Notes.apk'), 'tampered cookie is refused')

  r = await req('/notes/notes.apk', { headers: { cookie } })
  check(r.status === 200 && r.buf.equals(apk), 'APK download with cookie')
  check(r.headers.get('content-type') === 'application/vnd.android.package-archive', 'APK content type')
  check(r.headers.get('content-disposition') === 'attachment; filename="Notes.apk"', 'APK content disposition')
  check(Number(r.headers.get('content-length')) === apk.length, 'APK content length')
  r = await req('/notes.apk', { headers: { cookie, range: 'bytes=10-19' } })
  check(r.status === 206 && r.buf.equals(apk.subarray(10, 20)) && r.headers.get('content-range') === `bytes 10-19/${apk.length}`, 'Range request gives 206 with the right bytes')
  r = await req('/notes.apk', { headers: { cookie, range: 'bytes=-5' } })
  check(r.status === 206 && r.buf.equals(apk.subarray(apk.length - 5)), 'suffix Range works')
  r = await req('/notes.apk', { headers: { cookie, range: `bytes=${apk.length + 10}-` } })
  check(r.status === 416, 'unsatisfiable Range is 416')
  r = await req('/notes.apk', { headers: { 'x-notes-app': OTA } })
  check(r.status === 200 && r.buf.equals(apk), 'APK with the app header token')
  r = await req('/notes.apk?t=' + encodeURIComponent(OTA))
  check(r.status === 200 && r.buf.equals(apk), 'APK with the ?t= token')
  r = await req('/apk.json', { headers: { cookie } })
  check(r.status === 200 && JSON.parse(r.text).versionCode === 3 && r.headers.get('cache-control') === 'no-store', 'apk.json with cookie, no-store')

  /* ---- OTA feed ---- */
  r = await req('/ota/manifest.json', { headers: { cookie } })
  check(r.status === 401, 'OTA manifest refuses the cookie (header only)')
  r = await req('/ota/manifest.json?t=' + encodeURIComponent(OTA))
  check(r.status === 401, 'OTA manifest refuses the query token (header only)')
  r = await req('/notes/ota/manifest.json', { headers: { 'x-notes-app': OTA } })
  check(r.status === 200 && JSON.parse(r.text).version === '1.2.0' && r.headers.get('cache-control') === 'no-store', 'OTA manifest with header (under /notes)')
  r = await req('/ota/manifest.json', { headers: { 'x-notes-app': OTA + 'x' } })
  check(r.status === 401, 'wrong app token is 401')
  r = await req('/ota/bundle-1.2.0.zip', { headers: { 'x-notes-app': OTA } })
  check(r.status === 200 && r.buf.equals(zipBytes) && r.headers.get('content-type') === 'application/zip', 'OTA zip with header')
  r = await req('/ota/bundle-1.2.0.zip?t=' + encodeURIComponent(OTA))
  check(r.status === 200 && r.buf.equals(zipBytes), 'OTA zip with ?t= token')
  r = await req('/ota/bundle-1.2.0.zip')
  check(r.status === 401, 'OTA zip without token is 401')
  r = await req('/ota/bundle-..%2F..%2Fapk.json', { headers: { 'x-notes-app': OTA } })
  check(r.status === 404, 'encoded traversal in the bundle name is 404')
  r = await req('/ota/bundle-nope.zip', { headers: { 'x-notes-app': OTA } })
  check(r.status === 404, 'missing bundle is 404')

  /* ---- metadata ---- */
  r = await req('/.well-known/oauth-protected-resource')
  let j = JSON.parse(r.text)
  check(j.resource === `${BASE_PUBLIC}/mcp` && j.authorization_servers[0] === BASE_PUBLIC && j.bearer_methods_supported[0] === 'header', 'protected resource metadata')
  r = await req('/notes/.well-known/oauth-protected-resource/mcp')
  check(r.status === 200 && JSON.parse(r.text).resource === `${BASE_PUBLIC}/mcp`, 'protected resource metadata at the /mcp path (with /notes prefix)')
  r = await req('/.well-known/oauth-authorization-server')
  j = JSON.parse(r.text)
  check(
    j.issuer === BASE_PUBLIC && j.token_endpoint === `${BASE_PUBLIC}/token` && j.registration_endpoint === `${BASE_PUBLIC}/register` && j.code_challenge_methods_supported.join() === 'S256',
    'authorization server metadata',
  )
  r = await req('/.well-known/openid-configuration')
  check(JSON.parse(r.text).issuer === BASE_PUBLIC, 'openid-configuration mirrors it')

  /* ---- /mcp without a token ---- */
  const rpc = (msg, token, extra = {}) =>
    req('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: typeof msg === 'string' ? msg : JSON.stringify(msg),
    })
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  check(r.status === 401 && r.headers.get('www-authenticate') === `Bearer resource_metadata="${BASE_PUBLIC}/.well-known/oauth-protected-resource"`, '/mcp without token: 401 with resource_metadata')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'bogus-token')
  check(r.status === 401 && /error="invalid_token"/.test(r.headers.get('www-authenticate') || ''), '/mcp with a bad token: invalid_token')

  /* ---- registration ---- */
  const json = { 'content-type': 'application/json' }
  r = await req('/register', { method: 'POST', headers: json, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'], client_name: 'Evil' }) })
  check(r.status === 400 && JSON.parse(r.text).error === 'invalid_redirect_uri', 'register refuses a foreign redirect_uri')
  r = await req('/register', { method: 'POST', headers: json, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'] }) })
  check(r.status === 400, 'register refuses a list with one foreign redirect_uri')
  r = await req('/register', { method: 'POST', headers: json, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }) })
  check(r.status === 201 && JSON.parse(r.text).client_id, 'register accepts the claude.ai callback')
  const REDIRECT = `http://127.0.0.1:${port + 1}/callback`
  r = await req('/register', { method: 'POST', headers: json, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: '<b>Test</b> app', token_endpoint_auth_method: 'none' }) })
  const client = JSON.parse(r.text)
  check(r.status === 201 && client.client_id && !client.client_secret, 'register a loopback client (test mode), no secret')

  /* ---- authorize ---- */
  const pkce = () => {
    const verifier = crypto.randomBytes(32).toString('base64url')
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
  }
  const authUrl = (extra = {}) =>
    '/authorize?' +
    enc({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: 'st-123',
      resource: `${BASE_PUBLIC}/mcp`,
      ...extra,
    })
  r = await req(authUrl({ code_challenge_method: 'S256' }))
  check(r.status === 302 && /error=invalid_request/.test(r.headers.get('location') || '') && /state=st-123/.test(r.headers.get('location') || ''), 'authorize without PKCE redirects with invalid_request')
  let pk = pkce()
  r = await req(authUrl({ code_challenge: pk.challenge, code_challenge_method: 'plain' }))
  check(r.status === 302 && /error=invalid_request/.test(r.headers.get('location') || ''), 'authorize refuses plain PKCE')
  r = await req(authUrl({ code_challenge: pk.challenge, code_challenge_method: 'S256', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }))
  check(r.status === 400 && !r.headers.get('location'), 'authorize with an unregistered redirect_uri shows an error page, no redirect')
  r = await req(authUrl({ code_challenge: pk.challenge, code_challenge_method: 'S256', client_id: 'nope' }))
  check(r.status === 400, 'authorize with an unknown client is 400')
  r = await req(authUrl({ code_challenge: pk.challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' }))
  check(r.status === 302 && /error=invalid_target/.test(r.headers.get('location') || ''), 'authorize with a foreign resource is invalid_target')

  async function approvePage(challenge) {
    const res = await req('/notes' + authUrl({ code_challenge: challenge, code_challenge_method: 'S256' }))
    const m = /name="p" value="([^"]+)"/.exec(res.text)
    return { res, p: m && m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))) }
  }
  let page = await approvePage(pk.challenge)
  check(page.res.status === 200 && page.res.text.includes('Connect Claude to your Notes') && page.p, 'authorize shows the approval page')
  check(page.res.text.includes('&#60;b&#62;Test&#60;/b&#62; app') && !page.res.text.includes('<b>Test</b>'), 'client_name is HTML-escaped')
  check(String(page.res.headers.get('content-security-policy')).includes(`form-action 'self' http://127.0.0.1:${port + 1}`), 'approval page CSP allows the redirect origin')

  r = await req('/authorize', { method: 'POST', headers: form(), body: enc({ p: page.p, passcode: 'not-it' }), ip: '10.0.0.3' })
  check(r.status === 401 && r.text.includes('Wrong passcode') && !r.headers.get('location'), 'authorize with a bad passcode is refused')
  const tampered = page.p.replace(/^./, (c) => (c === 'e' ? 'f' : 'e'))
  r = await req('/authorize', { method: 'POST', headers: form(), body: enc({ p: tampered, passcode: PASS }), ip: '10.0.0.4' })
  check(r.status === 400 && !r.headers.get('location'), 'authorize with tampered hidden fields is refused')

  const denyHref = /href="(authorize\/deny\?p=[^"]+)"/.exec(page.res.text)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  r = await req('/notes/' + denyHref)
  check(r.status === 302 && /error=access_denied/.test(r.headers.get('location') || '') && /state=st-123/.test(r.headers.get('location') || ''), 'Deny redirects with access_denied and state')

  async function getCode() {
    const k = pkce()
    const pg = await approvePage(k.challenge)
    const res = await req('/authorize', { method: 'POST', headers: form(), body: enc({ p: pg.p, passcode: PASS }), ip: '10.0.0.5' })
    const loc = new URL(res.headers.get('location') || 'http://x/')
    return { res, loc, code: loc.searchParams.get('code'), verifier: k.verifier }
  }
  const tokenReq = (params, asJson = false) =>
    req('/token', {
      method: 'POST',
      headers: asJson ? json : form(),
      body: asJson ? JSON.stringify(params) : enc(params),
    })
  const exchange = (c, verifier = c.verifier, asJson = false) =>
    tokenReq({ grant_type: 'authorization_code', code: c.code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE_PUBLIC}/mcp` }, asJson)

  let a = await getCode()
  check(
    a.res.status === 302 && a.loc.origin + a.loc.pathname === REDIRECT && a.code && a.loc.searchParams.get('state') === 'st-123' && a.loc.searchParams.get('iss') === BASE_PUBLIC,
    'authorize with the right passcode redirects with code, state and iss',
  )
  r = await exchange(a, crypto.randomBytes(32).toString('base64url'))
  check(r.status === 400 && JSON.parse(r.text).error === 'invalid_grant', 'token with the wrong PKCE verifier is invalid_grant')
  r = await exchange(a)
  check(r.status === 400, 'a code is burned after a failed exchange')

  const b = await getCode()
  r = await exchange(b)
  const tb = JSON.parse(r.text)
  check(r.status === 200 && tb.access_token && tb.refresh_token && tb.token_type === 'Bearer' && tb.expires_in === 3600, 'PKCE exchange gives tokens')
  check(r.headers.get('cache-control') === 'no-store', 'token response is no-store')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, tb.access_token)
  check(r.status === 200, 'fresh access token works')
  r = await exchange(b)
  check(r.status === 400 && JSON.parse(r.text).error === 'invalid_grant', 'code reuse is refused')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, tb.access_token)
  check(r.status === 401, 'code reuse revokes the tokens it issued')

  const c = await getCode()
  r = await exchange(c, c.verifier, true)
  const tc = JSON.parse(r.text)
  check(r.status === 200 && tc.access_token, 'token endpoint accepts JSON too')
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: tc.refresh_token, client_id: client.client_id })
  const tc2 = JSON.parse(r.text)
  check(r.status === 200 && tc2.refresh_token && tc2.refresh_token !== tc.refresh_token, 'refresh rotates the refresh token')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, tc2.access_token)
  check(r.status === 200, 'new access token works')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, tc.access_token)
  check(r.status === 401, 'old access token stops working after refresh')
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: tc.refresh_token, client_id: client.client_id })
  check(r.status === 400 && JSON.parse(r.text).error === 'invalid_grant', 'reusing a rotated refresh token is refused')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, tc2.access_token)
  check(r.status === 401, 'refresh reuse revokes the whole grant (access)')
  r = await tokenReq({ grant_type: 'refresh_token', refresh_token: tc2.refresh_token, client_id: client.client_id })
  check(r.status === 400, 'refresh reuse revokes the whole grant (refresh)')
  r = await tokenReq({ grant_type: 'password', username: 'x' })
  check(r.status === 400 && JSON.parse(r.text).error === 'unsupported_grant_type', 'unknown grant type')

  const oauthFile = fs.readFileSync(path.join(appData, 'notesapp', 'phone-oauth.json'), 'utf8')
  check(!oauthFile.includes(tc2.refresh_token) && !oauthFile.includes(tc2.access_token), 'raw tokens are never stored')

  /* ---- MCP ---- */
  const d = await getCode()
  const td = JSON.parse((await exchange(d)).text)
  const T = td.access_token
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } }, T)
  j = JSON.parse(r.text)
  check(r.status === 200 && r.headers.get('content-type').startsWith('application/json'), 'initialize answers JSON')
  check(j.result.protocolVersion === '2025-06-18' && j.result.serverInfo.name === 'notes' && j.result.instructions.includes('notes_guide'), 'initialize negotiates the version and sends instructions')
  r = await rpc({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, T)
  check(JSON.parse(r.text).result.protocolVersion === '2025-11-25', 'unknown version falls back to the latest supported')
  r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, T)
  check(r.status === 202 && r.buf.length === 0, 'notification gets 202')
  r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, T)
  j = JSON.parse(r.text)
  check(j.result.tools.length === 1 && j.result.tools[0].name === 'read_page', 'tools/list comes from the Notes app')
  r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_page', arguments: { page_id: 'p1' } } }, T)
  j = JSON.parse(r.text)
  check(j.result.content[0].text === 'ran read_page for Claude (phone)', 'tools/call is forwarded to Notes')
  check(calls.at(-1) && calls.at(-1).arguments.page_id === 'p1' && calls.at(-1).client === 'Claude (phone)', 'Notes got the arguments and client name')
  r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } }, T)
  j = JSON.parse(r.text)
  check(j.result.isError === true && j.result.content[0].text.startsWith('Error: '), 'a failing tool becomes an isError result')
  r = await rpc({ jsonrpc: '2.0', id: 5, method: 'nope/nope' }, T)
  check(JSON.parse(r.text).error.code === -32601, 'unknown method is -32601')
  r = await rpc([{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 7, method: 'resources/list' }], T)
  j = JSON.parse(r.text)
  check(Array.isArray(j) && j.length === 2 && j[1].result.resources.length === 0, 'batch answers requests only')
  r = await rpc({ jsonrpc: '2.0', id: 8, method: 'prompts/list' }, T)
  check(JSON.parse(r.text).result.prompts.length === 0, 'prompts/list is empty')
  r = await rpc('{not json', T)
  check(r.status === 400 && JSON.parse(r.text).error.code === -32700, 'bad JSON is a parse error')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, T, { origin: 'https://evil.example' })
  check(r.status === 403, 'foreign Origin is 403')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, T, { origin: 'https://claude.ai' })
  check(r.status === 200, 'claude.ai Origin is allowed')
  r = await req('/mcp', { headers: { authorization: `Bearer ${T}` } })
  check(r.status === 405, 'GET /mcp is 405')
  r = await req('/notes/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
  check(r.status === 200, '/notes/mcp works too')

  /* ---- global rate limit (20 wrong passcodes per hour) ---- */
  let fails = 0
  for (let i = 0; i < 40; i++) {
    r = await req('/login', { method: 'POST', headers: form(), body: enc({ passcode: 'nope' }), ip: `10.1.0.${i}` })
    if (r.status !== 401) break
    fails++
  }
  check(r.status === 429 && fails === 20 - 6, `global limit kicks in after 20 failures in total (${fails} more here)`)
  r = await req('/login', { method: 'POST', headers: form(), body: enc({ passcode: PASS }), ip: '10.2.0.1' })
  check(r.status === 429, 'global lockout also blocks a new IP')

  /* ---- reset passcode ---- */
  const reset = spawn(process.execPath, [SERVER, '--reset-passcode'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let resetOut = ''
  reset.stdout.on('data', (c) => (resetOut += c))
  await new Promise((res) => reset.on('exit', res))
  check(state().passcode !== PASS && !resetOut.includes(state().passcode), '--reset-passcode makes a new passcode and does not print it')
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, T)
  check(r.status === 401, '--reset-passcode revokes OAuth tokens in the running server')
  r = await req('/', { headers: { cookie } })
  check(!r.text.includes('Download Notes.apk'), '--reset-passcode signs browsers out')

  /* ---- logging hygiene ---- */
  check(!serverLog.includes(PASS) && !serverLog.includes(T) && !serverLog.includes(OTA) && !serverLog.includes(d.code), 'logs hold no passcode, token or code')
  check(!serverLog.includes('?t=') && !serverLog.includes('state=') && !serverLog.includes('code='), 'logs hold no query strings')
} catch (e) {
  console.error(e.message, "| previous:", lastPath)
  failures++
} finally {
  child.kill()
  fake.close()
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
