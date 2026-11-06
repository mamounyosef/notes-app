// End to end test, no model: a rewrite of a cell keeps the lines and pictures the user
// placed, content_mode "after" inserts in the middle, and a picked equation never stays
// outlined after outside edits or a click elsewhere. Runs a separate, off screen Notes
// with its own empty notes folder (your notes are untouched).
// Build first (npm run build). Usage: node scripts/keep-blocks-e2e.mjs
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
const T = path.join(os.tmpdir(), 'notes-keep-blocks-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
fs.rmSync(T, { recursive: true, force: true })
for (const d of [UD, VAULT]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))

const PORT = 9337
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
  console.log(ok ? 'PASS' : 'FAIL', what, ok ? '' : String(extra).slice(0, 600))
  if (!ok) fails.push(what)
}
const tool = (name, args) => ev(`__t(${JSON.stringify(name)}, ${JSON.stringify(args)})`)
const html = () => ev('__html()')
/** Block order of the cell: h=line, H=thick line, m=equation, i=image, p=paragraph text. */
const order = () =>
  ev(`(() => {
    const d = new DOMParser().parseFromString('<body>' + __html() + '</body>', 'text/html')
    return [...d.body.children].map((e) => e.tagName === 'HR' ? (e.classList.contains('thick-hr') ? 'H' : 'h') : e.matches('[data-latex]') || e.querySelector('[data-latex]') && !e.textContent.trim() ? 'm' : e.tagName === 'IMG' || (e.querySelector('img') && !e.textContent.trim()) ? 'i' : 'p:' + e.textContent.trim().split(' ')[0]).join(' ')
  })()`)
const setCell = (h) => ev(`(async () => { const S = __notesDebug.useStore; S.getState().applyPageEdit((p) => ({ ...p, cells: p.cells.map((c) => c.id === window.__cell ? { ...c, html: ${JSON.stringify(h)} } : c) }), [window.__cell]); await new Promise((r) => setTimeout(r, 400)); return true })()`)

