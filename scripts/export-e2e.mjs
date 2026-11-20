// End to end check of export and print: builds two pages (math, code, a diagram,
// ink, side by side cells), opens the export dialog, then writes a PDF, Markdown
// and HTML straight through the desktop bridge (no save dialogs).
// Output goes to %TEMP%/notes-export-e2e/out. Run after `npm run build`.
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
const T = path.join(os.tmpdir(), 'notes-export-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
const OUT = path.join(T, 'out')
fs.rmSync(T, { recursive: true, force: true })
for (const d of [UD, VAULT, OUT]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))

const PORT = 9341
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

const B64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const mermaid = B64('graph LR\n  A[Start] --> B{Choice}\n  B --> C[One]\n  B --> D[Two]')
const PAGE1 = [
  { x: 40, y: 120, w: 520, h: 200, title: 'Math and code', html: `<p>Euler: <span data-latex="e^{i\\pi}+1=0"></span> and a <strong>bold</strong> word in <span style="color: #ffffff">white text</span>.</p><div data-latex="\\int_0^1 x^2\\,dx = \\frac{1}{3}"></div><pre class="code-block" data-language="python"><code class="language-python">def hello(name):\n    return f"hi {name}"</code></pre>` },
  { x: 600, y: 120, w: 420, h: 200, title: 'Side by side', html: '<ul><li><p>First</p></li><li><p>Second</p></li></ul><table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>' },
  { x: 40, y: 400, w: 700, h: 260, title: 'Diagram', html: `<div data-html-embed="" data-kind="mermaid" data-html-src="${mermaid}">HTML Widget</div>` },
]

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
  const S = `__notesDebug.useStore.getState()`

  // Two pages: rich content on the first, ink and text on the second.
  const ids = await ev(`(async () => {
    const st = () => __notesDebug.useStore.getState()
    const nb = await st().addNode('notebook', null)
    const sec = await st().addNode('section', nb)
    const p1 = await st().addNode('page', sec)
    await new Promise(r => setTimeout(r, 300))
    st().setPageTitle('Export test page')
    for (const c of ${JSON.stringify(PAGE1)}) {
      st().addCell({ x: c.x, y: c.y })
      const cell = st().page.cells[st().page.cells.length - 1]
      st().updateCell(cell.id, { title: c.title, html: c.html, w: c.w, h: c.h, showTitle: true }, true)
    }
    __notesDebug.useStore.setState({ editingCellId: null })
    await st().save()
    const p2 = await st().addNode('page', sec)
    await new Promise(r => setTimeout(r, 300))
    st().setPageTitle('Second page')
    st().addCell({ x: 60, y: 140 })
    const c2 = st().page.cells[0]
    st().updateCell(c2.id, { title: 'Notes', html: '<p>Plain notes on page two.</p>', showTitle: true }, true)
    const pts = []; for (let i = 0; i <= 40; i++) pts.push(80 + i * 8, 420 + Math.sin(i / 4) * 40)
    __notesDebug.useStore.setState({ page: { ...st().page, strokes: [{ color: '#e06c75', size: 3, points: pts }] }, dirty: true })
    __notesDebug.useStore.setState({ editingCellId: null })
    await st().save()
    return { p1, p2 }
  })()`)
  console.log('pages', ids)
  await sleep(600)

  // The dialog opens with both pages and shows a preview.
  await ev(`${S}.openExport({ pageIds: [${JSON.stringify(ids.p1)}, ${JSON.stringify(ids.p2)}] })`)
  check(await waitFor(`Boolean(document.querySelector('.ex-modal'))`), 'export dialog opens')
  check(await waitFor(`Boolean(document.querySelector('.ex-preview-frame'))`, 15000), 'preview appears')
  check(
    await waitFor(`(() => { const d = document.querySelector('.ex-preview-frame')?.contentDocument; return Boolean(d && d.defaultView.__exportReady) })()`, 20000),
    'preview finishes drawing',
  )
  const pv = await ev(`(() => {
    const d = document.querySelector('.ex-preview-frame').contentDocument
    const f = d.querySelector('iframe.ex-frame')
    return {
      katex: d.querySelectorAll('.katex').length,
      hljs: d.querySelectorAll('.hljs-keyword, .hljs-string, .hljs-title').length,
      frameH: f ? f.getBoundingClientRect().height : 0,
      rows: d.querySelectorAll('.ex-row').length,
      sideBySide: [...d.querySelectorAll('.ex-row')].some(r => r.children.length > 1),
      toc: d.querySelectorAll('.ex-toc li').length,
      white: [...d.querySelectorAll('[style*="color"]')].map(e => e.style.color),
    }
  })()`)
  console.log('preview', pv)
  check(pv.katex >= 2, 'math is drawn')
  check(pv.hljs >= 1, 'code is colored')
  check(pv.frameH > 60, 'diagram is sized')
  check(pv.sideBySide, 'side by side cells stay side by side')
  check(pv.toc === 2, 'contents list has both pages')
  check(!pv.white.includes('rgb(255, 255, 255)'), 'white text darkened on light paper')
  await sleep(500)
  await shot('dialog-document')

  // Switch to "As on page" through the dialog.
  await ev(`[...document.querySelectorAll('.ex-seg button')].find(b => b.textContent === 'As on page').click()`)
  await sleep(400)
  check(
    await waitFor(`(() => { const d = document.querySelector('.ex-preview-frame')?.contentDocument; return Boolean(d && d.querySelector('.ex-canvas') && d.defaultView.__exportReady) })()`, 20000),
    'canvas layout preview',
  )
  check(await ev(`Boolean(document.querySelector('.ex-preview-frame').contentDocument.querySelector('.ex-page-ink polyline'))`), 'page ink in canvas layout')
  await sleep(500)
  await shot('dialog-canvas')
  await ev(`[...document.querySelectorAll('.ex-seg button')].find(b => b.textContent === 'Document').click()`)

  // Files through the bridge.
  const pdf = path.join(OUT, 'export.pdf')
  const pdfCanvas = path.join(OUT, 'export-canvas.pdf')
  const r = await ev(`(async () => {
    const X = await __notesDebug.exportDoc()
    const items = await X.loadItems([${JSON.stringify(ids.p1)}, ${JSON.stringify(ids.p2)}])
    const o = { ...X.DEFAULT_EXPORT }
    const html = await X.buildHtml(items, o, { title: 'Export test' })
    const a = await window.notes.exporter.pdf(html, o.paper, ${JSON.stringify(pdf)})
    const html2 = await X.buildHtml(items, { ...o, layout: 'canvas', fitSheet: true, paper: { ...o.paper, landscape: true } }, { title: 'Export test' })
    const b = await window.notes.exporter.pdf(html2, { ...o.paper, landscape: true }, ${JSON.stringify(pdfCanvas)})
    await window.notes.exporter.writeText(${JSON.stringify(path.join(OUT, 'export.html'))}, html)
    const md = X.buildMarkdown(items, { ...o, files: 'separate', frontMatter: true }, 'Export test')
    for (const f of md.files) await window.notes.exporter.writeText(${JSON.stringify(OUT)} + '\\\\md\\\\' + f.name, f.text)
    for (const d of md.drawings) await window.notes.exporter.writeText(${JSON.stringify(OUT)} + '\\\\md\\\\assets\\\\' + d.name, d.text)
    const one = X.buildMarkdown(items, o, 'Export test')
    await window.notes.exporter.writeText(${JSON.stringify(path.join(OUT, 'combined.md'))}, one.files[0].text)
    // Selected cells only.
    const some = await X.loadItems([${JSON.stringify(ids.p1)}], [items[0].cells[0].id])
    const md3 = X.buildMarkdown(some, o, 'x')
    return { a, b, files: md.files.map(f => f.name), drawings: md.drawings.length, partialCells: some[0].cells.length, partialMd: md3.files[0].text }
  })()`)
  console.log('bridge', JSON.stringify(r).slice(0, 600))
  check(r.a.ok && fs.existsSync(pdf) && fs.statSync(pdf).size > 5000, 'PDF written')
  const pdfText = fs.readFileSync(pdf, 'latin1')
  const sheets = (pdfText.match(/\/Type\s*\/Page[^s]/g) || []).length
  console.log('pdf sheets', sheets, 'bytes', fs.statSync(pdf).size)
  check(sheets >= 3, 'PDF has contents + one sheet per page')
  check(r.b.ok && fs.existsSync(pdfCanvas), 'canvas PDF written')
  check(r.files.length === 2, 'a Markdown file per page')
  check(r.drawings >= 1, 'page ink saved as a drawing')
  const md1 = fs.readFileSync(path.join(OUT, 'md', r.files[0]), 'utf8')
  console.log('---- md ----\n' + md1 + '\n------------')
  check(md1.startsWith('---\ntitle:'), 'front matter')
  check(md1.includes('$e^{i\\pi}+1=0$') && md1.includes('```python') && md1.includes('```mermaid'), 'math, code and diagram in Markdown')
  check(r.partialCells === 1 && (r.partialMd.match(/^## /gm) || []).length === 1, 'selected cells only')
  const comb = fs.readFileSync(path.join(OUT, 'combined.md'), 'utf8')
  check(comb.includes('## Contents') && comb.includes('## Export test page') && comb.includes('### Math and code'), 'combined Markdown with contents')
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
