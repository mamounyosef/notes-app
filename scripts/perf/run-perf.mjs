// Performance benchmark in a separate, off screen Notes instance with its own synthetic
// notes folder (your notes and running app are untouched). Build first (npm run build).
// Usage: node scripts/perf/run-perf.mjs [label] [rounds=3]
// Writes %TEMP%/notes-perf-e2e/result-<label>.json and prints a summary.
// Measures: page switch, tab switch, Ctrl+F open, search latency, typing latency,
// long tasks, main thread time (CDP TaskDuration), React commits and renders, memory.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '../..')
const require = createRequire(path.join(PROJECT, 'package.json'))
const WebSocket = require('ws')
const LABEL = process.argv[2] || 'run'
const ROUNDS = Number(process.argv[3] || 3)
const T = path.join(os.tmpdir(), 'notes-perf-e2e')
const UD = path.join(T, 'ud')
const VAULT = path.join(T, 'vault')
fs.rmSync(UD, { recursive: true, force: true })
fs.rmSync(VAULT, { recursive: true, force: true })
fs.mkdirSync(UD, { recursive: true })
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ vault: VAULT }))
execFileSync(process.execPath, [path.join(HERE, 'make-vault.mjs'), VAULT, '300'], { stdio: 'inherit' })

const PORT = 9334
const exe = path.join(PROJECT, 'node_modules/electron/dist/electron.exe')
const app = spawn(exe, ['.', `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], {
  cwd: PROJECT,
  env: { ...process.env, NOTES_TEST_OFFSCREEN: '1', ...(process.env.PERF_ENV ? JSON.parse(process.env.PERF_ENV) : {}) },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let id = 0
const pending = new Map()
function cdp(method, params = {}) {
  return new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}
async function ev(expr, timeout = 120000) {
  const r = await Promise.race([
    cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(timeout).then(() => ({ timeout: true })),
  ])
  if (r.timeout) throw new Error('timeout: ' + expr.slice(0, 80))
  const res = r.result || r
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 800))
  return res.result?.value
}
async function metrics() {
  const r = await cdp('Performance.getMetrics')
  const m = {}
  for (const x of r.result.metrics) m[x.name] = x.value
  return m
}

// Installed before the app loads: counts React commits (and, when asked, which
// components rendered) through the DevTools hook, and collects long tasks.
const PRELOAD = `(() => {
  window.__perf = { commits: 0, renders: {}, count: false, longtasks: [] }
  let prev = new WeakSet()
  const walk = (f, seen) => {
    while (f) {
      seen.add(f)
      if (!prev.has(f) && (f.flags & 1) && typeof f.type === 'function') {
        const n = f.type.displayName || f.type.name || 'anon'
        window.__perf.renders[n] = (window.__perf.renders[n] || 0) + 1
      } else if (!prev.has(f) && (f.flags & 1) && f.type && typeof f.type === 'object' && f.type.type) {
        const t = f.type.type
        const n = 'memo:' + (t.displayName || t.name || 'anon')
        window.__perf.renders[n] = (window.__perf.renders[n] || 0) + 1
      }
      walk(f.child, seen)
      f = f.sibling
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject() { return 1 }, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {},
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      window.__perf.commits++
      if (!window.__perf.count) return
      const seen = new WeakSet()
      walk(root.current, seen)
      prev = seen
    },
  }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longtasks.push({ t: e.startTime, d: e.duration }) }).observe({ entryTypes: ['longtask'] })
  } catch {}
})()`

// In page helpers: wait for the open page to be fully drawn (every cell and editor), then two frames.
const HELPERS = `(() => {
  const S = () => __notesDebug.useStore.getState()
  window.__frames = (n = 2) => new Promise((r) => { const step = (k) => requestAnimationFrame(() => (k <= 1 ? setTimeout(r, 0) : step(k - 1))); step(n) })
  window.__pageDrawn = async (pageId, timeout = 15000) => {
    const t0 = performance.now()
    for (;;) {
      const st = S()
      if (st.page && st.page.id === pageId) {
        const want = st.page.cells.length
        const cells = document.querySelectorAll('.canvas .cell').length
        const pms = document.querySelectorAll('.canvas .cell .ProseMirror').length
        if (cells === want && pms === st.page.cells.filter((c) => !c.collapsed).length) break
      }
      if (performance.now() - t0 > timeout) throw new Error('page not drawn ' + pageId)
      await new Promise((r) => setTimeout(r, 1))
    }
    await __frames(2)
  }
  window.__lt = () => __perf.longtasks.length
  window.__ltSince = (i) => { const l = __perf.longtasks.slice(i); return { n: l.length, ms: Math.round(l.reduce((s, x) => s + x.d, 0)) } }
  return true
})()`

const stats = (a) => {
  const s = [...a].sort((x, y) => x - y)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, median: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), max: +s[s.length - 1].toFixed(1), mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(1) }
}

const result = { label: LABEL, at: new Date().toISOString() }
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
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 1e9 })
  await new Promise((r) => ws.on('open', r))
  ws.on('message', (m) => {
    const d = JSON.parse(m)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Performance.enable', { timeDomain: 'threadTicks' })
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: PRELOAD })
  await cdp('Page.reload', { ignoreCache: true })
  await sleep(1000)
  const tReady0 = Date.now()
  for (let i = 0; i < 120; i++) {
    try {
      if (await ev('Boolean(window.__notesDebug && __notesDebug.useStore.getState().ready && __notesDebug.useStore.getState().page)', 3000)) break
    } catch {}
    await sleep(250)
  }
  await ev(HELPERS)
  await ev(`__pageDrawn(__notesDebug.useStore.getState().page.id)`)
  result.startupToFirstPageMs = Date.now() - tReady0
  // Let the first load, diagram iframes and cell counts settle.
  await sleep(3000)

  const heavy = [1, 2, 3, 4, 5, 6].map((n) => `heavy${n}`)
  const light = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `light${n * 7}`)

  /* -------- page switching (what a click in the page list does) -------- */
  async function switchPages(ids, label) {
    const times = []
    const m0 = await metrics()
    const lt0 = await ev('__lt()')
    const c0 = await ev('__perf.commits')
    for (let r = 0; r < ROUNDS; r++) {
      for (const pid of ids) {
        const ms = await ev(`(async () => { const t0 = performance.now(); __notesDebug.useStore.getState().openPage(${JSON.stringify(pid)}); await __pageDrawn(${JSON.stringify(pid)}); return performance.now() - t0 })()`)
        times.push(ms)
        await sleep(150)
      }
    }
    const m1 = await metrics()
    result[label] = {
      ...stats(times),
      taskMsPerSwitch: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / times.length).toFixed(1),
      layoutsPerSwitch: +((m1.LayoutCount - m0.LayoutCount) / times.length).toFixed(1),
      layoutMsPerSwitch: +(((m1.LayoutDuration - m0.LayoutDuration) * 1000) / times.length).toFixed(1),
      styleMsPerSwitch: +(((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000) / times.length).toFixed(1),
      scriptMsPerSwitch: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / times.length).toFixed(1),
      longtasks: await ev(`__ltSince(${lt0})`),
      commitsPerSwitch: +(((await ev('__perf.commits')) - c0) / times.length).toFixed(1),
    }
    console.log(label, JSON.stringify(result[label]))
  }
  await switchPages(heavy, 'pageSwitchHeavy')
  await switchPages(light, 'pageSwitchLight')

  /* -------- tabs: one per heavy page, then cycle through them -------- */
  await ev(`(async () => { const s = __notesDebug.useStore.getState(); await s.openPage('heavy1'); await __pageDrawn('heavy1'); for (const p of ${JSON.stringify(heavy.slice(1))}) await __notesDebug.useStore.getState().newTab(p, { background: true }); return __notesDebug.useStore.getState().tabs.length })()`)
  {
    const times = []
    const m0 = await metrics()
    const lt0 = await ev('__lt()')
    const c0 = await ev('__perf.commits')
    for (let r = 0; r < ROUNDS * 6; r++) {
      const ms = await ev(`(async () => { const t0 = performance.now(); const st = __notesDebug.useStore.getState(); const i = st.tabs.findIndex((t) => t.id === st.activeTab); const next = st.tabs[(i + 1) % st.tabs.length]; st.switchTab(next.id); await __pageDrawn(next.pageId); return performance.now() - t0 })()`)
      times.push(ms)
      await sleep(150)
    }
    const m1 = await metrics()
    result.tabSwitch = {
      ...stats(times),
      tabs: await ev('__notesDebug.useStore.getState().tabs.length'),
      taskMsPerSwitch: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / times.length).toFixed(1),
      longtasks: await ev(`__ltSince(${lt0})`),
      commitsPerSwitch: +(((await ev('__perf.commits')) - c0) / times.length).toFixed(1),
    }
    console.log('tabSwitch', JSON.stringify(result.tabSwitch))
  }

  /* -------- Ctrl+F and search -------- */
  {
    const open = []
    const search = {}
    const ipc = {}
    const queries = ['gradient', 'backpropogation', 'matrix vector', 'transformer attention softmax', 'xqzv']
    for (const q of queries) {
      search[q] = []
      ipc[q] = []
    }
    for (let r = 0; r < ROUNDS; r++) {
      for (const q of queries) {
        const o = await ev(`(async () => {
          const t0 = performance.now()
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
          for (;;) { const el = document.querySelector('.search-input'); if (el && document.activeElement === el) break; await new Promise((r) => setTimeout(r, 1)) }
          await __frames(2)
          const tOpen = performance.now() - t0
          const input = document.querySelector('.search-input')
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          const t1 = performance.now()
          set.call(input, ${JSON.stringify(q)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
          // The first frame after typing still shows the old (empty) results: wait for the
          // search to start, then for it to finish.
          let started = false
          for (;;) {
            const c = document.querySelector('.search-count')
            if (c && /Searching/.test(c.textContent)) started = true
            const done = started && c && /\\d+ pages?/.test(c.textContent)
            if (done) break
            if (performance.now() - t1 > 15000) throw new Error('search timeout')
            await new Promise((r) => setTimeout(r, 1))
          }
          await __frames(2)
          const tSearch = performance.now() - t1
          const results = document.querySelectorAll('.result-group').length
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await __frames(1)
          const t2 = performance.now()
          await window.notes.search(${JSON.stringify(q)})
          const tIpc = performance.now() - t2
          return { tOpen, tSearch, tIpc, results }
        })()`)
        // The modal closes on Escape through React's own handler; make sure it is gone.
        await ev(`(async () => { for (let i = 0; i < 100 && document.querySelector('.search-input'); i++) { document.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((r) => setTimeout(r, 20)) } return !document.querySelector('.search-input') })()`)
        open.push(o.tOpen)
        search[q].push(o.tSearch)
        ipc[q].push(o.tIpc)
        if (r === 0) console.log('search', q, 'results', o.results)
        await sleep(100)
      }
    }
    result.ctrlFOpen = stats(open)
    result.search = Object.fromEntries(queries.map((q) => [q, { ui: stats(search[q]).median, ipc: stats(ipc[q]).median }]))
    result.searchUiAll = stats(Object.values(search).flat())
    result.searchIpcAll = stats(Object.values(ipc).flat())
    console.log('ctrlF', JSON.stringify(result.ctrlFOpen), 'search', JSON.stringify(result.search))
  }

  /* -------- typing in a cell of a heavy page -------- */
  {
    await ev(`(async () => { __notesDebug.useStore.getState().openPage('heavy1'); await __pageDrawn('heavy1'); return true })()`)
    await sleep(500)
    // Caret at the end of the first paragraph of the first cell.
    await ev(`(async () => {
      const pm = document.querySelector('.canvas .cell .ProseMirror')
      const p = pm.querySelector('p')
      pm.focus()
      const r = document.createRange(); r.selectNodeContents(p); r.collapse(false)
      const s = getSelection(); s.removeAllRanges(); s.addRange(r)
      await __frames(2)
      window.__keyLat = []
      window.__keyWork = []
      // To the next drawn frame (what you see), and to the end of the work the key started
      // (a task posted from keydown runs after the input events and React's commit).
      const mc = new MessageChannel()
      let t = 0
      mc.port1.onmessage = () => __keyWork.push(performance.now() - t)
      window.addEventListener('keydown', () => { t = performance.now(); const t0 = t; mc.port2.postMessage(0); requestAnimationFrame(() => setTimeout(() => __keyLat.push(performance.now() - t0), 0)) }, true)
      return document.activeElement === pm
    })()`)
    const N = 60
    const m0 = await metrics()
    const lt0 = await ev('__lt()')
    const c0 = await ev('__perf.commits')
    await ev('(__perf.renders = {}, __perf.count = true)')
    for (let i = 0; i < N; i++) {
      const ch = 'abcdefghij '[i % 11]
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0) })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0) })
      await sleep(40)
    }
    await sleep(500)
    await ev('(__perf.count = false, true)')
    const m1 = await metrics()
    const lat = await ev('__keyLat')
    const work = await ev('__keyWork')
    const renders = await ev('__perf.renders')
    const top = Object.entries(renders).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, +(v / N).toFixed(1)])
    result.typing = {
      ...stats(lat),
      work: stats(work),
      typed: await ev(`document.querySelector('.canvas .cell .ProseMirror p').textContent.slice(-20)`),
      taskMsPerKey: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / N).toFixed(2),
      longtasks: await ev(`__ltSince(${lt0})`),
      commitsPerKey: +(((await ev('__perf.commits')) - c0) / N).toFixed(1),
      componentRendersPerKey: +(Object.values(renders).reduce((a, b) => a + b, 0) / N).toFixed(1),
      topRendersPerKey: top,
    }
    console.log('typing', JSON.stringify(result.typing))
  }

  /* -------- mouse moving over the page (assistant trackers, hover) -------- */
  {
    await ev(`(document.activeElement && document.activeElement.blur(), true)`)
    const m0 = await metrics()
    const c0 = await ev('__perf.commits')
    const N = 200
    for (let i = 0; i < N; i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500 + (i % 50) * 10, y: 300 + Math.floor(i / 50) * 40 })
    }
    await sleep(300)
    const m1 = await metrics()
    result.mouseMove = {
      taskMsPerMove: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / N).toFixed(3),
      commits: (await ev('__perf.commits')) - c0,
    }
    console.log('mouseMove', JSON.stringify(result.mouseMove))
  }

  /* -------- idle (nothing happening): timers, observers -------- */
  {
    await sleep(1000)
    const m0 = await metrics()
    const c0 = await ev('__perf.commits')
    await sleep(5000)
    const m1 = await metrics()
    result.idle5s = { taskMs: +((m1.TaskDuration - m0.TaskDuration) * 1000).toFixed(1), commits: (await ev('__perf.commits')) - c0 }
    console.log('idle5s', JSON.stringify(result.idle5s))
  }

  /* -------- memory -------- */
  {
    await cdp('HeapProfiler.enable')
    await cdp('HeapProfiler.collectGarbage')
    await sleep(500)
    const m = await metrics()
    result.memory = { jsHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), domNodes: m.Nodes, documents: m.Documents, frames: m.Frames, listeners: m.JSEventListeners }
    console.log('memory', JSON.stringify(result.memory))
  }
} catch (e) {
  console.error('FAILED', e.stack || e.message)
  result.error = String(e.message)
} finally {
  fs.mkdirSync(T, { recursive: true })
  const out = path.join(T, `result-${LABEL}.json`)
  fs.writeFileSync(out, JSON.stringify(result, null, 1))
  console.log('wrote', out)
  try { ws?.close() } catch {}
  app.kill()
  setTimeout(() => process.exit(0), 1500)
}