const BASE = '<p>Question: design it</p><div data-type="block-math" data-latex="f(x)=1"></div><hr><p>end text</p>'

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
    S.getState().addCell({ x: 60, y: 80, w: 700, title: 'Example', html: '<p></p>' })
    await new Promise((r) => setTimeout(r, 300))
    window.__cell = S.getState().page.cells[0].id
    S.getState().setSelection([])
    const env = { rec: new __notesDebug.TurnRecorder(), attachments: new Map(), model: 'none' }
    window.__t = (name, args) => __notesDebug.runTool(name, { cell_id: window.__cell, ...args }, env).then((r) => ({ ok: r.ok, content: String(r.content), summary: r.summary, detail: r.detail }))
    window.__html = () => S.getState().page.cells.find((x) => x.id === window.__cell).html
    return true
  })()`)

  // 1. A rewrite that leaves out the user's line: the line goes back after the formula.
  await setCell(BASE)
  const start = await order()
  check(start === 'p:Question: m h p:end', 'the cell starts as text, formula, line, text', start)
  let r = await tool('update_cell', { content: 'Question: design it\n\n$$f(x)=1$$\n\n$$\\begin{array}{c}1\\end{array}$$\n\nend text' })
  check(r.ok, 'the rewrite applies', r.content)
  let o = await order()
  check(o === 'p:Question: m h m p:end', 'the dropped line is back right after its formula', o)
  check(r.content.includes('put back') && r.content.includes('drop_blocks'), 'the model is told the line was put back', r.content)
  check(String(r.detail).includes('kept your line'), 'the chat says the line was kept', r.detail)

  // 2. A rewrite that keeps the line touches nothing.
  r = await tool('update_cell', { content: 'Question: design it\n\n$$f(x)=1$$\n\n---\n\nnew end' })
  o = await order()
  check(o === 'p:Question: m h p:new' && !r.content.includes('put back'), 'a line kept by the model is not doubled', o + ' | ' + r.content)

  // 3. drop_blocks really removes it.
  r = await tool('update_cell', { content: 'Question: design it\n\n$$f(x)=1$$\n\nnew end', drop_blocks: true })
  o = await order()
  check(o === 'p:Question: m p:new', 'drop_blocks removes the line', o)

  // 3b. --- right under a formula or text line is a line, not a heading underline.
  r = await tool('update_cell', { content: 'Question: design it\n$$f(x)=1$$\n---\nnew end\n---\nlast', drop_blocks: true })
  o = await order()
  check(o === 'p:Question: m h p:new h p:last', '--- under a line of text or a formula draws a line', o)
  r = await tool('update_cell', { content: 'a | b\n--- | ---\n1 | 2', drop_blocks: true })
  check((await html()).includes('<table'), 'a table without outer pipes is still a table', await html())

  // 4. content_mode "after": in the middle, the rest untouched.
  await setCell(BASE)
  r = await tool('update_cell', { content: '$$\\begin{array}{c}1\\end{array}$$', content_mode: 'after', after: '---' })
  o = await order()
  check(r.ok && o === 'p:Question: m h m p:end', 'after --- puts the table under the line', o + ' | ' + r.content)
  r = await tool('update_cell', { content: 'right after the formula', content_mode: 'after', after: 'f(x)=1' })
  o = await order()
  check(r.ok && o === 'p:Question: m p:right h m p:end', 'after LaTeX puts text under the formula', o)
  r = await tool('update_cell', { content: 'below question', content_mode: 'after', after: 'Question: design' })
  o = await order()
  check(r.ok && o.startsWith('p:Question: p:below m'), 'after text puts it under that paragraph', o)
  const before = await html()
  r = await tool('update_cell', { content: 'x', content_mode: 'after', after: 'nothing like this' })
  check(!r.ok && (await html()) === before, 'an unknown anchor changes nothing and says so', r.content)
  r = await tool('update_cell', { content: 'x', content_mode: 'after' })
  check(!r.ok && (await html()) === before, 'a missing anchor changes nothing and says so', r.content)

  // 5. Pictures and thick lines are kept too.
  const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await setCell(`<p>Intro here</p><img src="${PIC}" alt="board"><hr class="thick-hr"><p>Outro text</p>`)
  r = await tool('update_cell', { content: 'Intro here, reworded\n\nOutro text' })
  o = await order()
  check(o === 'p:Intro i H p:Outro', 'a dropped picture and thick line come back in place', o)

  // 6. Outside content swaps never leave an equation picked.
  await setCell('<p>Top</p><div data-type="block-math" data-latex="a+b"></div>')
  await ev('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
  await tool('update_cell', { content: 'Top again\n\n$$a+b+c$$' })
  await sleep(600)
  const stuck = await ev(`document.querySelectorAll('.canvas .ProseMirror-selectednode').length`)
  check(stuck === 0, 'an assistant edit ending in an equation leaves nothing outlined', stuck)
  await ev(`__notesDebug.useStore.getState().undo && __notesDebug.useStore.getState().undo()`)
  await sleep(600)
  const stuck2 = await ev(`document.querySelectorAll('.canvas .ProseMirror-selectednode').length`)
  check(stuck2 === 0, 'undo of it leaves nothing outlined either', stuck2)

  // 7. Pick an equation, move focus to the toolbar (kept), then click the canvas (let go).
  const picked = await ev(`(async () => {
    const m = document.querySelector('.canvas .math-block')
    if (!m) return 'no equation on screen'
    m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    m.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    return m.classList.contains('ProseMirror-selectednode')
  })()`)
  check(picked === true, 'one click picks the equation', picked)
  const keptOnToolbar = await ev(`(async () => {
    const b = document.querySelector('.toolbar button')
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    b.focus()
    await new Promise((r) => setTimeout(r, 200))
    return document.querySelectorAll('.canvas .ProseMirror-selectednode').length
  })()`)
  check(keptOnToolbar === 1, 'focus in the toolbar keeps it picked', keptOnToolbar)
  const released = await ev(`(async () => {
    const c = document.querySelector('.canvas')
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    return document.querySelectorAll('.canvas .ProseMirror-selectednode').length
  })()`)
  check(released === 0, 'a later click on the canvas lets go of it', released)
} catch (e) {
  console.log('ERROR', e)
  fails.push('crashed')
} finally {
  try { ws?.close() } catch {}
  app.kill()
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED')
  process.exit(fails.length ? 1 : 0)
}
