// OAuth 2.1 authorization server for the remote MCP endpoint (MCP authorization spec):
// RFC 9728 resource metadata, RFC 8414 server metadata, RFC 7591 registration,
// PKCE S256 only, RFC 8707 resource binding, refresh token rotation with reuse detection.
import { authorizePage, messagePage } from './pages.mjs'
import { normalizePasscode } from './state.mjs'
import { DEFAULT_CSP, HttpError, clientIp, hmac, readBody, readParams, redirect, safeEqual, sendHtml, sendJson, sha256 } from './util.mjs'

const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/
const SIGNED_TTL_MS = 15 * 60 * 1000
const CORS = { 'access-control-allow-origin': '*' }

export function createOAuth({ cfg, secrets, store, limiter, registerLimiter }) {
  const base = cfg.publicUrl
  const resource = `${base}/mcp`

  function redirectAllowed(uri) {
    if (typeof uri !== 'string' || uri.length > 2000) return false
    if (CLAUDE_CALLBACKS.includes(uri)) return true
    if (!cfg.allowLoopback) return false
    try {
      const u = new URL(uri)
      return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.username && !u.password && !u.hash
    } catch {
      return false
    }
  }

  function passcodeOk(input) {
    return safeEqual(normalizePasscode(input), normalizePasscode(secrets.get().passcode))
  }

  /* ---- metadata ---- */

  const protectedResource = () => ({
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_name: 'Notes',
  })
  const serverMetadata = () => ({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  })

  /* ---- signed hidden fields for the approval form ---- */

  const sign = (obj) => {
    const payload = Buffer.from(JSON.stringify({ ...obj, iat: Date.now() })).toString('base64url')
    return `${payload}.${hmac(secrets.get().cookieSecret, `authorize:${payload}`)}`
  }
  const unsign = (s) => {
    if (typeof s !== 'string' || s.length > 8000) return null
    const i = s.lastIndexOf('.')
    if (i < 1) return null
    const payload = s.slice(0, i)
    if (!safeEqual(s.slice(i + 1), hmac(secrets.get().cookieSecret, `authorize:${payload}`))) return null
    try {
      const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (!obj || Date.now() - obj.iat > SIGNED_TTL_MS || obj.iat > Date.now() + 60000) return null
      return obj
    } catch {
      return null
    }
  }

  function withParams(uri, params) {
    const u = new URL(uri)
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v)
    return u.toString()
  }

  /**
   * Validates an authorization request. Returns { ok, req } or, when the error can
   * safely go back to the client, { redirectTo }; otherwise { page } (bad client or redirect).
   */
  function validate(p) {
    const client = store.getClient(p.client_id)
    if (!client) return { page: 'Unknown app. Remove the connector in Claude and add it again.' }
    let redirectUri = p.redirect_uri
    if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0]
    if (typeof redirectUri !== 'string' || !client.redirect_uris.includes(redirectUri) || !redirectAllowed(redirectUri))
      return { page: 'The return address does not match the registered app.' }
    const back = (error, error_description) => ({
      redirectTo: withParams(redirectUri, { error, error_description, state: p.state, iss: base }),
    })
    if (p.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code')
    if (typeof p.code_challenge !== 'string' || !PKCE_RE.test(p.code_challenge)) return back('invalid_request', 'code_challenge is required')
    if (p.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256')
    if (p.resource !== undefined && p.resource !== '' && p.resource !== resource) return back('invalid_target', 'Unknown resource')
    if (typeof p.state === 'string' && p.state.length > 2000) return back('invalid_request', 'state too long')
    return {
      ok: true,
      client,
      req: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        state: typeof p.state === 'string' ? p.state : '',
        code_challenge: p.code_challenge,
        resource,
      },
    }
  }

  const pageCsp = (redirectUri) => {
    let origin = ''
    try {
      origin = new URL(redirectUri).origin
    } catch {}
    return origin ? DEFAULT_CSP.replace("form-action 'self'", `form-action 'self' ${origin}`) : DEFAULT_CSP
  }

  function renderApprove(res, status, v, error) {
    const signed = sign(v.req)
    sendHtml(res, status, authorizePage({ clientName: v.client.client_name, signed, error, denyHref: `authorize/deny?p=${encodeURIComponent(signed)}` }), {
      csp: pageCsp(v.req.redirect_uri),
    })
  }

  const tokenError = (res, status, error, error_description) =>
    sendJson(res, status, { error, ...(error_description ? { error_description } : {}) }, { 'cache-control': 'no-store', pragma: 'no-cache', ...CORS })

  /* ---- routes ---- */

  return async function route(req, res, path, url) {
    const m = req.method === 'HEAD' ? 'GET' : req.method

    if (m === 'OPTIONS' && /^\/(\.well-known\/|register$|token$)/.test(path)) {
      res.writeHead(204, {
        ...CORS,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
        'access-control-max-age': '86400',
      })
      res.end()
      return true
    }

    if (m === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      sendJson(res, 200, protectedResource(), CORS)
      return true
    }
    if (m === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')) {
      sendJson(res, 200, serverMetadata(), CORS)
      return true
    }

    if (path === '/register') {
      if (m !== 'POST') return tokenError(res, 405, 'invalid_request', 'POST only'), true
      const ip = clientIp(req)
      if (registerLimiter.blocked(ip)) return tokenError(res, 429, 'invalid_request', 'Too many registrations. Try again later.'), true
      registerLimiter.fail(ip)
      let body
      try {
        const raw = await readJsonObject(req)
        body = raw
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid_client_metadata', error_description: e.message }, CORS), true
      }
      const uris = body.redirect_uris
      if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(redirectAllowed))
        return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be the Claude callback' }, CORS), true
      const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'Claude'
      const client = store.registerClient({ redirect_uris: uris, client_name: name })
      console.log(`Registered OAuth client "${name}"`)
      sendJson(
        res,
        201,
        {
          client_id: client.client_id,
          client_id_issued_at: Math.floor(client.created / 1000),
          client_name: name,
          redirect_uris: uris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        { 'cache-control': 'no-store', ...CORS },
      )
      return true
    }

    if (path === '/authorize' && m === 'GET') {
      const v = validate(Object.fromEntries(url.searchParams))
      if (v.page) return sendHtml(res, 400, messagePage('Cannot connect', v.page)), true
      if (v.redirectTo) return redirect(res, v.redirectTo), true
      const blocked = limiter.blocked(clientIp(req))
      renderApprove(res, 200, v, blocked ? 'Too many wrong passcodes. Wait a while, then try again.' : undefined)
      return true
    }

    if (path === '/authorize/deny' && m === 'GET') {
      const signed = unsign(url.searchParams.get('p'))
      const v = signed && validate({ ...signed, response_type: 'code', code_challenge_method: 'S256' })
      if (!v || !v.ok) return sendHtml(res, 400, messagePage('Cannot connect', 'This request expired. Start again from Claude.')), true
      redirect(res, withParams(v.req.redirect_uri, { error: 'access_denied', state: v.req.state, iss: base }))
      return true
    }

    if (path === '/authorize' && m === 'POST') {
      const form = await readParams(req)
      const signed = unsign(form.p)
      const v = signed && validate({ ...signed, response_type: 'code', code_challenge_method: 'S256' })
      if (!v || !v.ok) return sendHtml(res, 400, messagePage('Cannot connect', 'This request expired. Start again from Claude.')), true
      const ip = clientIp(req)
      if (limiter.blocked(ip)) {
        console.warn(`Passcode blocked (rate limit) for ${ip} on /authorize`)
        return renderApprove(res, 429, v, 'Too many wrong passcodes. Wait a while, then try again.'), true
      }
      if (!passcodeOk(form.passcode)) {
        limiter.fail(ip)
        console.warn(`Wrong passcode from ${ip} on /authorize`)
        return renderApprove(res, 401, v, 'Wrong passcode.'), true
      }
      limiter.succeed(ip)
      const code = store.issueCode(v.req)
      console.log(`Approved Claude connection for "${v.client.client_name}"`)
      redirect(res, withParams(v.req.redirect_uri, { code, state: v.req.state, iss: base }))
      return true
    }

    if (path === '/token') {
      if (m !== 'POST') return tokenError(res, 405, 'invalid_request', 'POST only'), true
      let p
      try {
        p = await readParams(req)
      } catch (e) {
        if (e instanceof HttpError && e.status === 413) throw e
        return tokenError(res, 400, 'invalid_request', 'Unreadable body'), true
      }
      if (p.grant_type === 'authorization_code') {
        if (!p.code || !p.code_verifier || !p.client_id) return tokenError(res, 400, 'invalid_request', 'code, code_verifier and client_id are required'), true
        const r = store.consumeCode(p.code)
        if (r.error) return tokenError(res, 400, 'invalid_grant', r.reused ? 'Code already used' : 'Invalid or expired code'), true
        const rec = r.rec
        if (p.client_id !== rec.client_id) return tokenError(res, 400, 'invalid_grant', 'Client mismatch'), true
        if ((p.redirect_uri || rec.redirect_uri) !== rec.redirect_uri) return tokenError(res, 400, 'invalid_grant', 'redirect_uri mismatch'), true
        if (p.resource && p.resource !== rec.resource) return tokenError(res, 400, 'invalid_target', 'Unknown resource'), true
        if (!PKCE_RE.test(p.code_verifier) || !safeEqual(sha256(p.code_verifier).toString('base64url'), rec.code_challenge))
          return tokenError(res, 400, 'invalid_grant', 'PKCE verification failed'), true
        const { grantId, tokens } = store.createGrant(rec.client_id, rec.resource)
        r.mark(grantId)
        sendJson(res, 200, tokens, { 'cache-control': 'no-store', pragma: 'no-cache', ...CORS })
        return true
      }
      if (p.grant_type === 'refresh_token') {
        if (p.resource && p.resource !== resource) return tokenError(res, 400, 'invalid_target', 'Unknown resource'), true
        const r = store.refresh(p.refresh_token, p.client_id)
        if (r.error) return tokenError(res, 400, 'invalid_grant', 'Invalid refresh token'), true
        sendJson(res, 200, r.tokens, { 'cache-control': 'no-store', pragma: 'no-cache', ...CORS })
        return true
      }
      return tokenError(res, 400, 'unsupported_grant_type'), true
    }

    return false
  }

  async function readJsonObject(req) {
    const buf = await readBody(req)
    let obj
    try {
      obj = JSON.parse(buf.toString('utf8'))
    } catch {
      throw new Error('Body must be JSON')
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Body must be a JSON object')
    return obj
  }
}

/** The bearer check for /mcp: the grant, or a 401 description. */
export function bearerCheck(req, store, cfg) {
  const h = String(req.headers.authorization || '')
  const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(h.trim())
  const challenge = `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`
  if (!m) return { challenge }
  const grant = store.verifyAccess(m[1], `${cfg.publicUrl}/mcp`)
  if (!grant) return { challenge: `${challenge}, error="invalid_token", error_description="The access token is invalid or expired"` }
  return { grant }
}
