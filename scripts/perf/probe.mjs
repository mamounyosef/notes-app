// Starts the perf instance (same folder as run-perf.mjs, not regenerated) and evaluates
// the expressions given on the command line, printing each result. For debugging the bench.
// Usage: node scripts/perf/probe.mjs "<expr>" ["<expr>" | shot:name | wait:ms ...]
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
const T = path.join(os.tmpdir(), 'notes-perf-e2e')
const UD = path.join(T, 'ud')
if (!fs.existsSync(UD)) throw new Error('run run-perf.mjs once first')
const PORT = 9335
const exe = path.join(PROJECT, 'node_modules/electron/dist/electron.exe')
const app = spawn(exe, ['.', `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], { cwd: PROJECT, env: { ...process.env, NOTES_TEST_OFFSCREEN: '1' }, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let id = 0
const pending = new Map()
const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && !t.url.startsWith('devtools')) } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r) => ws.on('open', r))
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } })
  for (let i = 0; i < 60; i++) {
    const r = await cdp('Runtime.evaluate', { expression: 'Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready)', returnByValue: true })
    if (r.result?.result?.value) break
    await sleep(500)
  }
  await sleep(1500)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  for (const e of process.argv.slice(2)) {
    // "shot:name" saves a screenshot to %TEMP%/notes-perf-e2e/name.png; "wait:ms" pauses.
    if (e.startsWith('shot:')) {
      const r = await cdp('Page.captureScreenshot', { format: 'png' })
      const f = path.join(T, `${e.slice(5)}.png`)
      fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'))
      console.log('shot', f)
      continue
    }
    if (e.startsWith('wait:')) {
      await sleep(Number(e.slice(5)))
      continue
    }
    const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r).slice(0, 3000))
  }
} finally {
  try { ws?.close() } catch {}
  app.kill()
  setTimeout(() => process.exit(0), 1000)
}
