// Runs setup.bat for Settings, Update, then starts Notes again.
//   node scripts/update-runner.mjs <repo root> <log file> <lock file>
// Notes starts this detached, so it outlives Notes, which setup.bat closes.
// setup.bat runs in one console with no window that all its steps (git, npm,
// node, powershell, electron-builder) share, so none of them opens a terminal.
// Its output goes to the log, which ends with "Update exited with code N.";
// the lock is removed when it is done.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [root, log, lock] = process.argv.slice(2)
const append = (text) => {
  try {
    fs.appendFileSync(log, text)
  } catch {
    /* nowhere left to say it */
  }
}

// What Notes and its terminal may have set that must not reach setup.bat or the new Notes.
const clean = { ...process.env }
delete clean.ELECTRON_RUN_AS_NODE
// Some terminals set it; it stops cmd finding programs in the current folder.
delete clean.NoDefaultCurrentDirectoryInExePath

function startNotes() {
  const exe = path.join(root, 'release', 'win-unpacked', 'Notes.exe')
  // scripts/test-update.mjs: the new copy opens with the test's own profile, not your notes.
  const args = process.env.NOTES_TEST_USER_DATA ? [`--user-data-dir=${process.env.NOTES_TEST_USER_DATA}`] : []
  try {
    if (fs.existsSync(exe)) spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', env: clean }).unref()
    else spawn('cmd.exe', ['/d', '/c', 'run-notes.bat'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, env: clean }).unref()
  } catch (e) {
    append(`Could not start Notes: ${e?.message || e}\r\n`)
  }
}

let finished = false
function finish(code) {
  if (finished) return
  finished = true
  append(`Update exited with code ${code}.\r\n`)
  try {
    fs.rmSync(lock, { force: true })
  } catch {
    /* a stale lock expires on its own */
  }
  startNotes()
}

const out = fs.openSync(log, 'a')
// /s takes the outer quotes off, leaving the path quoted.
const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(root, 'setup.bat')}""`], {
  cwd: root,
  // NOTES_RUNNER: this starts Notes after, so setup.bat does not.
  env: { ...clean, NOTES_QUIET: '1', NOTES_RUNNER: '1', GIT_TERMINAL_PROMPT: '0' },
  stdio: ['ignore', out, out],
  windowsHide: true,
  windowsVerbatimArguments: true,
})
child.on('error', (e) => {
  append(`Could not run setup.bat: ${e?.message || e}\r\n`)
  finish(1)
})
child.on('exit', (code) => finish(code ?? 1))
