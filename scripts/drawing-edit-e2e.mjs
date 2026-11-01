// End to end test of the agent's big drawing tools in a separate, off screen Notes
// instance with its own empty notes folder (your notes are untouched). Pastes a big
// HTML file, then drives read_drawing, edit_drawing and the guards with no model.
// Build first (npm run build). Usage: node scripts/drawing-edit-e2e.mjs <html file>
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
const text = fs.readFileSync(process.argv[2], 'utf8')
const T = path.join(os.tmpdir(), 'notes-drawing-edit-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
const OUT = path.join(T, 'out')
fs.rmSync(T, { recursive: true, force: true })
for (const d of [UD, VAULT, OUT]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))

const PORT = 9336
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
const fails = []
const check = (ok, what, extra = '') => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok ? '' : String(extra).slice(0, 400))
  if (!ok) fails.push(what)
}
/** Runs a tool; arguments go in as JSON. */
const tool = (name, args) => ev(`__t(${JSON.stringify(name)}, ${JSON.stringify(args)})`)
const source = () => ev('__src()')

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
  for (let t = 0; t < 300; t++) {
    if (await ev('Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready)')) break
    await sleep(100)
  }
  await ev(`(async () => {
    const S = __notesDebug.useStore
    const nb = await S.getState().addNode('notebook', null)
    const sec = await S.getState().addNode('section', nb)
    await S.getState().addNode('page', sec)
    await new Promise((r) => setTimeout(r, 300))
    S.getState().addCell({ x: 60, y: 80, w: 900, title: 'DES', html: '<p></p>' })
    const env = { rec: new __notesDebug.TurnRecorder(), attachments: new Map(), model: 'none' }
    window.__t = (name, args) => __notesDebug.runTool(name, { cell_id: window.__cell, ...args }, env).then((r) => ({ ok: r.ok, content: String(r.content), summary: r.summary }))
    window.__src = () => {
      const c = S.getState().page.cells.find((x) => x.id === window.__cell)
      const el = new DOMParser().parseFromString('<body>' + c.html + '</body>', 'text/html').querySelector('[data-html-src]')
      return el ? __notesDebug.fromBase64(el.getAttribute('data-html-src')) : null
    }
    return true
  })()`)
  await sleep(600)
  await ev(`(() => {
    const pm = document.querySelector('.canvas .ProseMirror')
    pm.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', ${JSON.stringify(text)})
    pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await sleep(1500)
  await ev(`(() => { const S = __notesDebug.useStore; const c = S.getState().page.cells[0]; window.__cell = c.id; S.getState().setSelection([]); document.activeElement?.blur() })()`)
  await sleep(1200)
  const original = await source()
  check(original && original.includes('DES encryption: full view'), 'the page was pasted as a drawing', original?.slice(0, 100))

  // Reads stay small and honest.
  const cell = await tool('read_cell', {})
  check(cell.content.length < 2000 && cell.content.includes('[source kept: drawing 1'), 'read_cell shows a stand-in, not 60k chars', cell.content.length)
  const html = await tool('read_cell', { format: 'html' })
  check(html.content.length < 2000, 'read_cell html hides the base64', html.content.length)
  const page = await tool('read_page', {})
  check(page.content.length < 3000, 'read_page stays small', page.content.length)
  const ctx = await ev(`__notesDebug.buildContext().full.length`)
  check(ctx < 6000, 'the context of every message stays small', ctx)

  const map = await tool('read_drawing', {})
  console.log(map.content.split('\n').slice(0, 8).join('\n'))
  check(map.content.includes('Map of its parts') && map.content.includes('ROUND 2'), 'read_drawing gives a map', map.content.slice(0, 200))
  const version = /version (v\w+)/.exec(map.content)[1]
  const hit = await tool('read_drawing', { find: 'ROUND 2: uses key K2' })
  check(hit.content.includes('1 match(es) in the visible text'), 'finds text as seen on screen', hit.content)
  const part = await tool('read_drawing', { offset: 5400, length: 300 })
  check(part.content.includes('Chars 5400-5700') && part.content.includes('next offset 5700'), 'reads a part', part.content.slice(0, 200))
  const full = await tool('read_drawing', { full: true })
  check(full.content.includes('too big') || full.content.length > original.length, 'full read is whole or says why', full.content.slice(0, 200))

  // A real edit: only those characters change, and it shows on screen.
  const edit = await tool('edit_drawing', { edits: [{ find: 'DES encryption: full view, 16 rounds', replace: 'DES encryption, all rounds' }, { find: 'only reorders the bits', replace: 'only moves the bits' }] })
  check(edit.ok, 'edit_drawing applies', edit.content)
  console.log(edit.content.slice(0, 400))
  const edited = await source()
  check(edited === original.replace('DES encryption: full view, 16 rounds', 'DES encryption, all rounds').replace('only reorders the bits', 'only moves the bits'), 'the rest is byte for byte')
  check(!edit.content.includes('FAILED'), 'the drawing still draws', edit.content)

  // Refused edits change nothing.
  const broken = await tool('edit_drawing', { edits: [{ find: '</table></div>\r\n<div style="text-align:center;color:#5F5E5A;font-size:13px;padding:8px 0;">&#9660; L<sub>0', replace: '<div>' }] })
  check(!broken.ok && broken.content.includes('balance') && (await source()) === edited, 'an edit that breaks the tags is refused', broken.content)
  const stale = await tool('edit_drawing', { version, edits: [{ from: 5, to: 9, replace: 'x' }] })
  check(!stale.ok && stale.content.includes('source changed') && (await source()) === edited, 'stale offsets are refused', stale.content)
  const crash = await tool('edit_drawing', { edits: [{ find: 'DES encryption, all rounds', replace: 'DES<script>noSuchFunction()</script>' }] })
  console.log('script error edit:', crash.ok, crash.content.slice(0, 200))
  check(!crash.ok && (await source()) === edited, 'an edit that breaks the drawing is refused', crash.content)
  const dry = await tool('edit_drawing', { dry_run: true, edits: [{ find: 'DES encryption, all rounds', replace: 'Trial' }] })
  check(dry.ok && (await source()) === edited, 'dry_run changes nothing', dry.content)

  // Adding a round by copying one, without resending it.
  const cur = /version (v\w+)/.exec((await tool('read_drawing', {})).content)[1]
  const start = edited.indexOf('<div style="border:2px solid #B4B2A9', edited.indexOf('go into round 2'))
  const stop = edited.indexOf('<div style="text-align:center;color:#5F5E5A;font-size:13px', start)
  const added = await tool('edit_drawing', { version: cur, edits: [{ from: stop, copy_of: { from: start, to: stop, map: [{ find: 'ROUND 2', replace: 'ROUND 2B' }] } }] })
  check(added.ok && (await source()).includes('ROUND 2B'), 'copy_of adds a section', added.content)

  // A model working from reads cannot destroy what it did not see.
  const now = await source()
  const keep = await tool('update_cell', { content: `Some notes above it.\n\n${cell.content.slice(cell.content.indexOf('```'))}` })
  check(keep.ok && (await source()) === now, 'the stand-in keeps the drawing through a rewrite', keep.content)
  const gone = await tool('update_cell', { content: 'Only this text now.' })
  check(!gone.ok && gone.content.includes('drop_drawings') && (await source()) === now, 'a rewrite cannot silently delete it', gone.content)
  const small = await tool('update_drawing', { source: '<div>tiny</div>' })
  check(!small.ok && (await source()) === now, 'a slip of update_drawing is refused', small.content)
  const stub = await tool('update_drawing', { source: '[source kept: drawing 1, 60000 chars. x]' })
  check(!stub.ok && (await source()) === now, 'the stand-in is never saved as the source', stub.content)
  const fresh = await tool('create_cells', { cells: [{ content: '```widget\n[source kept: drawing 1, 60000 chars.]\n```' }] })
  check(!fresh.ok, 'the stand-in cannot go in a new cell', fresh.content)

  // A tall drawing can be seen to its bottom. The app itself only returns pictures to a model that can see.
  const tall = await ev(`(async () => {
    const d = { kind: 'html', src: __src() }
    const html = await __notesDebug.buildWidgetDoc(d.kind, d.src, __notesDebug.currentTheme(document.querySelector('.cell')), { opaque: true })
    const s = await window.notes.agent.renderWidget({ html, width: 872, fromY: 3000 })
    return { ok: s.ok, h: s.height, full: s.fullHeight, y: s.fromY }
  })()`)
  console.log('tall', JSON.stringify(tall))
  check(tall.ok && tall.full > 3000 && tall.y > 0, 'a tall drawing can be shot further down', JSON.stringify(tall))

  await sleep(1500)
  const shown = await ev(`document.querySelectorAll('.canvas .html-embed').length`)
  check(shown === 1, 'the widget is still on the page', shown)
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'after.png'), Buffer.from(r.data, 'base64'))
  console.log('shot', path.join(OUT, 'after.png'))
} catch (e) {
  console.error(e)
  fails.push(String(e))
} finally {
  try { ws?.close() } catch {}
  app.kill()
  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed')
  process.exit(fails.length ? 1 : 0)
}
