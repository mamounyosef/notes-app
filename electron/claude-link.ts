/**
 * Notes for Claude outside the app: the Claude desktop app's chats and
 * Claude Code in a terminal (or the desktop app's Code tab).
 *
 * Both start the small MCP server in notes-mcp.cjs (official MCP stdio
 * transport, registered the documented way: claude_desktop_config.json for
 * the desktop app, `claude mcp add-json --scope user` for Claude Code). It
 * forwards each call to this local endpoint, which runs the tool in the
 * Notes window exactly like the assistant inside Notes does.
 *
 * The endpoint listens on 127.0.0.1 only, on a random port, and needs a
 * random token that changes every start; both are in claude-link.json in
 * this app's own data folder.
 */
import { app, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import SHIM_SOURCE from './notes-mcp.cjs?raw'
import type { ClaudeHost, ToolDef } from './claude'

/** Tools that make no sense from outside: questions go in Claude's own chat. */
const NOT_OUTSIDE = new Set(['ask_user'])

/**
 * Tools that only read or look (the same set as READ_ONLY in src/agent/tools.ts,
 * minus the ones not offered outside). Every other tool changes the notes.
 * focus moves the user's view, so it is also only for when they ask to be shown something.
 */
const OUTSIDE_READS = new Set(['view_image', 'check_drawing', 'read_drawing', 'get_context', 'list_tree', 'read_page', 'read_cell', 'search_notes', 'recent_notes', 'get_settings'])

const WRITE_PREFIX = 'CHANGES the user\'s notes: only when they explicitly asked for this change. '

const GUIDE_TOOL: ToolDef = {
  name: 'notes_guide',
  description:
    'How to work with the Notes app: WHEN you may change notes (only on the user\'s explicit request), its structure (notebooks, sections, pages, cells on a canvas), the Markdown content format, how notes must look, how to draw diagrams and charts, and how to cite notes. Call it once before working with notes.',
  inputSchema: { type: 'object', properties: {}, required: [] },
}

export function setupClaudeLink(host: ClaudeHost, opts: { log(...a: unknown[]): void }) {
  const dataDir = app.getPath('userData')
  const linkFile = path.join(dataDir, 'claude-link.json')
  const toolsCache = path.join(dataDir, 'claude-link-tools.json')
  const shimFile = path.join(dataDir, 'notes-mcp.cjs')
  const token = crypto.randomBytes(24).toString('hex')

  // The bridge Claude runs: kept in this app's data folder so its path never changes between versions.
  try {
    if (!fs.existsSync(shimFile) || fs.readFileSync(shimFile, 'utf8') !== SHIM_SOURCE) fs.writeFileSync(shimFile, SHIM_SOURCE)
  } catch (e: any) {
    opts.log('claude link: could not write the MCP bridge', e?.message)
  }

  // Every tool that changes the notes says so first: Claude outside the app writes only when the user asked.
  const outsideTools = () => [
    GUIDE_TOOL,
    ...host.tools()
      .filter((t) => !NOT_OUTSIDE.has(t.name))
      .map((t) =>
        OUTSIDE_READS.has(t.name)
          ? t
          : t.name === 'focus'
            ? { ...t, description: 'MOVES the user\'s view: only when they ask to be shown something. ' + t.description }
            : { ...t, description: WRITE_PREFIX + t.description },
      ),
  ]

  // Saved so Claude can list the tools while Notes is closed (Notes opens on the first call).
  host.onTools(() => {
    try {
      fs.writeFileSync(toolsCache, JSON.stringify({ tools: outsideTools(), at: Date.now() }))
    } catch {
      /* not essential */
    }
  })

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 20 * 1024 * 1024) req.destroy(new Error('too big'))
        else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers['x-notes-token'] !== token) return json(res, 401, { error: 'bad token' })
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, app: 'notes', pid: process.pid })
      if (req.method === 'GET' && req.url === '/tools') {
        await Promise.race([host.whenTools(), new Promise((r) => setTimeout(r, 15000))])
        return json(res, 200, { tools: outsideTools() })
      }
      if (req.method === 'POST' && req.url === '/call') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const name = String(body.name || '')
        const client = String(body.client || 'Claude').slice(0, 40)
        if (name === GUIDE_TOOL.name) return json(res, 200, { content: [{ type: 'text', text: host.guide() || 'The guide is not loaded yet: open the Notes window and try again.' }] })
        if (NOT_OUTSIDE.has(name)) return json(res, 200, { content: [{ type: 'text', text: 'Ask the user in your own chat instead.' }], isError: true })
        await Promise.race([host.whenTools(), new Promise((r) => setTimeout(r, 15000))])
        if (!host.tools().some((t) => t.name === name)) return json(res, 200, { content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true })
        const out = await host.callTool({ chatId: null, client }, name, body.arguments || {})
        return json(res, 200, await host.toMcp(out))
      }
      json(res, 404, { error: 'not found' })
    } catch (e: any) {
      json(res, 500, { error: e?.message || String(e) })
    }
  })
  // Tool calls can wait on a long drawing check: no server-side timeout.
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      fs.writeFileSync(linkFile, JSON.stringify({ port, token, pid: process.pid, exe: app.isPackaged ? process.execPath : null, at: Date.now() }))
    } catch (e: any) {
      opts.log('claude link: could not write the link file', e?.message)
    }
    opts.log('claude link: listening on', port)
  })
  server.on('error', (e) => opts.log('claude link: server error', e.message))

  /* ---------------- registering with Claude ---------------- */

  /** The command Claude runs: Notes.exe as plain Node, with the bridge and the link file. */
  const entry = () => ({ type: 'stdio', command: process.execPath, args: [shimFile, linkFile], env: { ELECTRON_RUN_AS_NODE: '1' } })

  const desktopConfig = () => {
    const roaming = path.join(process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    if (fs.existsSync(roaming) || process.platform !== 'win32') return roaming
    // Store (MSIX) installs keep it in the package's own copy of AppData when there is none outside.
    const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages')
    try {
      const dir = fs.readdirSync(pk).find((d) => /^Claude_/i.test(d))
      if (dir) {
        const f = path.join(pk, dir, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
        if (fs.existsSync(f)) return f
      }
    } catch {
      /* none */
    }
    return roaming
  }

  function desktopStatus() {
    const file = desktopConfig()
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      const e = j?.mcpServers?.notes
      return { file, connected: Boolean(e), current: Boolean(e && e.command === process.execPath && e.args?.[0] === shimFile) }
    } catch {
      return { file, connected: false, current: false }
    }
  }

  function connectDesktop(on: boolean) {
    const file = desktopConfig()
    let j: any = {}
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e: any) {
      if (fs.existsSync(file)) return { ok: false, error: `Could not read ${file}: ${e?.message}` }
    }
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.notes-backup`)
    const servers = { ...(j.mcpServers || {}) }
    if (on) {
      const { type: _t, ...e } = entry()
      servers.notes = e
    } else delete servers.notes
    j.mcpServers = servers
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(j, null, 2))
    return { ok: true, file }
  }

  const runClaude = (args: string[]) =>
    new Promise<{ ok: boolean; out: string }>(async (resolve) => {
      const info = await host.exeInfo()
      if (!info.path) return resolve({ ok: false, out: 'Claude Code is not installed.' })
      execFile(info.path, args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() }))
    })

  async function codeStatus() {
    const r = await runClaude(['mcp', 'get', 'notes'])
    return { connected: r.ok && /notes/i.test(r.out), current: r.ok && r.out.includes(shimFile) }
  }

  async function connectCode(on: boolean) {
    await runClaude(['mcp', 'remove', 'notes', '--scope', 'user'])
    if (!on) return { ok: true }
    const r = await runClaude(['mcp', 'add-json', 'notes', JSON.stringify(entry()), '--scope', 'user'])
    return r.ok ? { ok: true } : { ok: false, error: r.out || 'claude mcp add-json failed' }
  }

  ipcMain.handle('claude:linkStatus', async () => ({
    packaged: app.isPackaged,
    desktop: desktopStatus(),
    code: await codeStatus().catch(() => ({ connected: false, current: false })),
  }))

  ipcMain.handle('claude:connect', async (_e, target: 'desktop' | 'code', on: boolean) => {
    if (!app.isPackaged && on) return { ok: false, error: 'Connect from the installed Notes app, not a development run.' }
    try {
      return target === 'desktop' ? connectDesktop(on) : await connectCode(on)
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  app.on('before-quit', () => server.close())
}
