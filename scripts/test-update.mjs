// End to end test of Settings, Update on the packaged app: starts
// release\win-unpacked\Notes.exe with a throwaway profile, presses Update through
// window.desk.update.run(), then watches until setup.bat finishes. It counts
// visible console / terminal windows the whole time, so an update that pops up
// terminals fails. The update closes every Notes and starts the new build.
//   node scripts/test-update.mjs
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const exe = path.join(PROJECT, 'release', 'win-unpacked', 'Notes.exe')
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-update-test-'))
const log = path.join(UD, 'update.log')
const PORT = 9334
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Titles of visible top level windows owned by console hosts and shells. */
function terminalWindows() {
  const ps = "Get-Process conhost,cmd,powershell,pwsh,WindowsTerminal,OpenConsole,node,git -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { \"$($_.Name)|$($_.Id)|$($_.MainWindowTitle)\" }"
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' })
  return out.split(/\r?\n/).filter(Boolean)
}

const before = new Set(terminalWindows())
console.log('terminal windows already open:', before.size)

const app = spawn(exe, [`--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: true })
app.unref()

let target
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  } catch {}
}
if (!target) throw new Error('no page target')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data)
  pending.get(d.id)?.(d)
  pending.delete(d.id)
})
const ev = (expression) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, (d) => res(d.result?.result?.value ?? d))
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })

for (let i = 0; i < 40 && !(await ev('!!window.desk?.update')); i++) await sleep(250)
const check = await ev('window.desk.update.check()')
console.log('check:', JSON.stringify({ ok: check.ok, behind: check.behind, error: check.error }))
const run = await ev('window.desk.update.run()')
console.log('run:', JSON.stringify(run))
const again = await ev('window.desk.update.run()')
console.log('second click:', JSON.stringify(again))
if (!run.ok) process.exit(1)
if (again.ok) console.log('FAIL: a second click started a second update')

// Watch until the launcher writes its exit code (the app it talks to gets closed on the way).
const popped = new Set()
const start = Date.now()
let text = ''
while (Date.now() - start < 30 * 60_000) {
  for (const w of terminalWindows()) if (!before.has(w)) popped.add(w)
  text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  if (/Update exited with code/.test(text)) break
  await sleep(1000)
}
console.log('--- update.log tail ---')
console.log(text.trim().split(/\r?\n/).slice(-15).join('\n'))
console.log('--- result ---')
const code = /Update exited with code (-?\d+)/.exec(text)?.[1]
console.log('exit code:', code ?? 'none (timed out)')
console.log('lock left behind:', fs.existsSync(path.join(UD, 'update.lock')))
console.log('terminal windows that appeared:', popped.size ? [...popped] : 'none')
process.exit(code === '0' && !popped.size && !again.ok ? 0 : 1)
