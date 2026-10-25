/**
 * Settings, Update: checks the git checkout this app was built from for new
 * commits, and runs setup.bat in a hidden window to update (it pulls, closes
 * Notes, builds, packages and starts the new version). Its output goes to
 * update.log in the app data folder, read back after the restart.
 *
 * scripts/update-runner.mjs runs it, started detached with the system's node so
 * it outlives Notes. It gives setup.bat one console with no window that every
 * step shares (no terminal per step), and starts Notes again when it ends.
 * Not a launcher .cmd started hidden through PowerShell: antivirus (Avast)
 * takes that for malware, quarantines it and kills the update.
 */
import { app, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'

/** The folder with setup.bat: the app's own folder in development, three up from the packaged app's resources. */
function repoRoot(): string | null {
  for (let dir = app.getAppPath(), i = 0; i < 6; i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'setup.bat')) && fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

const logFile = () => path.join(app.getPath('userData'), 'update.log')
/** There while an update runs; the runner removes it when setup.bat ends. */
const lockFile = () => path.join(app.getPath('userData'), 'update.lock')
/** A lock older than this is from an update that was cut off (power loss, say). */
const STALE_LOCK_MS = 45 * 60_000

function updateRunning() {
  try {
    return Date.now() - fs.statSync(lockFile()).mtimeMs < STALE_LOCK_MS
  } catch {
    return false
  }
}

/**
 * Starts scripts/update-runner.mjs with the system's node (setup.bat needs it
 * anyway), detached so it is not closed with Notes. Detached means no console,
 * and node opens none; the runner gives setup.bat its windowless one.
 * Resolves once it is running.
 */
function startRunner(root: string): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(root, 'scripts', 'update-runner.mjs'), root, logFile(), lockFile()], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.once('error', (e: any) => reject(e?.code === 'ENOENT' ? new Error('Node.js was not found. Run setup.bat once by hand.') : e))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
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
      await startRunner(root)
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
