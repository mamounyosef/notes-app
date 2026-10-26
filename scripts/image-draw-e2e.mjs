// End to end test of the picture editor's Draw mode in a separate, off screen
// Notes instance with its own empty notes folder (your notes are untouched).
// Build first (npm run build). Usage: node scripts/image-draw-e2e.mjs
// Screenshots go to %TEMP%/notes-image-draw-e2e/out.
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
const T = path.join(os.tmpdir(), 'notes-image-draw-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
const OUT = path.join(T, 'out')
fs.rmSync(T, { recursive: true, force: true })
for (const d of [UD, VAULT, OUT]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))

const PORT = 9334
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
  await ev(`__notesDebug.useStore.getState().setSettings({ theme: 'dark' })`)

  // A page with one picture: a made up whiteboard photo.
  await ev(`(async () => {
    const S = __notesDebug.useStore
    const nb = await S.getState().addNode('notebook', null)
    const sec = await S.getState().addNode('section', nb)
    await S.getState().addNode('page', sec)
    await new Promise((r) => setTimeout(r, 300))
    const c = document.createElement('canvas'); c.width = 900; c.height = 600
    const g = c.getContext('2d')
    const gr = g.createLinearGradient(0, 0, 900, 600); gr.addColorStop(0, '#dfe9ee'); gr.addColorStop(1, '#b9c8d0')
    g.fillStyle = gr; g.fillRect(0, 0, 900, 600)
    g.fillStyle = '#223'; g.font = '48px serif'; g.fillText('f(x, y, z) = xy + x\\'yz', 120, 160)
    g.strokeStyle = '#334'; g.lineWidth = 3; g.strokeRect(120, 240, 300, 220); g.strokeRect(520, 240, 260, 220)
    // Saved like a pasted picture: an asset in the notes folder.
    const src = await window.notes.asset.save(c.toDataURL('image/png'))
    S.getState().addCell({ x: 60, y: 80, w: 640, title: 'Board', html: '<p><img src="' + src + '"></p>' })
    S.getState().setSelection([])
    return true
  })()`)
  check(await waitFor(`Boolean(document.querySelector('.canvas .resizable-image img')?.naturalWidth)`), 'picture in the note')

  // Open the editor from the picture's menu.
  const ip = await btn('.canvas .resizable-image img')
  await mouse('mousePressed', ip[0], ip[1], { button: 'right', buttons: 2 })
  await mouse('mouseReleased', ip[0], ip[1], { button: 'right', buttons: 0 })
  await sleep(300)
  const item = await btnText('Edit: crop, draw')
  check(Boolean(item), 'menu has "Edit: crop, draw, light..."')
  await click(...item)
  check(await waitFor(`Boolean(document.querySelector('.ie-frame')) && !document.querySelector('.ie-loading')`), 'editor open')
  await sleep(400)
  // Probes for the editor's draft, read from React's current tree (a DOM node's own fiber can be the stale copy).
  await ev(`window.__ieDraft = () => {
    const f = document.querySelector('.ie-frame'); if (!f) return null
    let n = f[Object.keys(f).find((x) => x.startsWith('__reactFiber'))]
    while (n.return) n = n.return
    const stack = [n.stateNode.current]
    while (stack.length) {
      const x = stack.pop()
      for (let h = x.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
        const v = h.memoizedState
        if (v && typeof v === 'object' && !Array.isArray(v)) { const d = Object.values(v).find((d) => d && d.edit && d.past); if (d) return d }
      }
      if (x.sibling) stack.push(x.sibling)
      if (x.child) stack.push(x.child)
    }
    return null
  }
  window.__ieMarks = () => { const d = __ieDraft(); return d && { n: (d.edit.marks || []).length, kinds: (d.edit.marks || []).map((m) => m.t), past: d.past.length } }; true`)

  await click(...(await btnText('Draw')))
  check(await waitFor(`Boolean(document.querySelector('.ie-draw'))`), 'draw bar shown')
  check(await ev(`document.querySelector('.ie-frame').classList.contains('ink-pen')`), 'pen picked by default')
  await shot('1-draw-bar')

  // Pen with a tablet: pressure rises and falls along a wave.
  await drag(await path2((t) => [0.1 + t * 0.8, 0.82 + Math.sin(t * Math.PI * 4) * 0.05], 60), { pointerType: 'pen' }, (t) => Math.sin(t * Math.PI) * 0.95 + 0.05)
  let m = await marks()
  check(m && m.n === 1 && m.kinds[0] === 'pen', 'pen stroke recorded ' + JSON.stringify(m))

  // Marker (2), arrow (4), filled box (6), circle (7).
  await key('2')
  await drag(await path2((t) => [0.13 + t * 0.4, 0.27], 20))
  await key('4')
  await drag(await path2((t) => [0.9 - t * 0.25, 0.1 + t * 0.25], 10))
  await key('6')
  await click(...(await btnText('Fill')))
  await drag(await path2((t) => [0.6 + t * 0.25, 0.42 + t * 0.3], 10))
  await key('7')
  await drag(await path2((t) => [0.14 + t * 0.3, 0.42 + t * 0.32], 10), { modifiers: 8 })
  m = await marks()
  check(m && m.n === 5 && m.kinds.join() === 'pen,hl,arrow,rect,ellipse', 'shapes recorded ' + JSON.stringify(m))

  // Text (8): click, type, Enter. Steps (9): three badges numbered 1 to 3.
  await key('8')
  await click(...(await at(0.47, 0.06)))
  check(await waitFor(`Boolean(document.querySelector('.ie-type'))`), 'text box opens')
  await cdp('Input.insertText', { text: 'minimize this' })
  await key('Enter')
  await key('9')
  for (const [u, v] of [[0.3, 0.5], [0.72, 0.5], [0.5, 0.2]]) await click(...(await at(u, v)))
  m = await marks()
  check(m && m.n === 9 && m.kinds.slice(5).join() === 'text,step,step,step', 'text and steps recorded ' + JSON.stringify(m))
  const steps = await ev(`__ieDraft().edit.marks.filter((m) => m.t === 'step').map((m) => m.n)`)
  check(JSON.stringify(steps) === '[1,2,3]', 'steps count up ' + JSON.stringify(steps))

  // Eraser (3) through the pen stroke.
  await key('3')
  await drag(await path2((t) => [0.5, 0.7 + t * 0.25], 10))
  m = await marks()
  check(m && m.kinds[m.n - 1] === 'erase', 'eraser stroke recorded')
  await shot('2-drawn')

  // Undo and redo go through the editor's own history.
  await key('z', 2)
  check((await marks()).n === 9, 'undo removes the eraser stroke')
  await key('y', 2)
  check((await marks()).n === 10, 'redo brings it back')

  // Change the text by clicking it.
  await key('8')
  await click(...(await at(0.49, 0.075)))
  check(await waitFor(`document.querySelector('.ie-type')?.value === 'minimize this'`), 'click on text opens it for changes')
  await cdp('Input.insertText', { text: '!' })
  await key('Enter')
  const txt = await ev(`__ieDraft().edit.marks.filter((m) => m.t === 'text').map((m) => m.text)`)
  check(JSON.stringify(txt) === '["minimize this!"]', 'text changed in place ' + JSON.stringify(txt))

  // Turn, mirror and crop: the drawing follows the picture.
  await key('r')
  await sleep(300)
  await shot('3-turned')
  await key('h')
  await sleep(300)
  await shot('4-turned-mirrored')
  await key('r', 8)
  await key('h')
  await key('c')
  await click(...(await btnText('16:9')))
  await sleep(300)
  await shot('5-cropped')
  // Zoomed in, the layer is redrawn sharper.
  await click(...(await btnText('Draw')))
  const w1 = await ev(`document.querySelector('.ie-ink').width`)
  await key('+')
  await key('+')
  await key('+')
  await key('+')
  await sleep(300)
  const w2 = await ev(`document.querySelector('.ie-ink').width`)
  check(w2 > w1, `ink layer sharper when zoomed (${w1} to ${w2})`)
  await shot('6-zoomed')
  await key('0')

  // Done: the drawing is baked into the note's picture and kept as an edit.
  const before = await ev(`document.querySelector('.canvas .resizable-image img').getAttribute('src').slice(0, 80)`)
  await click(...(await btn('.ie-done')))
  check(await waitFor(`!document.querySelector('.ie-frame')`, 15000), 'editor closes on Done')
  await waitFor(`document.querySelector('.canvas .resizable-image img').getAttribute('src').slice(0, 80) !== ${JSON.stringify(before)}`, 10000)
  const saved = await ev(`(async () => {
    const img = document.querySelector('.canvas .resizable-image img')
    await img.decode().catch(() => {})
    const node = img.closest('.resizable-image')
    const html = __notesDebug.useStore.getState().page.cells[0].html
    const m = /data-edit="([^"]*)"/.exec(html)
    const edit = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null
    // Look for the red ink in the saved picture.
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
    const g = c.getContext('2d'); g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let red = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++
    return { w: img.naturalWidth, h: img.naturalHeight, marks: edit && edit.marks && edit.marks.length, red, srcChanged: true }
  })()`)
  check(saved.marks === 10, 'edit with marks kept on the note picture ' + JSON.stringify(saved))
  check(saved.red > 500, 'drawing baked into the saved picture (red pixels: ' + saved.red + ')')
  check(Math.abs(saved.w / saved.h - 16 / 9) < 0.02, 'crop applied ' + saved.w + 'x' + saved.h)
  await sleep(500)
  await shot('7-note')

  // Open again: the drawing is still there to change.
  const ip2 = await btn('.canvas .resizable-image img')
  await mouse('mousePressed', ip2[0], ip2[1], { button: 'right', buttons: 2 })
  await mouse('mouseReleased', ip2[0], ip2[1], { button: 'right', buttons: 0 })
  await sleep(300)
  await click(...(await btnText('Edit: crop, draw')))
  await waitFor(`Boolean(document.querySelector('.ie-frame')) && !document.querySelector('.ie-loading')`)
  await sleep(400)
  // No draft until something changes, so look at the drawing layer itself.
  const inked = await ev(`(() => { const c = document.querySelector('.ie-ink'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n })()`)
  check(inked > 1000, 'drawing comes back when reopened (inked pixels: ' + inked + ')')
  await key('d')
  await key('8')
  await click(...(await at(0.5, 0.5)))
  await cdp('Input.insertText', { text: 'again' })
  await key('Enter')
  check((await marks())?.n === 11, 'reopened drawing can be added to ' + JSON.stringify(await marks()))
  await shot('8-reopened')
} catch (e) {
  console.error('FAILED', e.message)
  fails.push(e.message)
} finally {
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED')
  try {
    ws?.close()
  } catch {}
  app.kill()
  setTimeout(() => process.exit(fails.length ? 1 : 0), 1500)
}
