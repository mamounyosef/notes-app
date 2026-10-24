// End to end test of the assistant in a separate, off screen Notes instance
// with its own empty notes folder (your notes and running app are untouched).
// Build first (npm run build). Usage:
//   OLLAMA_API_KEY=... node scripts/agent-e2e/run.mjs scripts/agent-e2e/basic.json
// Screenshots go to %TEMP%/notes-agent-e2e/out.
// scenario: { "prompts": ["..."], "shots": ["name", ...], "theme": "dark", "fresh": true }
// Needs OLLAMA_API_KEY in the environment (kept in memory only).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '../..')
const require = createRequire(path.join(PROJECT, 'package.json'))
const WebSocket = require('ws')
const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const SCEN_DIR = path.dirname(path.resolve(process.argv[2]))
const T = path.join(os.tmpdir(), 'notes-agent-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
const OUT = path.join(T, 'out')
if (scenario.fresh) fs.rmSync(T, { recursive: true, force: true })
fs.mkdirSync(UD, { recursive: true })
fs.mkdirSync(VAULT, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))
// Chat blobs (attachments) the scenario needs, copied from your own app data by sha.
for (const sha of scenario.blobs || []) {
  fs.mkdirSync(path.join(UD, 'agent', 'blobs'), { recursive: true })
  fs.copyFileSync(path.join(process.env.APPDATA, 'notesapp', 'agent', 'blobs', sha), path.join(UD, 'agent', 'blobs', sha))
}

const PORT = 9333
// NOTES_E2E_EXE runs a packaged build (release/win-unpacked/Notes.exe) instead of the sources.
const packaged = process.env.NOTES_E2E_EXE || ''
const exe = packaged || path.join(PROJECT, 'node_modules/electron/dist/electron.exe')
const app = spawn(exe, [...(packaged ? [] : ['.']), `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], {
  cwd: PROJECT,
  env: { ...process.env, NOTES_TEST_OFFSCREEN: '1' },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let id = 0
const pending = new Map()
function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}
async function ev(expr, timeout = 600000) {
  const r = await Promise.race([
    cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(timeout).then(() => ({ timeout: true })),
  ])
  if (r.timeout) throw new Error('timeout: ' + expr.slice(0, 80))
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800))
  return r.result?.value
}
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  console.log('shot', path.join(OUT, `${name}.png`))
}

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
    } catch {}
  }
  if (!target) throw new Error('no page target')
  console.log('target', target.url)
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r) => ws.on('open', r))
  ws.on('message', (m) => {
    const d = JSON.parse(m)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id).res(d.result || d)
      pending.delete(d.id)
    }
  })
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 60; i++) {
    if (await ev('Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready)')) break
    await sleep(500)
  }
  console.log('ready')
  if (scenario.theme) await ev(`__notesDebug.useStore.getState().setSettings({ theme: ${JSON.stringify(scenario.theme)} })`)
  if (scenario.setup) {
    console.log('setup', await ev(fs.readFileSync(path.join(SCEN_DIR, scenario.setup), 'utf8'), 60000))
  }
  await ev(`(async () => { const a = __notesDebug.useAgent.getState(); a.toggle(true); await a.refreshKey(); return true })()`)
  console.log('panel open', await ev('__notesDebug.useAgent.getState().hasKey', 10000))
  await sleep(800)
  if (scenario.shots?.includes('start')) await shot('start')
  for (const [n, p] of (scenario.prompts || []).entries()) {
    if (scenario.before?.[n]) console.log('before', JSON.stringify(await ev(scenario.before[n], 60000)))
    const t0 = Date.now()
    const answer = scenario.answers?.[n]
    // Answer an ask_user card automatically if the scenario gives one.
    await ev(`(window.__sendDone = false, __notesDebug.useAgent.getState().send(${JSON.stringify(p)}).then(() => { window.__sendDone = true }), true)`)
    let shotAsk = false
    // Timed steps while this prompt runs: { at: ms, eval?, shot? } (only for the first prompt).
    const during = n === 0 ? [...(scenario.during || [])] : []
    for (let k = 0; k < 1200; k++) {
      await sleep(500)
      while (during.length && Date.now() - t0 >= during[0].at) {
        const d = during.shift()
        if (d.eval) console.log('during', d.at, JSON.stringify(await ev(d.eval, 30000)))
        if (d.shot) await shot(d.shot)
      }
      // Waits for queued messages too: done once the send returned, nothing runs and nothing waits.
      if (await ev(`window.__sendDone && !__notesDebug.useAgent.getState().busy && !__notesDebug.useAgent.getState().queue.some(q => !__notesDebug.useAgent.getState().queueHold[q.chatId])`, 5000) && !during.length) break
      if (answer && (await ev('Boolean(__notesDebug.useAgent.getState().pendingAsk)', 5000))) {
        if (!shotAsk && scenario.shots?.includes(`ask${n + 1}`)) {
          await sleep(500)
          await shot(`ask${n + 1}`)
          shotAsk = true
        }
        await ev(`__notesDebug.useAgent.getState().answerAsk(${JSON.stringify(answer)})`, 5000)
      }
    }
    const res = await ev(`(() => {
      const c = __notesDebug.useAgent.getState().chat
      const turn = []
      let started = false
      for (const m of c.messages) {
        if (m.role === 'user' && m.content === ${JSON.stringify(p)}) { started = true; turn.length = 0; continue }
        if (!started) continue
        if (m.role === 'assistant') turn.push('ASSISTANT: ' + (m.content || '') + (m.toolCalls ? ' CALLS ' + JSON.stringify(m.toolCalls).slice(0, 700) : '') + (m.meta && m.meta.ask ? ' ASK ' + JSON.stringify(m.meta.ask) : ''))
        if (m.role === 'tool') turn.push('TOOL ' + m.toolName + ' -> ' + (m.meta && m.meta.summary) + ' | ' + m.content.slice(0, 300))
      }
      const s = __notesDebug.useAgent.getState()
      return { turn, error: s.error, usage: s.usage }
    })()`)
    console.log(`\n=== PROMPT ${n + 1} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${p}`)
    for (const l of res.turn) console.log('  ' + l)
    if (res.error) console.log('  ERROR', res.error)
    console.log('  usage', JSON.stringify(res.usage))
    if (scenario.shots?.includes(`p${n + 1}`)) {
      await sleep(600)
      await shot(`p${n + 1}`)
    }
  }
  const page = await ev(`(() => { const p = __notesDebug.useStore.getState().page; return p && p.cells.map(c => ({ id: c.id, title: c.title, x: c.x, y: c.y, w: c.w, bg: c.bg, html: c.html.slice(0, 400) })) })()`)
  console.log('\n=== PAGE CELLS')
  console.log(JSON.stringify(page, null, 1))
  if (scenario.eval) for (const e of scenario.eval) console.log('EVAL', JSON.stringify(await ev(e)).slice(0, 3000))
  if (scenario.shots?.includes('end')) await shot('end')
  for (const f of scenario.finalShots || []) {
    await ev(f.eval, 30000)
    await sleep(700)
    await shot(f.name)
  }
} catch (e) {
  console.error('FAILED', e.message)
} finally {
  try { ws?.close() } catch {}
  app.kill()
  // Leftover handles (the app's pipes) can keep node alive: end here.
  setTimeout(() => process.exit(0), 1500)
}
