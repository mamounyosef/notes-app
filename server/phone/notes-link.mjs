// Client for the running Notes desktop app, the same private local link that
// electron/notes-mcp.cjs uses: %APPDATA%\notesapp\claude-link.json gives {port, token, pid, exe}.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const CLIENT = 'Claude (phone)'
const CALL_TIMEOUT_MS = 10 * 60 * 1000

const linkFile = () => path.join(process.env.APPDATA || os.homedir(), 'notesapp', 'claude-link.json')
const toolsCache = () => path.join(path.dirname(linkFile()), 'claude-link-tools.json')

function readLink() {
  try {
    return JSON.parse(fs.readFileSync(linkFile(), 'utf8'))
  } catch {
    return null
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && e.code === 'EPERM')
  }
}

function request(link, method, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port: link.port,
        path: route,
        method,
        headers: { 'x-notes-token': link.token, 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) return reject(new Error(`Notes answered ${res.statusCode}: ${text.slice(0, 300)}`))
          try {
            resolve(JSON.parse(text))
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('Notes did not answer in time')))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function reachable(link) {
  if (!link || !link.port || !alive(link.pid)) return false
  try {
    const h = await request(link, 'GET', '/health', undefined, 3000)
    return Boolean(h && h.ok)
  } catch {
    return false
  }
}

let launching = null
/** The running app's link, opening Notes first when it is closed (waits up to 45 s). */
export async function ensureApp() {
  const link = readLink()
  if (await reachable(link)) return link
  if (!launching)
    launching = (async () => {
      const exe = link && link.exe
      if (!exe || !fs.existsSync(exe)) throw new Error('Notes is not running on the PC, and it could not be opened from here.')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      spawn(exe, [], { detached: true, stdio: 'ignore', env, windowsHide: false }).unref()
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const l = readLink()
        if (await reachable(l)) return l
      }
      throw new Error('Notes did not start. Open the Notes app on the PC and try again.')
    })().finally(() => {
      launching = null
    })
  return launching
}

function cachedTools() {
  try {
    return JSON.parse(fs.readFileSync(toolsCache(), 'utf8')).tools || []
  } catch {
    return []
  }
}

export async function listTools() {
  const link = readLink()
  if (await reachable(link)) {
    const r = await request(link, 'GET', '/tools', undefined, 10000)
    return r.tools || []
  }
  const cached = cachedTools()
  if (cached.length) return cached
  const l = await ensureApp()
  return (await request(l, 'GET', '/tools', undefined, 10000)).tools || []
}

export async function callTool(name, args) {
  const link = await ensureApp()
  return request(link, 'POST', '/call', { name, arguments: args || {}, client: CLIENT }, CALL_TIMEOUT_MS)
}
