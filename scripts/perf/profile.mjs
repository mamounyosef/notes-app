// CPU profile of one action in the perf instance (run run-perf.mjs once first, so the
// synthetic notes folder exists). Prints the functions with the most self and total time.
// Build unminified for readable names: npx vite build --minify false
// Usage: node scripts/perf/profile.mjs <switch|type|search> [repeats=6]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '../..')
const require = createRequire(path.join(PROJECT, 'package.json'))
const WebSocket = require('ws')
const MODE = process.argv[2] || 'switch'
const REPEATS = Number(process.argv[3] || 6)
const T = path.join(os.tmpdir(), 'notes-perf-e2e')
const UD = path.join(T, 'ud')
const PORT = 9336
const exe = path.join(PROJECT, 'node_modules/electron/dist/electron.exe')
const app = spawn(exe, ['.', `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], { cwd: PROJECT, env: { ...process.env, NOTES_TEST_OFFSCREEN: '1' }, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let id = 0
const pending = new Map()
const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result?.result?.value
}
try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && !t.url.startsWith('devtools')) } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 2e9 })
  await new Promise((r) => ws.on('open', r))
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } })
  for (let i = 0; i < 60; i++) {
    if (await ev('Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready && __notesDebug.useStore.getState().page)')) break
    await sleep(500)
  }
  await sleep(3000)
  await ev(`window.__drawn = async (pid) => { for (;;) { const st = __notesDebug.useStore.getState(); if (st.page && st.page.id === pid && document.querySelectorAll('.canvas .cell .ProseMirror').length === st.page.cells.length) break; await new Promise((r) => setTimeout(r, 1)) } await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0)))) }; true`)
  await cdp('Profiler.enable')
  await cdp('Profiler.setSamplingInterval', { interval: 200 })
  let action
  if (MODE === 'switch') {
    const pages = ['heavy2', 'heavy3', 'heavy4', 'heavy5', 'heavy6', 'heavy1']
    action = async (i) => ev(`(async () => { __notesDebug.useStore.getState().openPage('${pages[i % 6]}'); await __drawn('${pages[i % 6]}'); return 1 })()`)
  } else if (MODE === 'search') {
    action = async () => ev(`window.notes.search('transformer attention')`)
  } else {
    await ev(`(async () => { __notesDebug.useStore.getState().openPage('heavy1'); await __drawn('heavy1'); const pm = document.querySelector('.canvas .cell .ProseMirror'); pm.focus(); const r = document.createRange(); r.selectNodeContents(pm.querySelector('p')); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); return 1 })()`)
    action = async () => {
      for (let k = 0; k < 10; k++) {
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
        await sleep(30)
      }
    }
  }
  await cdp('Profiler.start')
  for (let i = 0; i < REPEATS; i++) {
    await action(i)
    await sleep(200)
  }
  const { result } = await cdp('Profiler.stop')
  const nodes = result.profile.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const dt = new Map()
  const { samples, timeDeltas } = result.profile
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) || 0) + (timeDeltas[i] || 0))
  const parent = new Map()
  for (const n of nodes) for (const c of n.children || []) parent.set(c, n.id)
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url || '')}:${n.callFrame.lineNumber}`
  const self = new Map()
  const total = new Map()
  for (const n of nodes) {
    const t = (dt.get(n.id) || 0) / 1000
    if (!t) continue
    self.set(key(n), (self.get(key(n)) || 0) + t)
    const seen = new Set()
    let cur = n.id
    while (cur) {
      const k = key(byId.get(cur))
      if (!seen.has(k)) {
        total.set(k, (total.get(k) || 0) + t)
        seen.add(k)
      }
      cur = parent.get(cur)
    }
  }
  const all = [...self.values()].reduce((a, b) => a + b, 0)
  const idle = (self.get('(idle) :-1') || 0) + (self.get('(program) :-1') || 0)
  console.log(`profile ${MODE}: total ${all.toFixed(0)}ms, idle+program ${idle.toFixed(0)}ms`)
  console.log('--- self')
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 35)) console.log(v.toFixed(1).padStart(8), k)
  console.log('--- total')
  for (const [k, v] of [...total].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(v.toFixed(1).padStart(8), k)
  fs.writeFileSync(path.join(T, `profile-${MODE}.cpuprofile`), JSON.stringify(result.profile))
} catch (e) {
  console.error('FAILED', e.stack)
} finally {
  try { ws?.close() } catch {}
  app.kill()
  setTimeout(() => process.exit(0), 1000)
}
