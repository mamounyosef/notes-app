// Screenshots go to %TEMP%/notes-redo-e2e/out.
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
const T = path.join(os.tmpdir(), 'notes-redo-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
const OUT = path.join(T, 'out')
fs.rmSync(T, { recursive: true, force: true })
for (const d of [UD, VAULT, OUT]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))

const PORT = 9336
const exe = process.env.NOTES_E2E_EXE || path.join(PROJECT, 'node_modules/electron/dist/electron.exe')
const app = spawn(exe, [...(process.env.NOTES_E2E_EXE ? [] : ['.']), `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], {
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
async function waitFor(expr, ms = 10000) {
  for (let t = 0; t < ms; t += 100) {
    if (await ev(expr)) return true
    await sleep(100)
  }
  return false
}

const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
async function click(x, y, extra = {}) {
  await mouse('mousePressed', x, y, extra)
  await mouse('mouseReleased', x, y, extra)
  await sleep(60)
}
/** Drags through points; pen strokes carry pressure as force. */
async function drag(pts, extra = {}, force) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts[0][0], y: pts[0][1] })
  await mouse('mousePressed', pts[0][0], pts[0][1], { ...extra, ...(force ? { force: force(0) } : {}) })
  for (let i = 1; i < pts.length; i++) {
    await mouse('mouseMoved', pts[i][0], pts[i][1], { ...extra, ...(force ? { force: force(i / pts.length) } : {}) })
    if (i % 4 === 0) await sleep(16)
  }
  const l = pts[pts.length - 1]
  await mouse('mouseReleased', l[0], l[1], extra)
  await sleep(80)
}
async function key(k, mods = 0) {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, modifiers: mods, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, modifiers: mods })
  await sleep(80)
}
const marks = () => ev(`(() => { const e = window.__ieMarks && window.__ieMarks(); return e })()`)
/** A point on the picture frame, as fractions of it. */
async function at(u, v) {
  const r = await ev(`(() => { const r = document.querySelector('.ie-frame').getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
  return [r[0] + u * r[2], r[1] + v * r[3]]
}
async function path2(fn, n = 40) {
  const out = []
  for (let i = 0; i <= n; i++) out.push(await at(...fn(i / n)))
  return out
}
const btn = (sel) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
const btnText = (text) =>
  ev(`(() => { const b = [...document.querySelectorAll('button, [role=menuitem], .menu-item, li, div')].reverse().find((e) => e.children.length < 4 && e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)

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
  await waitFor('Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready)', 30000)
  await ev(`(async () => {
    const S = __notesDebug.useStore
    const nb = await S.getState().addNode('notebook', null)
    const sec = await S.getState().addNode('section', nb)
    await S.getState().addNode('page', sec)
  })()`)
  await sleep(500)
  const S = `__notesDebug.useStore.getState()`
  const nCells = () => ev(`${S}.page.cells.length`)
  const state = () => ev(`(() => { const s = ${S}; return { cells: s.page.cells.length, hist: s.history.length, fut: s.future.length, editing: s.editingCellId, html: s.page.cells.map(c => c.html).join('|') } })()`)

  // A) cell ops through the toolbar buttons
  await ev(`${S}.addCell({ x: 100, y: 100 })`)
  await sleep(300)
  await ev(`(document.activeElement)?.blur(); __notesDebug.useStore.setState({ editingCellId: null })`)
  await sleep(200)
  await ev(`${S}.addCell({ x: 100, y: 400 })`)
  await sleep(300)
  await ev(`(document.activeElement)?.blur(); __notesDebug.useStore.setState({ editingCellId: null })`)
  await sleep(300)
  console.log('A start', await state())
  await click(...(await btn('.toolbar button[title^="Undo"]')))
  await sleep(400)
  console.log('A after undo', await state())
  await click(...(await btn('.toolbar button[title^="Redo"]')))
  await sleep(400)
  console.log('A after redo', await state())
  check((await nCells()) === 2, 'toolbar redo restores cell op')

  // B) typing in a cell, toolbar buttons while editing
  const cell = await btn('.ProseMirror')
  await click(...cell)
  await click(...cell)
  await ev(`(() => { const e = document.querySelector('.ProseMirror'); e.focus(); return document.activeElement === e })()`)
  await sleep(300)
  await cdp('Input.insertText', { text: 'hello' })
  await sleep(1200)
  await cdp('Input.insertText', { text: ' world' })
  await sleep(600)
  console.log('B typed', await state())
  await click(...(await btn('.toolbar button[title^="Undo"]')))
  await sleep(400)
  console.log('B after undo', await state())
  await click(...(await btn('.toolbar button[title^="Redo"]')))
  await sleep(400)
  console.log('B after redo', await state())
  check((await state()).html.includes('hello world'), 'toolbar redo restores typing')

  // C) keyboard
  await key('z', 2)
  await sleep(300)
  console.log('C after ctrl+z', await state())
  await key('y', 2)
  await sleep(300)
  console.log('C after ctrl+y', await state())
  check((await state()).html.includes('hello world'), 'ctrl+y restores typing')
  await key('z', 2)
  await sleep(300)
  await key('z', 2 | 8)
  await sleep(300)
  console.log('C after ctrl+shift+z', await state())
  check((await state()).html.includes('hello world'), 'ctrl+shift+z restores typing')

  const U = () => btn('.toolbar button[title^="Undo"]')
  const R = () => btn('.toolbar button[title^="Redo"]')
  const empty = [1250, 850]

  // D) type, click away on the canvas, undo + redo with buttons
  await click(...empty)
  await sleep(400)
  console.log('D clicked away', await state())
  const before = (await state()).html
  await click(...(await U()))
  await sleep(400)
  console.log('D after undo', await state())
  await click(...(await R()))
  await sleep(400)
  console.log('D after redo', await state())
  check((await state()).html === before, 'D: redo after clicking away')

  // E) drag a cell, undo, redo
  const grip = await btn('.cell-grip')
  const pos0 = await ev(`${S}.page.cells.map(c => c.x + ',' + c.y).join(' ')`)
  await drag([grip, [grip[0] + 60, grip[1] + 40], [grip[0] + 200, grip[1] + 120]])
  await sleep(400)
  const pos1 = await ev(`${S}.page.cells.map(c => c.x + ',' + c.y).join(' ')`)
  await click(...(await U()))
  await sleep(400)
  const pos2 = await ev(`${S}.page.cells.map(c => c.x + ',' + c.y).join(' ')`)
  await click(...(await R()))
  await sleep(400)
  const pos3 = await ev(`${S}.page.cells.map(c => c.x + ',' + c.y).join(' ')`)
  console.log('E', { pos0, pos1, pos2, pos3 }, await state())
  check(pos2 === pos0 && pos3 === pos1, 'E: redo a drag')

  // F) select a cell, Delete key, undo, redo
  await click(...empty)
  await ev(`${S}.setSelection([${S}.page.cells[0].id])`)
  await key('Delete')
  await sleep(300)
  const f1 = await nCells()
  await click(...(await U()))
  await sleep(300)
  const f2 = await nCells()
  await click(...(await R()))
  await sleep(300)
  const f3 = await nCells()
  console.log('F', { f1, f2, f3 }, await state())
  check(f3 === f1, 'F: redo a delete')

  // G) type in a new cell, undo with the button past the text, then redo all the way
  await click(...empty)
  await ev(`${S}.addCell({ x: 600, y: 100 })`)
  await sleep(400)
  await ev(`(() => { const all = document.querySelectorAll('.ProseMirror'); all[all.length - 1].focus() })()`)
  await cdp('Input.insertText', { text: 'abc' })
  await sleep(800)
  console.log('G typed', await state())
  for (let i = 0; i < 3; i++) { await click(...(await U())); await sleep(300); console.log('G undo', i, await state()) }
  for (let i = 0; i < 3; i++) { await click(...(await R())); await sleep(300); console.log('G redo', i, await state()) }
  check((await state()).html.includes('abc'), 'G: redo back past a store undo')
} catch (e) {
  console.error('FAILED', e.message)
  fails.push(e.message)
} finally {
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED')
  try { ws?.close() } catch {}
  app.kill()
  setTimeout(() => process.exit(fails.length ? 1 : 0), 1500)
}
