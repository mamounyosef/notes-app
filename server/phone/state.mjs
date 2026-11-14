// Secrets (passcode, OTA token, cookie key), the private links file, and OAuth state.
// Everything lives in %APPDATA%\notesapp, never inside the repo.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WORDS } from './words.mjs'
import { randomToken, sha256hex, writeJsonAtomic } from './util.mjs'

export function dataDir() {
  const dir = path.join(process.env.APPDATA || os.homedir(), 'notesapp')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function makePasscode() {
  const words = Array.from({ length: 4 }, () => WORDS[crypto.randomInt(WORDS.length)])
  return `${words.join('-')}-${String(crypto.randomInt(100)).padStart(2, '0')}`
}

/** Lowercase, trimmed, any spaces or dashes collapsed to one dash (phone keyboards capitalise and add spaces). */
export function normalizePasscode(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_.]+/g, '-')
    .slice(0, 200)
}

/** Reads phone-server.json, creating it on first start; re-read whenever the file changes on disk. */
export class Secrets {
  constructor(file = path.join(dataDir(), 'phone-server.json')) {
    this.file = file
    this.mtime = 0
    this.data = null
    this.get()
  }
  get() {
    let st = null
    try {
      st = fs.statSync(this.file)
    } catch {}
    if (!st) {
      this.data = {
        passcode: makePasscode(),
        otaToken: randomToken(32),
        cookieSecret: crypto.randomBytes(32).toString('base64url'),
        createdAt: new Date().toISOString(),
      }
      writeJsonAtomic(this.file, this.data)
      st = fs.statSync(this.file)
    } else if (!this.data || st.mtimeMs !== this.mtime) {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!d.passcode || !d.otaToken || !d.cookieSecret) throw new Error(`${this.file} is missing fields`)
      this.data = d
    }
    this.mtime = st.mtimeMs
    return this.data
  }
  resetPasscode() {
    const d = { ...this.get(), passcode: makePasscode(), passcodeChangedAt: new Date().toISOString() }
    writeJsonAtomic(this.file, d)
    this.data = null
    return this.get()
  }
  /** Changes when the passcode changes, so a reset also signs out every browser. */
  passcodeEpoch() {
    return sha256hex(`epoch:${this.get().passcode}`).slice(0, 16)
  }
}

export function writePrivateLinks(repoRoot, cfg, passcode) {
  const text = [
    '# PRIVATE LINKS (git-ignored: never commit this file)',
    '',
    'This file is written by server/phone-server.mjs. It holds a secret passcode.',
    '',
    `- APK download page: ${cfg.downloadUrl}`,
    `- MCP connector URL (claude.ai, Settings, Connectors, Add custom connector): ${cfg.mcpUrl}`,
    `- Passcode: \`${passcode}\``,
    '',
    'Reset the passcode (also signs out every browser and disconnects Claude), in a terminal:',
    '',
    '```bash',
    `cd /d "${repoRoot}"`,
    '```',
    '',
    '```bash',
    'npm run phone-server -- --reset-passcode',
    '```',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(repoRoot, 'PRIVATE-LINKS.md'), text, { mode: 0o600 })
}

/* ---------------- OAuth state ---------------- */

const MAX_CLIENTS = 50
const MAX_GRANTS = 200
export const ACCESS_TTL_S = 3600
const REFRESH_TTL_MS = 90 * 24 * 3600 * 1000
const CODE_TTL_MS = 60 * 1000

/**
 * Clients, grants and token hashes, persisted to phone-oauth.json. Raw tokens
 * are never stored: only their SHA-256. Authorization codes live 60 s in memory.
 */
