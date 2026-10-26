// End to end test of Settings, Update on the packaged app: starts
// <root>\release\win-unpacked\Notes.exe with a throwaway profile, presses Update through
// window.notes.update.run(), then watches until setup.bat finishes. It counts
// visible console / terminal windows the whole time, so an update that pops up
// terminals fails. Then it checks the copy is on the latest commit, was rebuilt
// and opened again (with the test profile), and closes that copy.
// NOTES_UPDATE_TEST keeps your shortcuts, speech engine and other open Notes out of it.
//   node scripts/test-update.mjs [root]    (root: a copy to update, default this one)
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const exe = path.join(PROJECT, 'release', 'win-unpacked', 'Notes.exe')
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-update-test-'))
const log = path.join(UD, 'update.log')
// A fresh port each run, so a copy left open by an earlier run is never the one tested.
const PORT = 20000 + Math.floor(Math.random() * 20000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const powershell = (ps) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps + '; exit 0'], { windowsHide: true, encoding: 'utf8' })
const git = (...args) => execFileSync('git', args, { cwd: PROJECT, windowsHide: true, encoding: 'utf8' }).trim()

/** Titles of visible top level windows owned by console hosts and shells. */
function terminalWindows() {
  const out = powershell("Get-Process conhost,cmd,powershell,pwsh,WindowsTerminal,OpenConsole,node,git -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { \"$($_.Name)|$($_.Id)|$($_.MainWindowTitle)\" }")
  return out.split(/\r?\n/).filter(Boolean)
}

/** Ids of the copy the update opened again: this profile, no debugging port. */
function reopenedNotes() {
  const ud = UD.replace(/'/g, "''")
  const out = powershell(`Get-CimInstance Win32_Process -Filter "Name='Notes.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${ud}') -and $_.CommandLine -notmatch '--type=|remote-debugging-port' } | ForEach-Object { $_.ProcessId }`)
  return out.split(/\r?\n/).filter(Boolean)
}

// Copies of Notes left open by an earlier run of this test.
powershell("Get-CimInstance Win32_Process -Filter \"Name='Notes.exe'\" | Where-Object { $_.CommandLine -match 'notes-update-test-' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
const before = new Set(terminalWindows())
console.log('updating:', PROJECT, 'at', git('log', '-1', '--format=%h %s'))
console.log('terminal windows already open:', before.size)
const exeBefore = fs.statSync(exe).mtimeMs

const app = spawn(exe, [`--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  detached: true,
  env: { ...process.env, NOTES_UPDATE_TEST: '1', NOTES_TEST_USER_DATA: UD },
})
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

for (let i = 0; i < 40 && !(await ev('!!window.notes?.update')); i++) await sleep(250)
const check = await ev('window.notes.update.check()')
console.log('check:', JSON.stringify({ ok: check.ok, behind: check.behind, error: check.error }))
const run = await ev('window.notes.update.run()')
console.log('run:', JSON.stringify(run))
const again = await ev('window.notes.update.run()')
console.log('second click:', JSON.stringify(again))
if (!run.ok) process.exit(1)
if (again.ok) console.log('FAIL: a second click started a second update')

// Watch until the launcher writes its exit code (the app it talks to gets closed on the way).
const popped = new Set()
const start = Date.now()
let text = ''
const lock = path.join(UD, 'update.lock')
let lockGoneAt = 0
while (Date.now() - start < 30 * 60_000) {
  for (const w of terminalWindows()) if (!before.has(w)) popped.add(w)
  text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  if (/Update exited with code/.test(text)) break
  // The launcher removes the lock last: gone with no result line means it was cut off.
  if (fs.existsSync(lock)) lockGoneAt = 0
  else if (!lockGoneAt) lockGoneAt = Date.now()
  else if (Date.now() - lockGoneAt > 10_000) break
  await sleep(1000)
}
// The update starts Notes again when it is done.
let reopened = []
for (let i = 0; i < 30 && !reopened.length; i++) {
  reopened = reopenedNotes()
  if (!reopened.length) await sleep(1000)
}
const head = git('rev-parse', 'HEAD')
const upstream = git('rev-parse', '@{u}')
const rebuilt = fs.existsSync(exe) && fs.statSync(exe).mtimeMs > exeBefore
console.log('--- update.log tail ---')
console.log(text.trim().split(/\r?\n/).slice(-15).join('\n'))
console.log('--- result ---')
const code = /Update exited with code (-?\d+)/.exec(text)?.[1]
console.log('exit code:', code ?? 'none (cut off or timed out)')
console.log('now at:', git('log', '-1', '--format=%h %s'), head === upstream ? '(latest)' : '(NOT the latest)')
console.log('app rebuilt:', rebuilt)
console.log('lock left behind:', fs.existsSync(lock))
console.log('terminal windows that appeared:', popped.size ? [...popped] : 'none')
console.log('Notes started again:', reopened.length ? `yes (pid ${reopened[0]})` : 'NO')
for (const pid of reopened) powershell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`)
process.exit(code === '0' && head === upstream && rebuilt && !popped.size && !again.ok && reopened.length ? 0 : 1)
