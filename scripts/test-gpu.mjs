// Tests Settings, "Use graphics card" in an isolated Notes instance (needs `npm run build`):
// it turns on when asked, a good start clears its boot marker, and a start that died
// with the graphics card on falls back to software drawing.
// Usage: node scripts/test-gpu.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WebSocket = createRequire(path.join(PROJECT, 'package.json'))('ws')
const T = path.join(os.tmpdir(), 'notes-gpu-test')
const UD = path.join(T, 'ud')
const cfgFile = path.join(UD, 'config.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'))

async function run(cfg, waitMs, fn) {
  fs.mkdirSync(UD, { recursive: true })
  fs.writeFileSync(cfgFile, JSON.stringify({ vault: path.join(T, 'vault'), ...cfg }))
  const exe = path.join(PROJECT, 'node_modules/electron/dist/electron.exe')
  const app = spawn(exe, ['.', `--user-data-dir=${UD}`, '--remote-debugging-port=9335'], { cwd: PROJECT, env: { ...process.env, NOTES_TEST_OFFSCREEN: '1' }, stdio: 'ignore' })
  try {
    let target
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500)
      try {
        target = (await (await fetch('http://127.0.0.1:9335/json')).json()).find((t) => t.type === 'page')
      } catch {}
    }
    if (!target) throw new Error('no page')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r) => ws.on('open', r))
    const ev = (expression) =>
      new Promise((res) => {
        ws.once('message', (m) => res(JSON.parse(m).result?.result?.value))
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
    await sleep(waitMs)
    await fn(ev)
    ws.close()
  } finally {
    app.kill()
    await sleep(1500)
  }
}

fs.rmSync(T, { recursive: true, force: true })
try {
  await run({ gpu: true }, 3000, async (ev) => {
    const st = await ev('window.notes.gpu.get()')
    check(st?.active === true && st?.wanted === true, 'gpu on: this run uses the graphics card')
    check(typeof readCfg().gpuBoot === 'number', 'a start with the graphics card leaves a boot marker')
  })
  // The last run was killed 3 s in, before it counted as good: the marker is still there.
  await run({ gpu: true, gpuBoot: Date.now() }, 2000, async (ev) => {
    const st = await ev('window.notes.gpu.get()')
    check(st?.active === false && st?.wanted === false, 'a start that died with the graphics card falls back to software')
    check(Boolean(st?.failed?.why), 'the fallback says why')
  })
  await run({ gpu: true }, 23000, async () => {
    check(readCfg().gpuBoot === undefined, 'a start that ran 20 s clears the boot marker')
  })
  await run({}, 2000, async (ev) => {
    const st = await ev('window.notes.gpu.get()')
    check(st?.active === false, 'default: software drawing')
    const r = await ev('window.notes.gpu.set(true)')
    check(r?.restart === true && readCfg().gpu === true, 'turning it on asks for a restart and is saved')
  })
} catch (e) {
  console.log('FAIL', e.message)
  failures++
}
fs.rmSync(T, { recursive: true, force: true })
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
