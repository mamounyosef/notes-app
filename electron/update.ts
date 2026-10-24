/**
 * Settings, Update: checks the git checkout this app was built from for new
 * commits, and runs setup.bat in a hidden window to update (it pulls, closes
 * Notes, builds, packages and starts the new version). Its output goes to
 * update.log in the app data folder, read back after the restart.
 *
 * setup.bat runs in one hidden console that every step (git, npm, node,
 * powershell, electron-builder) shares. Started without a console at all, each
 * of those would open a terminal window of its own. It is started through
 * PowerShell's Start-Process so it is not a child of Notes, which it closes.
 */
import { app, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'

/** The folder with setup.bat: the app's own folder in development, three up from the packaged app's resources. */
function repoRoot(): string | null {
  for (let dir = app.getAppPath(), i = 0; i < 6; i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'setup.bat')) && fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

const logFile = () => path.join(app.getPath('userData'), 'update.log')
/** There while an update runs; the launcher removes it when setup.bat ends. */
const lockFile = () => path.join(app.getPath('userData'), 'update.lock')
const launcherFile = () => path.join(app.getPath('userData'), 'update-run.cmd')
/** A lock older than this is from an update that was cut off (power loss, say). */
const STALE_LOCK_MS = 45 * 60_000

function updateRunning() {
  try {
    return Date.now() - fs.statSync(lockFile()).mtimeMs < STALE_LOCK_MS
  } catch {
    return false
  }
}

/** For a .cmd file: quoted, with % doubled so cmd does not expand it. */
const cmdPath = (p: string) => `"${p.replace(/%/g, '%%')}"`
/** For a PowerShell single quoted string. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** The batch file that runs setup.bat with its output in the log and clears the lock after. */
function writeLauncher(root: string) {
  const lines = [
    '@echo off',
    'setlocal',
    'set "NOTES_QUIET=1"',
    'set "ELECTRON_RUN_AS_NODE="',
    // Set by some terminals (Claude Code among them); it stops cmd finding programs in the current folder.
    'set "NoDefaultCurrentDirectoryInExePath="',
    // Never wait on a git password prompt nobody can see.
    'set "GIT_TERMINAL_PROMPT=0"',
    `cd /d ${cmdPath(root)}`,
    `call ${cmdPath(path.join(root, 'setup.bat'))} >> ${cmdPath(logFile())} 2>&1`,
    'set "CODE=%ERRORLEVEL%"',
    `>> ${cmdPath(logFile())} echo Update exited with code %CODE%.`,
    `del /f /q ${cmdPath(lockFile())} >nul 2>nul`,
    'exit /b %CODE%',
  ]
  fs.writeFileSync(launcherFile(), lines.join('\r\n') + '\r\n')
}

/** Starts the launcher in its own hidden console, detached from Notes. Resolves once it is running. */
function startHidden(root: string): Promise<void> {
  const command = `Start-Process -FilePath ${psQuote(launcherFile())} -WorkingDirectory ${psQuote(root)} -WindowStyle Hidden`
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', command],
      { cwd: root, timeout: 30_000, windowsHide: true },
      (err, _out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve()),
    )
  })
}

function git(root: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd: root, timeout, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()))),
  )
}

/** How the last update went, from its log. */
function lastRun(): { at: number; result: 'ok' | 'failed' | 'unknown' | 'running'; tail: string } | null {
  try {
    const st = fs.statSync(logFile())
    const text = fs.readFileSync(logFile(), 'utf8')
    const code = /Update exited with code (-?\d+)/.exec(text)?.[1]
    const result = updateRunning()
      ? 'running'
      : code != null
        ? code === '0' ? 'ok' : 'failed'
        : /Something failed/.test(text) ? 'failed' : /Done\. Starting Notes\./.test(text) ? 'ok' : 'unknown'
    return { at: st.mtimeMs, result, tail: text.trim().split(/\r?\n/).slice(-12).join('\n') }
  } catch {
    return null
  }
}

export function setupUpdate(opts: { log(...a: unknown[]): void }) {
  /** What is new: commits on the upstream branch this checkout does not have yet. */
  ipcMain.handle('update:check', async () => {
    const root = repoRoot()
    if (!root || !fs.existsSync(path.join(root, '.git'))) return { ok: false, error: 'This copy of Notes is not a git checkout, so it cannot update itself.', last: lastRun() }
    try {
      const current = await git(root, ['log', '-1', '--format=%h|%s|%cI'])
      await git(root, ['fetch', '--quiet', 'origin'], 60_000)
      const upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => 'origin/main')
      const behind = Number(await git(root, ['rev-list', '--count', `HEAD..${upstream}`])) || 0
      const log = behind ? await git(root, ['log', '--format=%h|%s|%cI', '-n', '20', `HEAD..${upstream}`]) : ''
      const parse = (line: string) => {
        const [hash, subject, date] = line.split('|')
        return { hash, subject, date }
      }
      return {
        ok: true,
        current: parse(current),
        behind,
        commits: log ? log.split('\n').map(parse) : [],
        canRun: process.platform === 'win32',
        last: lastRun(),
      }
    } catch (e: any) {
      return { ok: false, error: `Could not check for updates: ${e?.message || e}`, last: lastRun() }
    }
  })

  /** Runs setup.bat hidden. It closes this app, so this is the last thing it does. */
  ipcMain.handle('update:run', async () => {
    const root = repoRoot()
    if (!root) return { ok: false, error: 'setup.bat was not found next to the app.' }
    if (process.platform !== 'win32') return { ok: false, error: 'Updating from here works on Windows.' }
    if (updateRunning()) return { ok: false, error: 'An update is already running. Notes will close and open again when it is done.' }
    try {
      fs.mkdirSync(path.dirname(logFile()), { recursive: true })
      fs.writeFileSync(lockFile(), String(Date.now()))
      fs.writeFileSync(logFile(), `Update started ${new Date().toLocaleString()}\r\n`)
      writeLauncher(root)
      await startHidden(root)
      opts.log('update started from settings')
      return { ok: true }
    } catch (e: any) {
      try {
        fs.rmSync(lockFile(), { force: true })
        fs.appendFileSync(logFile(), `Could not start the update: ${e?.message || e}\r\nUpdate exited with code 1.\r\n`)
      } catch {
        /* the error below says enough */
      }
      return { ok: false, error: `Could not start the update: ${e?.message || e}` }
    }
  })

  ipcMain.handle('update:openLog', () => shell.openPath(logFile()))
}
