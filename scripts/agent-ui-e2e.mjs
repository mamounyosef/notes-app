// Visual and behaviour check of the assistant panel: streaming flow, text size,
// expand, the Aa menu. Screenshots go to %TEMP%/notes-agent-ui-e2e/out.
// Run after `npm run build`.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const require = createRequire(path.join(PROJECT, 'package.json'))
const WebSocket = require('ws')
const T = path.join(os.tmpdir(), 'notes-agent-ui-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
const OUT = path.join(T, 'out')
fs.rmSync(T, { recursive: true, force: true })
for (const d of [UD, VAULT, OUT]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))
const PORT = 9343
const app = spawn(path.join(PROJECT, 'node_modules/electron/dist/electron.exe'), ['.', `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], {
  cwd: PROJECT,
  env: { ...process.env, NOTES_TEST_OFFSCREEN: '1' },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let id = 0
const pending = new Map()
const cdp = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800))
  return r.result?.value
}
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  console.log('shot', path.join(OUT, `${name}.png`))
}
const fails = []
const check = (ok, what) => {
  console.log(ok ? 'PASS' : 'FAIL', what)
  if (!ok) fails.push(what)
}

const REPLY = `Here is a **summary** of your notes on calculus:

## Key ideas
- Limits describe behaviour near a point
- The derivative $f'(x)$ is the slope
- Integrals add up area: $$\\int_0^1 x^2\\,dx = \\tfrac13$$

| Term | Meaning |
| --- | --- |
| Limit | Value approached |
| Derivative | Rate of change |

\`\`\`python
def slope(f, x, h=1e-6):
    return (f(x + h) - f(x)) / h
\`\`\`

That covers the main points. Want me to make flashcards from it?`

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
    } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r) => ws.on('open', r))
  ws.on('message', (m) => {
    const d = JSON.parse(m)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d.result || d)
      pending.delete(d.id)
    }
  })
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  for (let i = 0; i < 300; i++) {
    if (await ev('Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready)')) break
    await sleep(100)
  }
  const A = '__notesDebug.useAgent'
  await ev(`(() => {
    const A = ${A}
    A.getState().setPrefs({ open: true, mode: 'pane', width: 460, textScale: 1, spacing: 'normal', readWidth: 'normal' })
    const now = Date.now()
    A.setState({ hasKey: true, chat: { id: 'test', title: 'Calculus notes', titleAt: now, createdAt: now, updatedAt: now, messages: [
      { id: 'u1', at: now, parent: null, role: 'user', content: 'Summarize my calculus notes' },
    ] } })
  })()`)
  await sleep(800)

  // Stream the reply in bursts (like a network): the shown text must grow every frame, evenly.
  await ev(`window.__lens = []; (function loop(){ const md = document.querySelector('.md.live'); window.__lens.push(md ? md.textContent.length : -1); if (window.__lens.length < 400) requestAnimationFrame(loop) })()`)
  const full = JSON.stringify(REPLY)
  await ev(`(async () => {
    const A = ${A}
    const text = ${full}
    A.setState({ busy: true })
    for (let i = 0; i <= text.length; i += 60) {
      A.setState({ live: { id: 'live1', at: Date.now(), parent: 'u1', role: 'assistant', content: text.slice(0, i) } })
      await new Promise(r => setTimeout(r, 140))
    }
    A.setState({ live: { id: 'live1', at: Date.now(), parent: 'u1', role: 'assistant', content: text } })
  })()`)
  await sleep(300)
  await shot('streaming')
  await sleep(1500)
  const lens = (await ev('window.__lens')).filter((n) => n >= 0)
  let grewFrames = 0
  let maxJump = 0
  for (let i = 1; i < lens.length; i++) {
    const d = lens[i] - lens[i - 1]
    if (d > 0) grewFrames++
    maxJump = Math.max(maxJump, d)
  }
  console.log('frames seen', lens.length, 'frames that grew', grewFrames, 'biggest jump', maxJump)
  check(grewFrames > 40, 'text grows on many frames (smooth), not in a few bursts')
  check(maxJump < 60, 'no single frame jumps by a whole burst')
  check((await ev(`document.querySelector('.md.live')?.textContent.includes('flashcards')`)) === true, 'full reply shown at the end')

  // Finish the turn.
  await ev(`(() => {
    const A = ${A}
    const c = A.getState().chat
    A.setState({ live: null, busy: false, chat: { ...c, messages: [...c.messages, { id: 'a1', at: Date.now(), parent: 'u1', role: 'assistant', content: ${full} }] } })
  })()`)
  await sleep(500)
  await shot('done-100')

  // Text size: Ctrl + wheel over the chat.
  const box = await ev(`(() => { const r = document.querySelector('.ag-scroll').getBoundingClientRect(); return [r.left + r.width / 2, r.top + 100] })()`)
  const h0 = await ev(`document.querySelector('.ag-reply').getBoundingClientRect().height`)
  for (let i = 0; i < 6; i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box[0], y: box[1], deltaX: 0, deltaY: -100, modifiers: 2 })
    await sleep(60)
  }
  await sleep(300)
  const scale = await ev(`${A}.getState().prefs.textScale`)
  const h1 = await ev(`document.querySelector('.ag-reply').getBoundingClientRect().height`)
  console.log('scale', scale, 'height', h0, '->', h1)
  check(scale >= 1.25, 'Ctrl+wheel makes the text bigger')
  check(h1 > h0, 'chat grows with the text')
  check((await ev(`__notesDebug.useStore.getState().zoom`)) === 1, 'page zoom untouched')
  await shot('bigger-text')

  // Aa menu.
  await ev(`document.querySelector('.ag-ap-wrap .ag-icon-btn').click()`)
  await sleep(300)
  check(await ev(`Boolean(document.querySelector('.ag-ap'))`), 'Aa menu opens')
  await shot('aa-menu')
  await ev(`[...document.querySelectorAll('.ag-ap-seg button')].find(b => b.textContent === 'Airy').click()`)
  await ev(`document.querySelector('.ag-ap-wrap .ag-icon-btn').click()`)

  // Expand.
  await ev(`document.querySelector('.ag-icon-btn[title^="Expand"]').click()`)
  await sleep(400)
  const g = await ev(`(() => { const r = document.querySelector('.agent-panel').getBoundingClientRect(); const c = document.querySelector('.canvas-wrap').getBoundingClientRect(); return { w: r.width, right: r.right, page: c.width, win: innerWidth } })()`)
  console.log('expanded', g)
  check(g.w > 700 && g.right <= g.win + 1 && g.page >= 100, 'expand makes the panel wide and still fits the window')
  await shot('expanded')
} catch (e) {
  console.error(e)
  fails.push(String(e))
} finally {
  try {
    ws?.close()
  } catch {}
  app.kill()
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
}
