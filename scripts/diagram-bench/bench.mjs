// Diagram engine benchmark through the real assistant pipeline.
//
// For every (task, engine, model) it starts an off screen Notes instance with
// its own empty notes folder, asks the assistant (the app's own prompt, tools,
// checks and fix rounds) to draw the task with that engine, then saves what
// the user would see. Your notes and the running app are untouched; the saved
// API keys are copied (still encrypted) into each instance's private data.
//
// Build first (npm run build). Usage:
//   node scripts/diagram-bench/bench.mjs scripts/diagram-bench/config.json [filter]
// filter (optional) keeps jobs whose "task/engine/model" contains it.
// Finished jobs are skipped on a rerun (delete their meta.json to redo one).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { writeGallery } from './gallery.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '../..')
const require = createRequire(path.join(PROJECT, 'package.json'))
const WebSocket = require('ws')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^﻿/, ''))
// "!text" leaves out the jobs that contain text.
const FILTER = process.argv[3] || ''
const PARALLEL = Number(process.env.BENCH_PARALLEL) || cfg.parallel || 2
// Two runs at once (Ollama and OpenRouter) use different ports and folders.
const SLOT_BASE = Number(process.env.BENCH_SLOT) || 0
// Optional comma lists that narrow the jobs (ids from the config): BENCH_TASKS, BENCH_ENGINES, BENCH_MODELS.
const only = (name) => (process.env[name] ? process.env[name].split(',').map((s) => s.trim()) : null)
const ONLY = { task: only('BENCH_TASKS'), engine: only('BENCH_ENGINES'), model: only('BENCH_MODELS') }
const TIMEOUT_MIN = Number(process.env.BENCH_TIMEOUT_MIN) || cfg.timeoutMin || 20
// An Ollama key given for the test only (kept in memory): used instead of the saved ones.
const OLLAMA_KEY = process.env.BENCH_OLLAMA_KEY || ''
/** Service trouble, not the model's work: such a job is run again. */
const INFRA = /\b(429|50\d)\b|Internal Server Error|fetch failed|too many|rate.?limit|timeout: |did not start|ECONNRESET|socket hang up/i
const OUT = cfg.out
const WORK = path.join(os.tmpdir(), 'notes-diagram-bench')
const APPDATA = path.join(process.env.APPDATA, 'notesapp')
const EXE = path.join(PROJECT, 'node_modules/electron/dist/electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const EXT = { mermaid: 'mmd', graphviz: 'dot', d2: 'd2', tikz: 'tex', html: 'html', wavedrom: 'json', chart: 'json', kmap: 'json' }
const FENCE = { mermaid: 'mermaid', graphviz: 'graphviz', d2: 'd2', tikz: 'tikz', widget: 'widget' }
/** Folder and file names: readable, without characters Windows refuses. */
const safe = (s) => String(s).replace(/[<>:"/\\|?*]+/g, '-').trim()

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(path.join(OUT, 'References'), { recursive: true })
for (const t of cfg.tasks) if (t.ref) fs.copyFileSync(path.join(HERE, t.ref), path.join(OUT, 'References', `${safe(t.name)}.png`))

const jobs = []
for (const t of cfg.tasks)
  for (const e of cfg.engines)
    for (const m of cfg.models) {
      const key = `${t.id}/${e.id}/${m.id}`
      if (FILTER && (FILTER.startsWith('!') ? key.includes(FILTER.slice(1)) : !key.includes(FILTER))) continue
      if (m.tasks && !m.tasks.includes(t.id)) continue
      // An engine the app no longer has keeps its old results in the gallery.
      if (e.retired) continue
      if ((ONLY.task && !ONLY.task.includes(t.id)) || (ONLY.engine && !ONLY.engine.includes(e.id)) || (ONLY.model && !ONLY.model.includes(m.id))) continue
      const dir = path.join(OUT, safe(`${t.order} ${t.name}`), safe(e.name))
      const base = safe(m.name)
      const metaFile = path.join(dir, `${base} - meta.json`)
      // Done before (an infrastructure error, such as a rate limit, is tried again).
      if (fs.existsSync(metaFile)) {
        const old = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
        if (old.status !== 'error' && !(old.error && INFRA.test(old.error))) continue
      }
      jobs.push({ task: t, engine: e, model: m, dir, base, metaFile, key })
    }
// Ollama models first: OpenRouter's free models have a small daily allowance.
jobs.sort((a, b) => Number(a.model.id.includes('/')) - Number(b.model.id.includes('/')))
log(`${jobs.length} jobs to run, ${PARALLEL} at a time`)

function promptFor(task, engine) {
  const how = engine.id === 'widget' ? 'one ```widget drawing (HTML/SVG/CSS)' : `one \`\`\`${FENCE[engine.id]} drawing`
  if (task.ref) return `Recreate the attached figure in this page as faithfully as you can, as ${how}. Keep every block, label, number, arrow, grouping and annotation of the original, and its layout.`
  return `${task.prompt} Draw it in this page as ${how}.`
}

async function runJob(job, slot) {
  const port = 9400 + SLOT_BASE + slot
  const root = path.join(WORK, `w${SLOT_BASE + slot}`)
  // A just closed instance can hold its files for a moment.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) } catch { /* reused as is */ }
  const ud = path.join(root, 'ud')
  const vault = path.join(root, 'vault')
  fs.mkdirSync(ud, { recursive: true })
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ vault }))
  // With a test key, the saved Ollama keys stay out so the app falls back to OLLAMA_API_KEY.
  const files = ['Local State', 'openrouter-key.bin', 'openrouter-keys.bin', ...(OLLAMA_KEY ? [] : ['ollama-key.bin', 'ollama-keys.bin'])]
  for (const f of files) {
    try { fs.copyFileSync(path.join(APPDATA, f), path.join(ud, f)) } catch { /* not saved */ }
  }
  const app = spawn(EXE, ['.', `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], {
    cwd: PROJECT,
    env: { ...process.env, NOTES_TEST_OFFSCREEN: '1', ...(OLLAMA_KEY ? { OLLAMA_API_KEY: OLLAMA_KEY } : {}) },
    stdio: 'ignore',
  })
  let ws
  let id = 0
  const pending = new Map()
  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id
      pending.set(i, { res, rej })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  async function ev(expr, timeout = 120000) {
    const r = await Promise.race([cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(timeout).then(() => ({ timeout: true }))])
    if (r.timeout) throw new Error('timeout: ' + expr.slice(0, 80))
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600))
    return r.result?.value
  }
  const meta = { task: job.task.name, engine: job.engine.name, model: job.model.name, modelId: job.model.id, prompt: promptFor(job.task, job.engine), started: new Date().toISOString(), status: 'error', drawings: [] }
  const t0 = Date.now()
  try {
    let target
    for (let i = 0; i < 80 && !target; i++) {
      await sleep(500)
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      } catch { /* starting */ }
    }
    if (!target) throw new Error('the app did not start')
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
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
    for (let i = 0; i < 80; i++) {
      if (await ev('Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready)').catch(() => false)) break
      await sleep(500)
    }
    await ev(`__notesDebug.useStore.getState().setSettings({ theme: ${JSON.stringify(cfg.theme || 'dark')} })`)
    await ev(fs.readFileSync(path.join(PROJECT, 'scripts/agent-e2e/setup-blank.js'), 'utf8'), 60000)
    await ev(`(async () => { const a = __notesDebug.useAgent.getState(); a.setPrefs({ model: ${JSON.stringify(job.model.id)}, think: true }); a.toggle(true); await a.refreshKey(); return true })()`)
    if (job.task.ref) {
      const b64 = fs.readFileSync(path.join(HERE, job.task.ref)).toString('base64')
      const size = fs.statSync(path.join(HERE, job.task.ref)).size
      await ev(`(async () => { const sha = await window.notes.chats.saveBlob(${JSON.stringify(b64)}); __notesDebug.useAgent.getState().addAttachment({ sha, name: ${JSON.stringify(path.basename(job.task.ref))}, mime: 'image/png', kind: 'image', size: ${size} }); return sha })()`)
    }
    await sleep(500)
    const prompt = meta.prompt
    await ev(`(window.__sendDone = false, __notesDebug.useAgent.getState().send(${JSON.stringify(prompt)}).then(() => { window.__sendDone = true }), true)`)
    const limit = TIMEOUT_MIN * 60000
    let timedOut = true
    while (Date.now() - t0 < limit) {
      await sleep(1500)
      const st = await ev(`(() => { const s = __notesDebug.useAgent.getState(); return { done: window.__sendDone && !s.busy, ask: Boolean(s.pendingAsk) } })()`, 15000).catch(() => ({}))
      if (st.ask) await ev(`__notesDebug.useAgent.getState().answerAsk('Use your best judgment and go ahead.')`, 10000).catch(() => {})
      if (st.done) { timedOut = false; break }
    }
    if (timedOut) {
      meta.timedOut = true
      await ev(`(() => { const s = __notesDebug.useAgent.getState(); s.stop && s.stop(); return 1 })()`, 10000).catch(() => {})
      await sleep(2000)
    }
    meta.seconds = Math.round((Date.now() - t0) / 1000)
    const res = await ev(`(() => {
      const s = __notesDebug.useAgent.getState(), c = s.chat, turn = [], tools = {}; let requests = 0
      for (const m of c.messages) {
        if (m.role === 'assistant') requests++, turn.push('ASSISTANT: ' + (m.content || '') + (m.toolCalls ? '\\n  CALLS ' + JSON.stringify(m.toolCalls) : ''))
        if (m.role === 'tool') { tools[m.toolName] = (tools[m.toolName] || 0) + 1; turn.push('TOOL ' + m.toolName + ' -> ' + (m.meta && m.meta.summary) + '\\n  ' + m.content) }
      }
      return { turn, tools, requests, error: s.error, usage: s.usage }
    })()`)
    meta.tools = res.tools
    meta.requests = res.requests
    meta.error = res.error || undefined
    meta.usage = res.usage
    fs.mkdirSync(job.dir, { recursive: true })
    fs.writeFileSync(path.join(job.dir, `${job.base} - log.txt`), `MODEL ${job.model.id}\nPROMPT ${prompt}\n\n${res.turn.join('\n\n')}\n\nERROR ${res.error || ''}\nUSAGE ${JSON.stringify(res.usage)}\n`)
    // Every drawing on the page, drawn the way the cell shows it.
    const drawings = await ev(`(async () => {
      const D = __notesDebug, p = D.useStore.getState().page, out = []
      for (const c of (p ? p.cells : [])) {
        const doc = new DOMParser().parseFromString('<body>' + (c.html || '') + '</body>', 'text/html')
        for (const el of doc.querySelectorAll('div[data-html-embed]')) {
          const kind = D.kindOf(el.getAttribute('data-kind')), src = D.fromBase64(el.getAttribute('data-html-src') || '')
          const width = Math.max(260, Math.round(Number(el.getAttribute('data-width')) || c.w - 28))
          const html = await D.buildWidgetDoc(kind, src, D.currentTheme(document.querySelector('.cell')), { opaque: true })
          const shot = await window.notes.agent.renderWidget({ html, width })
          // Also wide, for a closer look: diagrams with their own size show at it.
          const big = await window.notes.agent.renderWidget({ html, width: 1300 })
          out.push({ cell: c.title, cellW: c.w, kind, src, width, png: shot.png, big: big.png, errors: shot.errors, lint: shot.lint, h: shot.height })
        }
      }
      return out
    })()`, 300000)
    drawings.forEach((d, i) => {
      const suffix = drawings.length > 1 ? ` (${i + 1})` : ''
      const png = `${job.base}${suffix}.png`
      const src = `${job.base}${suffix} - source.${EXT[d.kind] || 'txt'}`
      const big = `${job.base}${suffix} - large.png`
      if (d.png) fs.writeFileSync(path.join(job.dir, png), Buffer.from(d.png, 'base64'))
      if (d.big) fs.writeFileSync(path.join(job.dir, big), Buffer.from(d.big, 'base64'))
      fs.writeFileSync(path.join(job.dir, src), d.src)
      meta.drawings.push({ kind: d.kind, png, big: d.big ? big : undefined, src, width: d.width, height: d.h, errors: d.errors, lint: d.lint })
    })
    // The page as a whole, assistant panel closed.
    await ev(`(async () => { __notesDebug.useAgent.getState().toggle(false); const S = __notesDebug.useStore.getState(); S.setZoom(0.6); await new Promise(r => setTimeout(r, 3500)); return 1 })()`, 30000)
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    meta.pageShot = `${job.base} - page.png`
    fs.writeFileSync(path.join(job.dir, meta.pageShot), Buffer.from(shot.data, 'base64'))
    const used = meta.drawings.map((d) => d.kind)
    const want = job.engine.id === 'widget' ? 'html' : job.engine.id
    meta.status = !meta.drawings.length ? (meta.error ? 'error' : 'no drawing') : meta.drawings.some((d) => d.errors?.length) ? 'drawing error' : used.includes(want) ? 'ok' : 'wrong engine'
    if (meta.timedOut) meta.status += ' (timed out)'
    // Cut short by the service (a drawing may be half done): run it again.
    if (meta.error && INFRA.test(meta.error)) meta.status = 'error'
  } catch (e) {
    meta.error = String(e?.message || e)
    meta.seconds = Math.round((Date.now() - t0) / 1000)
  } finally {
    try { ws?.close() } catch { /* closed */ }
    app.kill()
  }
  fs.mkdirSync(job.dir, { recursive: true })
  fs.writeFileSync(job.metaFile, JSON.stringify(meta, null, 1))
  return meta
}

let next = 0
let done = 0
async function worker(slot) {
  while (next < jobs.length) {
    const job = jobs[next++]
    let m
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`[w${SLOT_BASE + slot}] start ${job.key}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      m = await runJob(job, slot)
      if (m.status !== 'error') break
      await sleep(60000 * attempt)
    }
    done++
    log(`[w${SLOT_BASE + slot}] ${m.status} ${job.key} ${m.seconds}s ${m.error ? 'ERR ' + String(m.error).slice(0, 160) : ''} (${done}/${jobs.length})`)
    writeGallery(cfg)
    await sleep(1500)
  }
}
await Promise.all(Array.from({ length: PARALLEL }, (_, i) => worker(i)))
writeGallery(cfg)
log('all done')
setTimeout(() => process.exit(0), 1000)
