/**
 * Voice mode, the main process half: finds the local speech engine, starts it
 * when needed, and answers the page's questions about it.
 *
 * The engine (speech-server.py: Whisper to hear, Kokoro to speak, Silero VAD
 * to know when someone talks) lives in the weekly planner's folder, with its
 * Python environment and 2 GB of models. Notes shares it instead of keeping a
 * second copy: if the planner already started it, Notes simply uses it; if
 * not, Notes starts it the same way the planner does (hidden, not detached).
 * One engine, one copy of the models on the GPU, for both apps.
 *
 * The page talks to the engine directly over a WebSocket on 127.0.0.1 (the
 * engine listens on loopback only); everything else goes through IPC here.
 */
import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'

const PORT = Number(process.env.PLANNER_SPEECH_PORT) || 5179
const HOST = '127.0.0.1'
const BOOT_TIMEOUT_MS = 30_000
const LOG_MAX_BYTES = 2 * 1024 * 1024

const configFile = () => path.join(app.getPath('userData'), 'voice.json')
const logFile = () => path.join(app.getPath('userData'), 'speech-server.log')

function readConfig(): { engineDir?: string } {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  } catch {
    return {}
  }
}

const pythonIn = (dir: string) => path.join(dir, '.venv-speech', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')

/** A folder holds a usable engine: the script, its Python and the voice model. */
function isEngineDir(dir: string | undefined): dir is string {
  if (!dir) return false
  try {
    return fs.existsSync(path.join(dir, 'speech-server.py')) && fs.existsSync(pythonIn(dir)) && fs.existsSync(path.join(dir, 'speech-models', 'kokoro-v1.0.onnx'))
  } catch {
    return false
  }
}

/**
 * Where the engine is: the folder picked in Settings, else the planner next to
 * Notes (the PC, on the GPU), else Notes' own speech-engine folder (a computer
 * without the planner, on the CPU).
 */
function findEngineDir(): string | null {
  const picked = readConfig().engineDir
  if (isEngineDir(picked)) return picked
  if (isEngineDir(process.env.NOTES_SPEECH_DIR)) return process.env.NOTES_SPEECH_DIR!
  const tried = new Set<string>()
  const near = (start: string) => {
    let dir = start
    for (let i = 0; i < 6; i++) {
      for (const c of [dir, path.join(dir, 'weekly-planner')]) {
        if (tried.has(c)) continue
        tried.add(c)
        if (isEngineDir(c)) return c
      }
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
    return null
  }
  const planner = near(app.getAppPath()) || near(path.dirname(process.execPath)) || (isEngineDir('D:\\My Projects\\weekly-planner') ? 'D:\\My Projects\\weekly-planner' : null)
  if (planner) return planner
  // No planner here (the laptop): Notes' own CPU engine, set up by setup.bat
  // (speech-engine/setup-speech.ps1).
  for (const dir of [path.join(app.getAppPath(), 'speech-engine'), path.join(__dirname, '..', 'speech-engine')]) {
    if (isEngineDir(dir)) return dir
  }
  return null
}

export function setupVoice(opts: { getWin(): BrowserWindow | null; log(...a: unknown[]): void }) {
  let child: ChildProcess | null = null
  let booting: Promise<boolean> | null = null

  async function health(timeoutMs = 1500): Promise<Record<string, any> | null> {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      return res.ok ? ((await res.json()) as Record<string, any>) : null
    } catch {
      return null
    }
  }

  function appendLog(chunk: Buffer | string) {
    try {
      const st = fs.statSync(logFile(), { throwIfNoEntry: false })
      if (st && st.size > LOG_MAX_BYTES) fs.renameSync(logFile(), `${logFile()}.old`)
      fs.appendFileSync(logFile(), chunk)
    } catch {
      /* logging must never break voice mode */
    }
  }

  /** The engine answers on its port, starting it if need be. */
  function ensureEngine(): Promise<boolean> {
    if (booting) return booting
    booting = (async () => {
      if (await health()) return true
      const dir = findEngineDir()
      if (!dir) return false
      if (!child || child.exitCode !== null) {
        opts.log('voice: starting the speech engine in', dir)
        appendLog(`\n=== ${new Date().toISOString()} starting from Notes ===\n`)
        const c = spawn(pythonIn(dir), ['-u', path.join(dir, 'speech-server.py'), '--port', String(PORT)], {
          cwd: dir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Notes' own engine (speech-engine/, set up on a computer without the
          // planner) is a CPU install: never let it try a GPU. The planner's
          // engine picks the GPU itself.
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(path.basename(dir) === 'speech-engine' ? { SPEECH_DEVICE: 'cpu' } : {}) },
        })
        c.stdout?.on('data', appendLog)
        c.stderr?.on('data', appendLog)
        c.on('exit', (code) => {
          opts.log('voice: speech engine exited', code)
          if (child === c) child = null
        })
        c.on('error', (err) => opts.log('voice: could not start the speech engine', err.message))
        child = c
      }
      const until = Date.now() + BOOT_TIMEOUT_MS
      while (Date.now() < until) {
        if (await health(800)) return true
        if (!child) return false
        await new Promise((r) => setTimeout(r, 300))
      }
      return false
    })().finally(() => {
      booting = null
    })
    return booting
  }

  const notReady = () => ({
    ok: false,
    error: findEngineDir()
      ? 'The speech engine did not start. Its log is speech-server.log in the Notes app data folder.'
      : 'The speech engine is not on this computer. Run setup.bat in the Notes folder to install it (or pick the weekly planner folder in Settings, Voice).',
  })

  ipcMain.handle('voice:status', async () => {
    const dir = findEngineDir()
    const h = await health()
    return {
      available: Boolean(dir || h),
      engineDir: dir,
      running: Boolean(h),
      ready: Boolean(h?.ready),
      loading: Boolean(h?.loading),
      device: h?.device ?? null,
      vramMb: typeof h?.vramMb === 'number' ? h.vramMb : null,
      error: h?.error ?? null,
      port: PORT,
    }
  })

  /**
   * Turn the engine off (before gaming, say): it tells its sessions, exits and
   * frees all graphics memory, whichever app started it. The next voice
   * session starts it again. Never starts it just to stop it.
   */
  ipcMain.handle('voice:off', async () => {
    if (!(await health(800))) return { ok: true }
    try {
      const res = await fetch(`http://${HOST}:${PORT}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) })
      // An older engine without /shutdown: stop it if it is ours.
      if (!res.ok) child?.kill()
    } catch {
      /* it is exiting */
    }
    opts.log('voice: speech engine turned off')
    return { ok: true }
  })

  ipcMain.handle('voice:ensure', async () => ((await ensureEngine()) ? { ok: true, port: PORT } : notReady()))

  ipcMain.handle('voice:voices', async () => {
    if (!(await ensureEngine())) return notReady()
    try {
      const j: any = await (await fetch(`http://${HOST}:${PORT}/voices`)).json()
      return { ok: true, voices: j.voices || [], default: j.default }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  ipcMain.handle('voice:warm', async () => {
    if (!(await ensureEngine())) return notReady()
    try {
      return { ok: true, ...((await (await fetch(`http://${HOST}:${PORT}/warm`, { method: 'POST' })).json()) as object) }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  /** One sentence in a voice, as WAV bytes (base64), for Settings. */
  ipcMain.handle('voice:preview', async (_e, body: { voice: string; speed: number; text?: string }) => {
    if (!(await ensureEngine())) return notReady()
    try {
      const res = await fetch(`http://${HOST}:${PORT}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) return { ok: false, error: ((await res.json().catch(() => ({}))) as any).error || `The engine answered ${res.status}.` }
      return { ok: true, wav: Buffer.from(await res.arrayBuffer()).toString('base64') }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  /** Settings: point Notes at the folder that holds the engine. */
  ipcMain.handle('voice:chooseEngine', async () => {
    const w = opts.getWin()
    const r = await (w
      ? dialog.showOpenDialog(w, { title: 'Folder with speech-server.py (the weekly planner)', properties: ['openDirectory'] })
      : dialog.showOpenDialog({ title: 'Folder with speech-server.py (the weekly planner)', properties: ['openDirectory'] }))
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    const dir = r.filePaths[0]
    if (!isEngineDir(dir))
      return { ok: false, error: 'That folder has no speech engine. It needs speech-server.py, .venv-speech and speech-models (the weekly planner folder).' }
    fs.writeFileSync(configFile(), JSON.stringify({ ...readConfig(), engineDir: dir }, null, 2))
    return { ok: true, engineDir: dir }
  })

  // Only the engine Notes started goes away with Notes; one the planner
  // started keeps serving the planner.
  app.on('will-quit', () => {
    try {
      child?.kill()
    } catch {
      /* gone */
    }
  })
}