export class OAuthStore {
  constructor(file = path.join(dataDir(), 'phone-oauth.json')) {
    this.file = file
    this.mtime = 0
    this.data = { clients: {}, grants: {} }
    this.codes = new Map() // codeHash -> record
    this.usedCodes = new Map() // codeHash -> { grantId, at }
    this.reload(true)
  }
  reload(force = false) {
    let st = null
    try {
      st = fs.statSync(this.file)
    } catch {}
    if (!st) return
    if (!force && st.mtimeMs === this.mtime) return
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = { clients: d.clients || {}, grants: d.grants || {} }
      this.mtime = st.mtimeMs
    } catch (e) {
      console.error('phone-oauth.json unreadable, starting empty:', e.message)
    }
  }
  save() {
    const now = Date.now()
    for (const [id, g] of Object.entries(this.data.grants)) if (g.refreshExp < now) delete this.data.grants[id]
    const grants = Object.entries(this.data.grants)
    if (grants.length > MAX_GRANTS) {
      grants.sort((a, b) => a[1].created - b[1].created)
      for (const [id] of grants.slice(0, grants.length - MAX_GRANTS)) delete this.data.grants[id]
    }
    writeJsonAtomic(this.file, this.data)
    try {
      this.mtime = fs.statSync(this.file).mtimeMs
    } catch {}
  }

  registerClient({ redirect_uris, client_name }) {
    this.reload()
    const client_id = randomToken(18)
    const client = { client_id, redirect_uris, client_name, created: Date.now() }
    this.data.clients[client_id] = client
    const list = Object.values(this.data.clients)
    if (list.length > MAX_CLIENTS) {
      list.sort((a, b) => a.created - b.created)
      for (const c of list.slice(0, list.length - MAX_CLIENTS)) delete this.data.clients[c.client_id]
    }
    this.save()
    return client
  }
  getClient(id) {
    this.reload()
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(this.data.clients, id)) return null
    return this.data.clients[id]
  }

  issueCode(rec) {
    const now = Date.now()
    for (const [h, c] of this.codes) if (c.exp < now) this.codes.delete(h)
    for (const [h, u] of this.usedCodes) if (now - u.at > 10 * 60 * 1000) this.usedCodes.delete(h)
    const code = randomToken(32)
    this.codes.set(sha256hex(code), { ...rec, exp: now + CODE_TTL_MS })
    return code
  }
  /** One-time: a code is gone after the first try. Reusing a redeemed code revokes what it issued. */
  consumeCode(code) {
    if (typeof code !== 'string' || !code) return { error: 'invalid_grant' }
    const h = sha256hex(code)
    const used = this.usedCodes.get(h)
    if (used) {
      if (used.grantId) this.revokeGrant(used.grantId)
      return { error: 'invalid_grant', reused: true }
    }
    const rec = this.codes.get(h)
    this.codes.delete(h)
    if (!rec) return { error: 'invalid_grant' }
    this.usedCodes.set(h, { grantId: null, at: Date.now() })
    if (rec.exp < Date.now()) return { error: 'invalid_grant' }
    return { rec, mark: (grantId) => this.usedCodes.set(h, { grantId, at: Date.now() }) }
  }

  createGrant(client_id, resource) {
    this.reload()
    const grantId = randomToken(12)
    const g = { client_id, resource, created: Date.now(), rotated: [] }
    this.data.grants[grantId] = g
    const tokens = this.#mint(g)
    this.save()
    return { grantId, tokens }
  }
  #mint(g) {
    const access = randomToken(32)
    const refresh = randomToken(32)
    g.accessHash = sha256hex(access)
    g.accessExp = Date.now() + ACCESS_TTL_S * 1000
    g.refreshHash = sha256hex(refresh)
    g.refreshExp = Date.now() + REFRESH_TTL_MS
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh }
  }
  refresh(token, client_id) {
    this.reload()
    if (typeof token !== 'string' || !token) return { error: 'invalid_grant' }
    const h = sha256hex(token)
    const now = Date.now()
    for (const [id, g] of Object.entries(this.data.grants)) {
      if (g.refreshHash === h) {
        if (g.refreshExp < now) return { error: 'invalid_grant' }
        if (client_id && client_id !== g.client_id) return { error: 'invalid_grant' }
        g.rotated = [...(g.rotated || []), h].slice(-20)
        const tokens = this.#mint(g)
        this.save()
        return { tokens }
      }
      if ((g.rotated || []).includes(h)) {
        // A rotated refresh token came back: it was stolen or replayed. End the whole grant.
        delete this.data.grants[id]
        this.save()
        console.warn('Refresh token reuse detected: grant revoked')
        return { error: 'invalid_grant' }
      }
    }
    return { error: 'invalid_grant' }
  }
  verifyAccess(token, resource) {
    this.reload()
    if (typeof token !== 'string' || !token) return null
    const h = sha256hex(token)
    const now = Date.now()
    for (const g of Object.values(this.data.grants))
      if (g.accessHash === h) return g.accessExp > now && g.resource === resource ? g : null
    return null
  }
  revokeGrant(id) {
    this.reload()
    if (this.data.grants[id]) {
      delete this.data.grants[id]
      this.save()
    }
  }
  revokeAll() {
    this.reload()
    this.data.grants = {}
    this.codes.clear()
    this.save()
  }
}
