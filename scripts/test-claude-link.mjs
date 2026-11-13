// Tests electron/notes-mcp.cjs, the MCP server the Claude app and Claude Code run:
// it speaks MCP (JSON-RPC over stdio) and forwards to a fake Notes endpoint here.
// Usage: node scripts/test-claude-link.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHIM = path.resolve(HERE, '../electron/notes-mcp.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-link-'))
const linkFile = path.join(dir, 'claude-link.json')
const token = 'test-token'
const TOOLS = [{ name: 'read_page', description: 'Read a page.', inputSchema: { type: 'object', properties: { page_id: { type: 'string' } } } }]
const calls = []

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers['x-notes-token'] !== token) return send(401, { error: 'bad token' })
  if (req.url === '/health') return send(200, { ok: true })
  if (req.url === '/tools') return send(200, { tools: TOOLS })
  if (req.url === '/call') {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const body = JSON.parse(b)
      calls.push(body)
      send(200, { content: [{ type: 'text', text: `ran ${body.name} for ${body.client}` }] })
    })
    return
  }
  send(404, {})
})

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

await new Promise((r) => server.listen(0, '127.0.0.1', r))
fs.writeFileSync(linkFile, JSON.stringify({ port: server.address().port, token, pid: process.pid, exe: null }))

const child = spawn(process.execPath, [SHIM, linkFile], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let buf = ''
child.stdout.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    const msg = JSON.parse(line)
    pending.get(msg.id)?.(msg)
  }
})
let id = 0
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const i = ++id
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 10000)
    pending.set(i, (m) => {
      clearTimeout(t)
      resolve(m)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
  })

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1' } })
  check(init.result?.protocolVersion === '2025-06-18', 'initialize echoes a supported protocol version')
  check(Boolean(init.result?.capabilities?.tools), 'initialize declares tools')
  check(/notes_guide/.test(init.result?.instructions || ''), 'instructions point at notes_guide')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const odd = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x' } })
  check(odd.result?.protocolVersion === '2025-11-25', 'unknown version gets the latest supported one')
  const list = await rpc('tools/list', {})
  check(list.result?.tools?.[0]?.name === 'read_page', 'tools/list forwards the app tool list')
  const call = await rpc('tools/call', { name: 'read_page', arguments: { page_id: 'abc' } })
  check(call.result?.content?.[0]?.text === 'ran read_page for x', 'tools/call forwards and returns content')
  check(calls[0]?.arguments?.page_id === 'abc', 'arguments arrive intact')
  const ping = await rpc('ping', {})
  check(ping.result && !ping.error, 'ping answers')
  const unknown = await rpc('nope/method', {})
  check(unknown.error?.code === -32601, 'unknown method is method-not-found')
  // Notes gone: tools/list falls back to the cached list without opening the app.
  fs.writeFileSync(path.join(dir, 'claude-link-tools.json'), JSON.stringify({ tools: [{ name: 'cached_tool', description: '', inputSchema: { type: 'object' } }] }))
  fs.writeFileSync(linkFile, JSON.stringify({ port: 1, token, pid: 999999, exe: null }))
  const cached = await rpc('tools/list', {})
  check(cached.result?.tools?.[0]?.name === 'cached_tool', 'Notes closed: tools/list serves the saved list')
} catch (e) {
  console.log('FAIL', e.message)
  failures++
} finally {
  child.kill()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
