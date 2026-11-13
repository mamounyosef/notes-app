/**
 * Claude in Notes.
 *
 * Runs the Claude Code program already installed on this computer, unchanged
 * and signed in with the user's own Claude plan, through Anthropic's official
 * Agent SDK. Nothing here sees or stores the user's login: Claude Code signs
 * in by itself.
 *
 * - Each chat gets one Claude Code process while it is in use. It stays open
 *   between messages (no start-up wait, same conversation) and closes after
 *   a while idle, so nothing runs in the background for long.
 * - The app's note tools reach Claude as an in-process MCP server named
 *   "notes". Every call runs in the window, the same code the other models'
 *   tool calls run, so undo, the change list and the reveal all work.
 * - Claude Code's own WebSearch and WebFetch are on; Read is on only for
 *   files the user attached (copied into this app's own work folder).
 * - Its conversations are kept in a folder of their own, apart from the
 *   user's coding projects, and are deleted with the chat.
 *
 * The same tools are offered to the Claude desktop app and to Claude Code in
 * a terminal through a small local MCP server (see claude-link.ts).
 */
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { query, createSdkMcpServer, deleteSession, type Query, type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** A note tool as the window describes it (MCP shape: JSON Schema input). */
export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** What a tool call gave back, from the window. */
export interface ToolOutcome {
  ok: boolean
  content: string
  /** Pictures for Claude to see: "sha:<hash>" chat blobs or plain base64 PNG. */
  images?: string[]
}

/** Who called a tool: a chat in this app, or Claude outside it (desktop app, terminal). */
export interface ToolOrigin {
  chatId: string | null
  /** For calls from outside: "Claude Desktop", "Claude Code"... */
  client?: string
}

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One message to send, with how to continue the conversation. */
interface SendSpec {
  chatId: string
  model: string
  effort: Effort
  /** Thinking switched off (only where the model allows it). */
  noThinking: boolean
  system: string
  /** The user turn: Messages API content blocks. */
  content: any[]
  /** Continue this Claude Code session; at = the chain entry to continue from, fork = branch off there. */
  resume?: { session: string; at?: string; fork?: boolean } | null
  title?: string
}

interface Live {
  chatId: string
  q: Query
  push(m: SDKUserMessage): void
  end(): void
  sessionId: string | null
  /** The last chain entry seen: where this process's conversation stands. */
  tip: string | null
  model: string
  effort: Effort
  noThinking: boolean
  system: string
  closed: boolean
  turn: Turn | null
  idle: NodeJS.Timeout | null
  /** Set by the first assistant message of a turn: no more model or effort changes for it. */
  started: boolean
}

interface Turn {
  reqId: string
  aborted: boolean
  resolve(r: TurnResult): void
}

export interface TurnResult {
  ok: boolean
  aborted?: boolean
  error?: string
  sessionId?: string | null
  tip?: string | null
  result?: any
}

/** How long a chat's Claude Code process stays open after its last reply. */
const IDLE_MS = 12 * 60_000

export function setupClaude(opts: {
  getWin(): BrowserWindow | null
  log(...a: unknown[]): void
  readBlob(sha: string): Promise<Buffer | null>
}) {
  const workDir = path.join(app.getPath('userData'), 'claude')
  const filesDir = path.join(workDir, 'files')
  fs.mkdirSync(filesDir, { recursive: true })

  const send = (channel: string, ...args: unknown[]) => {
    const w = opts.getWin()
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }

  /* ---------------- finding Claude Code ---------------- */

  let exeCache: { path: string | null; version: string | null } | null = null

  function findExe(): string | null {
    const env = process.env.NOTES_CLAUDE_PATH
    if (env && fs.existsSync(env)) return env
    const candidates: string[] = []
    try {
      const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
      candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    } catch {
      /* not on PATH */
    }
    const home = os.homedir()
    candidates.push(path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'))
    if (process.platform === 'win32') candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'))
    // A real program only: npm's claude.cmd needs a shell, which the SDK does not use.
    return candidates.find((c) => fs.existsSync(c) && (process.platform !== 'win32' || /\.exe$/i.test(c))) || null
  }

  async function exeInfo(fresh = false) {
    if (exeCache && !fresh) return exeCache
    const p = findExe()
    let version: string | null = null
    if (p)
      version = await new Promise<string | null>((res) =>
        execFile(p, ['--version'], { windowsHide: true, timeout: 15000 }, (err, out) => res(err ? null : String(out).trim().split(/\s+/)[0] || null)),
      )
    exeCache = { path: p, version }
    return exeCache
  }

  /* ---------------- tools, run in the window ---------------- */

  let toolDefs: ToolDef[] = []
  let guide = ''
  let toolsReady: () => void
  const toolsKnown = new Promise<void>((r) => (toolsReady = r))
  const listeners = new Set<(defs: ToolDef[]) => void>()

  ipcMain.handle('claude:setTools', (_e, defs: ToolDef[], guideText: string) => {
    toolDefs = Array.isArray(defs) ? defs : []
    guide = String(guideText || '')
    toolsReady()
    for (const l of listeners) l(toolDefs)
    return true
  })

  const pendingCalls = new Map<string, (r: ToolOutcome) => void>()
  const watched = new WeakSet<WebContents>()

  ipcMain.on('claude:toolResult', (_e, callId: string, r: ToolOutcome) => pendingCalls.get(callId)?.(r))

  /** A reload or crash of the window ends every call waiting on it. */
  function watch(wc: WebContents) {
    if (watched.has(wc)) return
    watched.add(wc)
    const failAll = (why: string) => {
      for (const [id, done] of [...pendingCalls]) {
        pendingCalls.delete(id)
        done({ ok: false, content: `Error: ${why}` })
      }
    }
    // Only the window itself reloading counts: drawings load in frames of their own all the time.
    wc.on('did-start-navigation', (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) failAll('the Notes window reloaded while the tool ran. Try the call again.')
    })
    wc.on('render-process-gone', () => failAll('the Notes window stopped while the tool ran.'))
  }

  /** Runs one note tool in the window and waits for its result. */
  async function callTool(origin: ToolOrigin, name: string, args: unknown, toolUseId?: string): Promise<ToolOutcome> {
    const w = opts.getWin()
    if (!w || w.isDestroyed()) return { ok: false, content: 'Error: the Notes window is not open.' }
    watch(w.webContents)
    const callId = crypto.randomUUID()
    return new Promise<ToolOutcome>((resolve) => {
      pendingCalls.set(callId, (r) => {
        pendingCalls.delete(callId)
        resolve(r && typeof r.content === 'string' ? r : { ok: false, content: 'Error: no result from the window.' })
      })
      w.webContents.send('claude:tool', { callId, chatId: origin.chatId, client: origin.client || null, name, args: args || {}, toolUseId: toolUseId || null })
    })
  }

  const mimeOf = (b: Buffer) =>
    b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.slice(0, 4).toString() === 'GIF8' ? 'image/gif' : b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png'

  /** A tool outcome as MCP content: the text, then the pictures as real images. */
  async function toMcp(r: ToolOutcome) {
    const content: any[] = [{ type: 'text', text: r.content || (r.ok ? 'Done.' : 'Error.') }]
    for (const ref of (r.images || []).slice(0, 8)) {
      let buf: Buffer | null = null
      if (String(ref).startsWith('sha:')) buf = await opts.readBlob(String(ref).slice(4)).catch(() => null)
      else buf = Buffer.from(String(ref).replace(/^data:[^,]*,/, ''), 'base64')
      if (buf?.length) content.push({ type: 'image', data: buf.toString('base64'), mimeType: mimeOf(buf) })
    }
    return { content, isError: !r.ok }
  }

  /** The "notes" MCP server one chat's Claude Code process talks to. */
  function notesServer(chatId: string) {
    const cfg = createSdkMcpServer({ name: 'notes', version: '1.0.0', alwaysLoad: true })
    const srv = (cfg.instance as any).server
    srv.registerCapabilities({ tools: { listChanged: false } })
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })) }))
    srv.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const p = req.params || {}
      // The SDK hands over the call as soon as it reads it; let the message that asked for it reach the window first.
      await new Promise((r) => setTimeout(r, 25))
      const out = await callTool({ chatId }, String(p.name), p.arguments || {}, p._meta?.['claudecode/toolUseId'])
      return toMcp(out)
    })
    return cfg
  }

  /* ---------------- plan limits ---------------- */

  /** The latest plan usage windows, from rate limit events and the /usage data. */
  let limits: any = null
  let limitsAt = 0
  const setLimits = (l: any) => {
    limits = { ...(limits || {}), ...l, at: Date.now() }
    limitsAt = Date.now()
    send('claude:limits', limits)
  }

  function fromRateEvent(info: any) {
    const w = info?.unifiedWindows || {}
    const out: any = {}
    for (const [k, v] of Object.entries<any>(w)) out[k] = { pct: Math.round((Number(v?.utilization) || 0) * 100), resetsAt: v?.resetsAt ? Number(v.resetsAt) * 1000 : null, status: v?.status || null }
    if (!Object.keys(out).length && info?.rateLimitType) out[info.rateLimitType] = { pct: info.utilization !== undefined ? Math.round(info.utilization * 100) : null, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null, status: info.status }
    out.status = info?.status || null
    return out
  }

  function fromUsage(u: any) {
    const rl = u?.rate_limits || {}
    const out: any = { plan: u?.subscription_type || null }
    const win = (v: any) => (v ? { pct: v.utilization ?? null, resetsAt: v.resets_at ? Date.parse(v.resets_at) : null } : null)
    if (rl.five_hour) out.five_hour = win(rl.five_hour)
    if (rl.seven_day) out.seven_day = win(rl.seven_day)
    if (rl.seven_day_opus) out.seven_day_opus = win(rl.seven_day_opus)
    if (rl.seven_day_sonnet) out.seven_day_sonnet = win(rl.seven_day_sonnet)
    const rows = u?.rate_limits?.seven_day_breakdown?.rows
    if (Array.isArray(rows)) out.breakdown = rows.map((r: any) => ({ name: r.display_name, pct: r.percent }))
    return out
  }

  /* ---------------- live sessions ---------------- */

  const lives = new Map<string, Live>()

  function inbox() {
    const items: SDKUserMessage[] = []
    let wake: (() => void) | null = null
    let done = false
    const iter = (async function* () {
      for (;;) {
        while (items.length) yield items.shift()!
        if (done) return
        await new Promise<void>((r) => (wake = r))
        wake = null
      }
    })()
    return {
      iter,
      push(m: SDKUserMessage) {
        items.push(m)
        wake?.()
      },
      end() {
        done = true
        wake?.()
      },
    }
  }

  const inFiles = (p: string) => {
    const r = path.resolve(p)
    return r === filesDir || r.startsWith(filesDir + path.sep)
  }

  async function start(spec: SendSpec, exe: string): Promise<Live> {
    const box = inbox()
    const options: Options = {
      pathToClaudeCodeExecutable: exe,
      cwd: workDir,
      model: spec.model,
      effort: spec.effort,
      thinking: spec.noThinking ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' },
      systemPrompt: spec.system,
      // Nothing from the user's own Claude Code setup (CLAUDE.md, hooks, plugins, other MCP servers): this is the notes assistant.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { notes: notesServer(spec.chatId) },
      tools: ['WebSearch', 'WebFetch', 'Read'],
      permissionMode: 'default',
      canUseTool: async (name, input) => {
        if (name.startsWith('mcp__notes__') || name === 'WebSearch' || name === 'WebFetch') return { behavior: 'allow', updatedInput: input }
        if (name === 'Read' && inFiles(String((input as any)?.file_path || ''))) return { behavior: 'allow', updatedInput: input }
        return { behavior: 'deny', message: name === 'Read' ? 'Only files the user attached can be read here.' : `${name} is not available in Notes.` }
      },
      includePartialMessages: true,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'notes-app/1.0' },
      stderr: (d) => opts.log('claude stderr', d.slice(0, 400)),
      ...(spec.title ? { title: spec.title } : {}),
    }
    if (spec.resume?.session) {
      options.resume = spec.resume.session
      if (spec.resume.fork) {
        options.forkSession = true
        if (spec.resume.at) options.resumeSessionAt = spec.resume.at
      }
    }
    const q = query({ prompt: box.iter, options })
    const live: Live = {
      chatId: spec.chatId,
      q,
      push: box.push,
      end: box.end,
      sessionId: spec.resume?.fork ? null : spec.resume?.session || null,
      tip: spec.resume?.fork ? spec.resume.at || null : spec.resume?.at || null,
      model: spec.model,
      effort: spec.effort,
      noThinking: spec.noThinking,
      system: spec.system,
      closed: false,
      turn: null,
      idle: null,
      started: false,
    }
    lives.set(spec.chatId, live)
    consume(live)
    return live
  }

  function close(live: Live, why: string) {
    if (live.closed) return
    live.closed = true
    if (live.idle) clearTimeout(live.idle)
    opts.log('claude: closing session', live.chatId, why)
    try {
      live.end()
      live.q.close()
    } catch {
      /* already gone */
    }
    if (lives.get(live.chatId) === live) lives.delete(live.chatId)
  }

  function armIdle(live: Live) {
    if (live.idle) clearTimeout(live.idle)
    live.idle = setTimeout(() => close(live, 'idle'), IDLE_MS)
  }

  /** Trims a message to what the window needs. */
  function slim(m: any): any {
    switch (m.type) {
      case 'stream_event':
        return { type: m.type, event: m.event, parent: m.parent_tool_use_id || null }
      case 'assistant':
        return {
          type: m.type,
          uuid: m.uuid,
          parent: m.parent_tool_use_id || null,
          error: m.error,
          message: { id: m.message?.id, model: m.message?.model, content: m.message?.content, usage: m.message?.usage, stop_reason: m.message?.stop_reason },
        }
      case 'user': {
        const content = Array.isArray(m.message?.content)
          ? m.message.content.map((b: any) =>
              b?.type === 'tool_result'
                ? {
                    type: 'tool_result',
                    tool_use_id: b.tool_use_id,
                    is_error: b.is_error,
                    text: (Array.isArray(b.content) ? b.content.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : String(b.content ?? '')).slice(0, 6000),
                  }
                : { type: b?.type },
            )
          : []
        return { type: m.type, uuid: m.uuid, parent: m.parent_tool_use_id || null, content }
      }
      case 'result':
        return {
          type: m.type,
          subtype: m.subtype,
          is_error: m.is_error,
          result: typeof m.result === 'string' ? m.result.slice(0, 4000) : undefined,
          errors: m.errors,
          usage: m.usage,
          modelUsage: m.modelUsage,
          total_cost_usd: m.total_cost_usd,
          duration_ms: m.duration_ms,
          num_turns: m.num_turns,
          terminal_reason: m.terminal_reason,
          session_id: m.session_id,
        }
      case 'system':
        if (m.subtype === 'init') return { type: m.type, subtype: m.subtype, model: m.model, session_id: m.session_id, tools: m.tools, version: m.claude_code_version }
        return { type: m.type, subtype: m.subtype, status: m.status, compact_metadata: m.compact_metadata, attempt: m.attempt, max_retries: m.max_retries, retry_delay_ms: m.retry_delay_ms, error: m.error, error_status: m.error_status }
      case 'rate_limit_event':
        return { type: m.type, info: m.rate_limit_info }
      default:
        return { type: m.type, subtype: m.subtype }
    }
  }

  function finishTurn(live: Live, r: TurnResult) {
    const t = live.turn
    live.turn = null
    live.started = false
    if (t) t.resolve({ ...r, aborted: r.aborted || t.aborted, sessionId: live.sessionId, tip: live.tip })
  }

  async function consume(live: Live) {
    try {
      for await (const m of live.q as AsyncIterable<SDKMessage>) {
        const anyM = m as any
        if (anyM.session_id && (anyM.type === 'system' || anyM.type === 'result' || anyM.type === 'assistant')) live.sessionId = anyM.session_id
        if ((anyM.type === 'assistant' || anyM.type === 'user') && anyM.uuid && !anyM.parent_tool_use_id) live.tip = anyM.uuid
        if (anyM.type === 'assistant') live.started = true
        if (anyM.type === 'rate_limit_event') setLimits(fromRateEvent(anyM.rate_limit_info))
        if (live.turn) send('claude:event', live.turn.reqId, slim(anyM))
        if (anyM.type === 'result') {
          const ok = anyM.subtype === 'success' && !anyM.is_error
          finishTurn(live, {
            ok,
            error: ok ? undefined : (anyM.errors || []).join('; ') || (typeof anyM.result === 'string' ? anyM.result : '') || anyM.subtype,
            result: slim(anyM),
          })
          armIdle(live)
          contextOf(live).catch(() => {})
        }
      }
      finishTurn(live, { ok: false, error: 'Claude Code stopped.' })
    } catch (e: any) {
      const msg = e?.message || String(e)
      opts.log('claude: session ended with error', live.chatId, msg)
      finishTurn(live, { ok: false, error: msg })
    } finally {
      close(live, 'process ended')
    }
  }

  /** Sends what fills this chat's context window to the window. */
  async function contextOf(live: Live) {
    if (live.closed) return null
    const cu: any = await live.q.getContextUsage({ detail: 'summary' })
    const ctx = {
      sessionId: live.sessionId,
      total: cu.totalTokens,
      max: cu.maxTokens,
      rawMax: cu.rawMaxTokens,
      pct: cu.percentage,
      model: cu.model,
      parts: (cu.categories || []).filter((c: any) => c.tokens > 0).map((c: any) => ({ name: c.name, tokens: c.tokens, color: c.color })),
      autoCompact: cu.isAutoCompactEnabled ?? null,
      at: Date.now(),
    }
    send('claude:ctx', live.chatId, ctx)
    return ctx
  }

  /** Can the chat's open process take this message as it stands? */
  function reusable(live: Live | undefined, spec: SendSpec): live is Live {
    if (!live || live.closed || live.turn) return false
    if (live.noThinking !== spec.noThinking || live.system !== spec.system) return false
    const r = spec.resume
    if (!r?.session) return false
    if (r.fork) return false
    return live.sessionId === r.session && (!r.at || live.tip === r.at)
  }

  ipcMain.handle('claude:send', async (_e, reqId: string, spec: SendSpec): Promise<TurnResult> => {
    const info = await exeInfo()
    if (!info.path) return { ok: false, error: 'NO_CLAUDE' }
    await Promise.race([toolsKnown, new Promise((r) => setTimeout(r, 5000))])
    let live = lives.get(spec.chatId)
    try {
      if (reusable(live, spec)) {
        if (live.model !== spec.model) {
          await live.q.setModel(spec.model)
          live.model = spec.model
        }
        if (live.effort !== spec.effort) {
          await live.q.applyFlagSettings({ effortLevel: spec.effort })
          live.effort = spec.effort
        }
      } else {
        if (live) close(live, 'new start')
        live = await start(spec, info.path)
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
    if (live.idle) clearTimeout(live.idle)
    const l = live
    return new Promise<TurnResult>((resolve) => {
      l.turn = { reqId, aborted: false, resolve }
      l.push({ type: 'user', message: { role: 'user', content: spec.content }, parent_tool_use_id: null } as SDKUserMessage)
    })
  })

  ipcMain.handle('claude:interrupt', async (_e, chatId: string) => {
    const live = lives.get(chatId)
    if (!live?.turn) return false
    live.turn.aborted = true
    try {
      await live.q.interrupt()
    } catch {
      close(live, 'interrupt failed')
    }
    return true
  })

  /** Sends a slash command (/compact) to the chat's open session. */
  ipcMain.handle('claude:command', async (_e, reqId: string, chatId: string, command: string, resume: { session: string } | null, base: Omit<SendSpec, 'content' | 'chatId' | 'resume'>) => {
    const info = await exeInfo()
    if (!info.path) return { ok: false, error: 'NO_CLAUDE' }
    let live = lives.get(chatId)
    if (!live || live.closed || (resume?.session && live.sessionId !== resume.session)) {
      if (!resume?.session) return { ok: false, error: 'This chat has no Claude conversation yet.' }
      if (live) close(live, 'command restart')
      live = await start({ ...base, chatId, content: [], resume: { session: resume.session } }, info.path)
    }
    if (live.turn) return { ok: false, error: 'Wait for the reply to finish first.' }
    const l = live
    return new Promise<TurnResult>((resolve) => {
      l.turn = { reqId, aborted: false, resolve }
      l.push({ type: 'user', message: { role: 'user', content: command }, parent_tool_use_id: null } as SDKUserMessage)
    })
  })

  ipcMain.handle('claude:context', async (_e, chatId: string) => {
    const live = lives.get(chatId)
    if (!live || live.closed) return null
    return contextOf(live).catch(() => null)
  })

  /** Ends a chat's open process (the chat was closed, or switched to another model). */
  ipcMain.handle('claude:release', (_e, chatId: string) => {
    const live = lives.get(chatId)
    if (live && !live.turn) close(live, 'released')
    return true
  })

  /** Deletes the Claude Code conversations behind a deleted chat. */
  ipcMain.handle('claude:forget', async (_e, chatId: string, sessionIds: string[]) => {
    const live = lives.get(chatId)
    if (live) close(live, 'chat deleted')
    for (const id of new Set(sessionIds || [])) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue
      await deleteSession(id, { dir: workDir }).catch((e: any) => opts.log('claude: could not delete session', id, e?.message))
    }
    return true
  })

  /** Copies an attachment where Claude may Read it (big PDFs). Returns the path. */
  ipcMain.handle('claude:stageFile', async (_e, sha: string, name: string) => {
    const buf = await opts.readBlob(String(sha)).catch(() => null)
    if (!buf) return null
    const safe = String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80)
    const file = path.join(filesDir, `${String(sha).slice(0, 12)}-${safe}`)
    if (!fs.existsSync(file)) await fsp.writeFile(file, buf)
    return file
  })

  ipcMain.handle('claude:status', async (_e, fresh?: boolean) => {
    const info = await exeInfo(Boolean(fresh))
    return { installed: Boolean(info.path), path: info.path, version: info.version, live: lives.size, limits }
  })

  /** Plan usage: 5-hour and weekly windows. Uses an open session when there is one. */
  ipcMain.handle('claude:usage', async (_e, fresh?: boolean) => {
    if (!fresh && limits && Date.now() - limitsAt < 60_000 && limits.plan !== undefined) return limits
    const info = await exeInfo()
    if (!info.path) return limits
    const open = [...lives.values()].find((l) => !l.closed)
    try {
      if (open) {
        setLimits(fromUsage(await open.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })))
        return limits
      }
      // No chat open: a short-lived process answers it (no message is sent, nothing is used).
      const box = inbox()
      const q = query({ prompt: box.iter, options: { pathToClaudeCodeExecutable: info.path, cwd: workDir, settingSources: [], strictMcpConfig: true, tools: [], persistSession: false } })
      try {
        setLimits(fromUsage(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })))
      } finally {
        box.end()
        q.close()
      }
    } catch (e: any) {
      opts.log('claude: usage failed', e?.message)
    }
    return limits
  })

  /** One short answer without tools or a saved conversation (chat titles). */
  ipcMain.handle('claude:complete', async (_e, body: { model?: string; system?: string; prompt: string }) => {
    const info = await exeInfo()
    if (!info.path) return { ok: false, error: 'NO_CLAUDE' }
    try {
      const q = query({
        prompt: String(body.prompt || ''),
        options: {
          pathToClaudeCodeExecutable: info.path,
          cwd: workDir,
          model: body.model || 'claude-haiku-5-5',
          effort: 'low',
          thinking: { type: 'disabled' },
          systemPrompt: body.system || 'Answer briefly.',
          settingSources: [],
          strictMcpConfig: true,
          tools: [],
          persistSession: false,
          maxTurns: 1,
        },
      })
      let text = ''
      for await (const m of q as AsyncIterable<any>) {
        if (m.type === 'rate_limit_event') setLimits(fromRateEvent(m.rate_limit_info))
        if (m.type === 'result') {
          text = typeof m.result === 'string' ? m.result : ''
          if (m.is_error) return { ok: false, error: text || m.subtype }
        }
      }
      return { ok: true, content: text }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  app.on('before-quit', () => {
    for (const l of [...lives.values()]) close(l, 'app quit')
  })

  return {
    callTool,
    toMcp,
    workDir,
    tools: () => toolDefs,
    guide: () => guide,
    whenTools: () => toolsKnown,
    onTools: (fn: (defs: ToolDef[]) => void) => listeners.add(fn),
    exeInfo,
  }
}

export type ClaudeHost = ReturnType<typeof setupClaude>
