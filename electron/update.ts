/**
 * Settings, Update: checks the git checkout this app was built from for new
 * commits, and runs setup.bat in a hidden window to update (it pulls, closes
 * Notes, builds, packages and starts the new version). Its output goes to
 * update.log in the app data folder, read back after the restart.
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

function git(root: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd: root, timeout, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()))),
  )
}

/** How the last update went, from its log. */
function lastRun(): { at: number; result: 'ok' | 'failed' | 'unknown'; tail: string } | null {
  try {
    const st = fs.statSync(logFile())
    const text = fs.readFileSync(logFile(), 'utf8')
    const result = /Something failed/.test(text) ? 'failed' : /Done\. Starting Notes\./.test(text) ? 'ok' : 'unknown'
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
  ipcMain.handle('update:run', () => {
    const root = repoRoot()
    if (!root) return { ok: false, error: 'setup.bat was not found next to the app.' }
    if (process.platform !== 'win32') return { ok: false, error: 'Updating from here works on Windows.' }
    try {
      const out = fs.openSync(logFile(), 'w')
      fs.writeSync(out, `Update started ${new Date().toLocaleString()}\r\n`)
      const env: Record<string, string | undefined> = { ...process.env, NOTES_QUIET: '1' }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn('cmd.exe', ['/d', '/c', 'setup.bat'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env })
      child.unref()
      fs.closeSync(out)
      opts.log('update started from settings')
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  ipcMain.handle('update:openLog', () => shell.openPath(logFile()))
}
