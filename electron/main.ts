import './ws-env'
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, safeStorage, powerMonitor } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { VaultSync } from '../shared/vault-sync.mjs'
import { CloudSync } from '../shared/cloud-sync.mjs'
import { createSupabaseRemote } from '../shared/cloud-remote-supabase.mjs'
import { pageIndex, searchPages } from '../shared/search-core.mjs'
import { setupAgent } from './agent'
import { setupVoice } from './voice'
import { setupUpdate } from './update'
import { setupDiagrams } from './diagrams'

// Disable hardware acceleration and sandbox to prevent Chromium GPU/D3D11 crash (0xC0000005) on Windows 11
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-software-rasterizer')

const DIST_ELECTRON = __dirname
const ROOT = path.join(DIST_ELECTRON, '..')
const DIST = path.join(ROOT, 'dist')
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let win: BrowserWindow | null = null
/** Automated tests run the app off screen so it never covers the person's work. */
const TEST_OFFSCREEN = process.env.NOTES_TEST_OFFSCREEN === '1'

const LOG_FILE = 'C:\\Users\\mamou\\AppData\\Local\\Temp\\notes-debug.log'
try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] MAIN PROCESS EVALUATED\n`, 'utf8') } catch {}

function debugLog(...args: unknown[]) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`)
  } catch {}
}

process.on('uncaughtException', (err: any) => {
  debugLog('uncaughtException', err?.stack || err)
})
process.on('unhandledRejection', (reason: any) => {
  debugLog('unhandledRejection', reason?.stack || reason)
})

/* ------------------------------------------------------------------ *
 * Vault (the folder that holds all notes). Its location is remembered
 * in the Electron userData dir so the notes folder itself stays clean
 * and portable (drop it in OneDrive to sync between machines).
 * ------------------------------------------------------------------ */

const configFile = () => path.join(app.getPath('userData'), 'config.json')

function readConfig(): { vault?: string } {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(cfg: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8')
}

function defaultVault() {
  return path.join(app.getPath('documents'), 'MyNotes')
}

let vaultPath = readConfig().vault || defaultVault()

const sync = new VaultSync({
  stateDir: path.join(app.getPath('userData'), 'sync'),
  emit: (ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('vault:event', ev)
  },
  log: (...a) => console.log(...a),
  onLocalChange: (kind, id, info) => cloud.markDirty(kind, id, info),
})

/* ------------------------------------------------------------------ *
 * Cloud sync (Supabase). The notes folder stays the working copy; the
 * cloud is where the computers meet. See shared/cloud-sync.mjs.
 * ------------------------------------------------------------------ */

const cloud = new CloudSync({
  vault: sync,
  stateDir: path.join(app.getPath('userData'), 'sync'),
  onStatus: (s) => {
    if (win && !win.isDestroyed()) win.webContents.send('cloud:status', s)
  },
  log: (...a) => {
    console.log(...a)
    debugLog(...a.map((x) => (x instanceof Error ? x.message : x)))
  },
})

interface CloudConfig {
  url?: string
  key?: string
}

const cloudConfig = (): CloudConfig => (readConfig() as { cloud?: CloudConfig }).cloud || {}

/** Where supabase-js keeps the sign-in session: a file in userData, encrypted by Windows. */
function sessionStorage() {
  const file = path.join(app.getPath('userData'), 'cloud-session.bin')
  const load = (): Record<string, string> => {
    try {
      const raw = fs.readFileSync(file)
      const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
      return JSON.parse(text)
    } catch {
      return {}
    }
  }
  const save = (all: Record<string, string>) => {
    const text = JSON.stringify(all)
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  }
  return {
    getItem: (k: string) => load()[k] ?? null,
    setItem: (k: string, v: string) => save({ ...load(), [k]: v }),
    removeItem: (k: string) => {
      const all = load()
      delete all[k]
      save(all)
    },
  }
}

let remote: ReturnType<typeof createSupabaseRemote> | null = null

function makeRemote() {
  const { url, key } = cloudConfig()
  remote = url && key ? createSupabaseRemote({ url, key, storage: sessionStorage() }) : null
  return remote
}

/** Starts syncing if this computer is set up and signed in. */
async function startCloud() {
  const r = makeRemote()
  if (r && (await r.session().catch(() => null))) {
    cloud.setRemote(r)
    agent.chats.setRemote(r)
  } else {
    cloud.setRemote(null)
    agent.chats.setRemote(null)
  }
}

function ensureVault(p = vaultPath) {
  fs.mkdirSync(path.join(p, 'pages'), { recursive: true })
  fs.mkdirSync(path.join(p, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(p, 'artifacts'), { recursive: true })
  fs.mkdirSync(path.join(p, '.trash'), { recursive: true })
  return p
}

/** Write via a temp file + rename so a crash can never truncate a note. */
async function atomicWrite(file: string, data: string) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(tmp, data, 'utf8')
  await fsp.rename(tmp, file)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

const pageFile = (id: string) => path.join(vaultPath, 'pages', `${sanitizeId(id)}.json`)

function sanitizeId(id: string) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '')
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    ...(TEST_OFFSCREEN ? { skipTaskbar: true } : {}),
    title: 'Notes',
    width: 1500,
    height: 950,
    minWidth: 860,
    minHeight: 560,
    show: !TEST_OFFSCREEN,
    frame: false,
    backgroundColor: '#1f1f1f',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      sandbox: false,
      // Tests render without any window on screen.
      ...(TEST_OFFSCREEN ? { offscreen: true } : {}),
    },
  })

  // Running from source (setup.bat), the process is the stock electron.exe, so
  // pinning the window would pin a bare Electron icon. Tell the taskbar which
  // icon and command to use for the pin instead.
  if (!app.isPackaged && process.platform === 'win32') {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: path.join(ROOT, 'build', 'icon.ico'),
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${ROOT}"`,
      relaunchDisplayName: 'Notes',
    })
  }

  // Always open maximized, filling the screen.
  if (!TEST_OFFSCREEN) {
    win.maximize()
    win.show()
    win.focus()
  }

  win.once('ready-to-show', () => {
    debugLog('ready-to-show fired')
    if (TEST_OFFSCREEN) return
    win?.show()
    win?.focus()
  })

  // Ensure window is always shown even if ready-to-show is missed or delayed
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      if (TEST_OFFSCREEN) return
      debugLog('Fallback: forcing win.show() after timeout')
      win.show()
    }
  }, 1000)

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    debugLog('did-fail-load', code, desc, url)
  })

  win.webContents.on('did-finish-load', () => {
    debugLog('webContents did-finish-load successfully')
  })

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    debugLog('console-message', `[lvl:${level}]`, message, `(${sourceId}:${line})`)
  })

  let renderCrashCount = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    debugLog('render-process-gone', details)
    if (details.reason === 'crashed' && renderCrashCount < 2) {
      renderCrashCount++
      debugLog('reloading renderer after crash (attempt ' + renderCrashCount + ')')
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.reload()
      }, 500)
    }
  })

  if (DEV_SERVER_URL) {
    debugLog('Loading DEV_SERVER_URL', DEV_SERVER_URL)
    win.loadURL(DEV_SERVER_URL)
  } else {
    const htmlPath = path.join(DIST, 'index.html')
    debugLog('Loading local HTML', htmlPath, 'exists:', fs.existsSync(htmlPath))
    win.loadFile(htmlPath)
  }

  // External links open in the real browser or associated app, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return
    if (!DEV_SERVER_URL && url.startsWith(pathToFileURL(DIST).toString())) return

    event.preventDefault()
    openExternalUrl(url)
  })

  // Let the page write its last edits before the window goes away.
  let flushed = false
  win.on('close', (e) => {
    debugLog('win on close event received, flushed:', flushed)
    if (flushed || !win || win.webContents.isDestroyed()) return
    e.preventDefault()
    const w = win
    const done = () => {
      clearTimeout(timer)
      ipcMain.removeListener('app:flushed', done)
      flushed = true
      debugLog('flush done, destroying or closing window')
      if (!w.isDestroyed()) w.close()
    }
    const timer = setTimeout(done, 5000)
    ipcMain.on('app:flushed', done)
    w.webContents.send('app:flush')
  })

  win.on('closed', () => {
    debugLog('win on closed event')
    win = null
  })
}

let lastOpenedUrl = ''
let lastOpenedTime = 0

async function openExternalUrl(rawUrl: string) {
  if (!rawUrl) return
  let target = rawUrl.trim()

  const now = Date.now()
  if (target === lastOpenedUrl && now - lastOpenedTime < 800) {
    return
  }
  lastOpenedUrl = target
  lastOpenedTime = now

  // Handle artifact:// URLs (stored relative to the vault's artifacts directory)
  if (target.startsWith('artifact:')) {
    try {
      let rel = target.replace(/^artifact:\/\//i, '')
      if (rel.toLowerCase().startsWith('local/')) {
        rel = rel.slice(6)
      } else if (rel.toLowerCase().startsWith('local\\')) {
        rel = rel.slice(6)
      }
      rel = decodeURIComponent(rel).replace(/^\/+/, '')

      const artifactsDir = path.join(vaultPath, 'artifacts')
      ensureVault()
      const filePath = path.resolve(artifactsDir, rel.replace(/[\\/]+/g, path.sep))

      if (!fs.existsSync(filePath)) {
        if (win && !win.isDestroyed()) {
          dialog.showMessageBox(win, {
            type: 'warning',
            title: 'Artifact Not Found',
            message: `The artifact file or folder could not be found:\n\n${filePath}\n\nPlease check that it exists in your artifacts folder.`,
            buttons: ['OK', 'Open Artifacts Folder'],
            defaultId: 0,
          }).then((res) => {
            if (res.response === 1) {
              shell.openPath(artifactsDir)
            }
          })
        }
        return
      }

      const err = await shell.openPath(filePath)
      if (err) {
        console.error('shell.openPath returned error, attempting fallback:', err)
        try {
          await shell.openExternal(pathToFileURL(filePath).toString())
        } catch (fallbackErr) {
          console.error('shell.openExternal fallback also failed:', fallbackErr)
        }
      }
      return
    } catch (err) {
      console.error('Failed to open artifact URL:', target, err)
      return
    }
  }

  // Handle file:// URLs
  if (target.startsWith('file://')) {
    try {
      const filePath = fileURLToPath(target)
      const err = await shell.openPath(filePath)
      if (!err) return
    } catch {
      // Fall through to shell.openExternal
    }
  } else if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\')) {
    // Windows file path (e.g. C:\... or \\...)
    const err = await shell.openPath(target)
    if (!err) return
  }

  // If missing protocol (e.g. google.com or www.google.com), default to https://
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    target = 'https://' + target
  }

  try {
    await shell.openExternal(target)
  } catch (err) {
    console.error('Failed to open external url:', target, err)
  }
}

Menu.setApplicationMenu(null)

// Makes Windows group the window under the pinned shortcut correctly.
const APP_ID = 'com.mamoun.notesapp'
app.setAppUserModelId(APP_ID)

// Serve pasted images from the vault without disabling web security.
protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
])

debugLog('app starting, requesting single instance lock')
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  debugLog('Single instance lock NOT acquired. Quitting.')
  app.quit()
} else {
  debugLog('Single instance lock acquired.')
  app.on('second-instance', () => {
    debugLog('second-instance event received')
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    debugLog('app.whenReady fired')
    ensureVault()
    debugLog('ensureVault completed')
    sync.setVault(vaultPath)
    debugLog('sync.setVault completed')
    cloud.setVaultDir(vaultPath)
    startCloud().catch((e) => debugLog('cloud start failed', e?.message || e))
    // Coming back to the window is a good moment to look for new files.
    app.on('browser-window-focus', () => {
      sync.scan()
      cloud.schedule(0)
      agent.chats.schedule(0)
    })
    // Waking from sleep usually means the network just came back.
    powerMonitor.on('resume', () => cloud.schedule(3000))

    protocol.handle('asset', (request) => {
      const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
      const file = path.join(vaultPath, 'assets', path.basename(name))
      return net.fetch(pathToFileURL(file).toString())
    })

    createWindow()
    debugLog('createWindow returned')

    app.on('activate', () => {
      debugLog('app.activate')
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((err) => {
    debugLog('app.whenReady error:', err?.stack || err)
  })
}

app.on('before-quit', (e) => {
  debugLog('app before-quit event, defaultPrevented:', e.defaultPrevented)
})

app.on('will-quit', () => {
  debugLog('app will-quit event')
})

app.on('quit', (_e, code) => {
  debugLog('app quit event with code:', code)
})

app.on('window-all-closed', () => {
  debugLog('app window-all-closed event, platform:', process.platform)
  if (process.platform !== 'darwin') app.quit()
})

/* ------------------------------------------------------------------ *
 * IPC: storage API (mirrored by src/lib/storage.ts)
 * ------------------------------------------------------------------ */

ipcMain.handle('vault:get', () => vaultPath)

ipcMain.handle('vault:choose', async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Choose your notes folder',
    defaultPath: vaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  vaultPath = res.filePaths[0]
  ensureVault()
  writeConfig({ ...readConfig(), vault: vaultPath })
  sync.setVault(vaultPath)
  cloud.setVaultDir(vaultPath)
  return vaultPath
})

ipcMain.handle('vault:reveal', () => {
  shell.openPath(vaultPath)
})

// Reads and writes of notes go through the sync service, which merges with
// whatever another computer put in the folder (see shared/vault-sync.mjs).
ipcMain.handle('workspace:read', () => sync.read('workspace'))
ipcMain.handle('workspace:write', (_e, data: unknown, base: unknown) => sync.write('workspace', undefined, data, base))
ipcMain.handle('settings:read', () => sync.read('settings'))
ipcMain.handle('settings:write', (_e, data: unknown, base: unknown) => sync.write('settings', undefined, data, base))
ipcMain.handle('page:read', (_e, id: string) => sync.read('page', id))
ipcMain.handle('page:write', (_e, id: string, data: unknown, base: unknown, touched: unknown) =>
  sync.write('page', id, data, base, touched),
)
ipcMain.handle('page:delete', (_e, id: string) => sync.deletePage(id))

ipcMain.handle('sync:conflicts', () => sync.listConflicts())
ipcMain.handle('sync:scan', () => sync.scan())
ipcMain.handle('sync:status', () => sync.status())

ipcMain.handle('cloud:status', () => ({ ...cloud.status(), url: cloudConfig().url || '', key: cloudConfig().key || '' }))
ipcMain.handle('cloud:signIn', async (_e, url: string, key: string, email: string, password: string) => {
  try {
    writeConfig({ ...readConfig(), cloud: { url: String(url).trim(), key: String(key).trim() } })
    const r = makeRemote()
    if (!r) return { ok: false, error: 'Enter the project URL and key.' }
    await r.signIn(String(email).trim(), String(password))
    cloud.setRemote(r)
    agent.chats.setRemote(r)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
})
ipcMain.handle('cloud:signOut', async () => {
  cloud.setRemote(null)
  agent.chats.setRemote(null)
  await remote?.signOut()
  return true
})
ipcMain.handle('cloud:syncNow', () => cloud.syncNow())

/* Per computer state (last open page, recent pages, folded folders). Kept out
 * of the synced folder so two laptops never overwrite each other's. */
const localStateFile = () => path.join(app.getPath('userData'), 'local-state.json')
const vaultKey = () => path.resolve(vaultPath).toLowerCase()

ipcMain.handle('local:read', () => {
  try {
    return JSON.parse(fs.readFileSync(localStateFile(), 'utf8'))[vaultKey()] ?? null
  } catch {
    return null
  }
})

ipcMain.handle('local:write', async (_e, data: unknown) => {
  let all: Record<string, unknown> = {}
  try {
    all = JSON.parse(await fsp.readFile(localStateFile(), 'utf8'))
  } catch {
    /* first write */
  }
  all[vaultKey()] = data
  await atomicWrite(localStateFile(), JSON.stringify(all))
  return true
})

/** Saves image bytes into the notes folder's assets, named by content. */
async function saveAssetBytes(buf: Buffer, ext: string) {
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`
  const file = path.join(vaultPath, 'assets', name)
  if (!fs.existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, buf)
  }
  cloud.schedule(1000)
  return `asset://local/${name}`
}

const agent = setupAgent({
  getWin: () => win,
  device: sync.device,
  log: (...a) => debugLog(...a),
  saveAsset: saveAssetBytes,
})

setupVoice({ getWin: () => win, log: (...a) => debugLog(...a) })
setupUpdate({ log: (...a) => debugLog(...a) })
setupDiagrams()

ipcMain.handle('asset:save', async (_e, dataUrl: string) => {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) return null
  const [, mime, b64] = m
  const buf = Buffer.from(b64, 'base64')
  const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5)
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`
  const file = path.join(vaultPath, 'assets', name)
  if (!fs.existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, buf)
  }
  cloud.schedule(1000)
  return `asset://local/${name}`
})

ipcMain.handle('asset:import', async (_e, filePath: string) => {
  const buf = await fsp.readFile(filePath)
  const ext = (path.extname(filePath).slice(1) || 'png').toLowerCase()
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`
  const dest = path.join(vaultPath, 'assets', name)
  if (!fs.existsSync(dest)) await fsp.writeFile(dest, buf)
  cloud.schedule(1000)
  return `asset://local/${name}`
})

/** Parsed page files, kept until the file changes, so each keystroke searches from memory. */
const searchCache = new Map<string, { mtime: number; page: any }>()

/** Ranked, typo tolerant search over every page in the tree (see shared/search-core.mjs). */
ipcMain.handle('search:all', async (_e, query: string) => {
  if (!String(query || '').trim()) return []
  let tree: any[] = []
  try {
    tree = JSON.parse(await fsp.readFile(path.join(vaultPath, 'workspace.json'), 'utf8')).tree || []
  } catch {
    /* no tree yet */
  }
  const index = pageIndex(tree)
  const dir = path.join(vaultPath, 'pages')
  const pages: any[] = []
  await Promise.all(
    [...index.keys()].map(async (id) => {
      const file = path.join(dir, `${id}.json`)
      try {
        const st = await fsp.stat(file)
        let hit = searchCache.get(id)
        if (!hit || hit.mtime !== st.mtimeMs) {
          hit = { mtime: st.mtimeMs, page: JSON.parse(await fsp.readFile(file, 'utf8')) }
          searchCache.set(id, hit)
        }
        const info = index.get(id)!
        pages.push({ ...hit.page, id, path: info.path, archived: info.archived })
      } catch {
        /* missing or half written */
      }
    }),
  )
  const archived = new Set(pages.filter((p) => p.archived).map((p) => p.id))
  return searchPages(query, pages).map((r) => ({ ...r, archived: archived.has(r.pageId) }))
})

ipcMain.handle('export:file', async (_e, suggestedName: string, content: string) => {
  const res = await dialog.showSaveDialog(win!, { defaultPath: suggestedName })
  if (res.canceled || !res.filePath) return null
  await fsp.writeFile(res.filePath, content, 'utf8')
  return res.filePath
})

ipcMain.handle('win:minimize', () => win?.minimize())
ipcMain.handle('win:maximize', () => {
  if (!win) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.handle('win:close', () => win?.close())

ipcMain.handle('open:external', (_e, url: string) => openExternalUrl(url))

// window.confirm() in the renderer leaves text fields unable to take typing on
// Windows until the window is refocused, so confirmations go through here.
ipcMain.handle('dialog:confirm', async (_e, message: string, okLabel: string) => {
  const res = await dialog.showMessageBox(win!, {
    type: 'question',
    title: 'Notes',
    message,
    buttons: [okLabel || 'OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  win?.webContents.focus()
  return res.response === 0
})

ipcMain.handle('dialog:openFile', async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Select file to link',
    properties: ['openFile'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
})

ipcMain.handle('artifacts:list', async (_e, subDir = '', recursive = false) => {
  const artifactsDir = path.join(vaultPath, 'artifacts')
  ensureVault()
  const targetDir = path.resolve(artifactsDir, subDir || '')
  if (!targetDir.startsWith(artifactsDir)) return []
  try {
    const list: { name: string; isDirectory: boolean; relativePath: string }[] = []
    async function scan(dir: string, depth = 0) {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const ent of entries) {
        const full = path.join(dir, ent.name)
        const rel = path.relative(artifactsDir, full).replace(/\\/g, '/')
        list.push({
          name: ent.name,
          isDirectory: ent.isDirectory(),
          relativePath: rel,
        })
        if (recursive && ent.isDirectory() && depth < 6) {
          await scan(full, depth + 1)
        }
      }
    }
    await scan(targetDir)
    list.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return list
  } catch (err) {
    console.error('artifacts:list failed:', err)
    return []
  }
})

ipcMain.handle('artifacts:pickFile', async (_e, subDir = '') => {
  const artifactsDir = path.join(vaultPath, 'artifacts')
  ensureVault()
  const startDir = subDir ? path.resolve(artifactsDir, subDir) : artifactsDir
  const defaultPath = startDir.startsWith(artifactsDir) && fs.existsSync(startDir) ? startDir : artifactsDir
  const res = await dialog.showOpenDialog(win!, {
    title: 'Select Artifact File',
    defaultPath,
    properties: ['openFile'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  const filePath = res.filePaths[0]
  if (filePath.startsWith(artifactsDir)) {
    const rel = path.relative(artifactsDir, filePath).replace(/\\/g, '/')
    return {
      relativePath: rel,
      name: path.basename(filePath),
      isDirectory: false,
    }
  } else {
    // If chosen outside artifacts, copy into artifacts for machine portability
    const fileName = path.basename(filePath)
    let dest = path.join(defaultPath, fileName)
    if (fs.existsSync(dest) && dest.toLowerCase() !== filePath.toLowerCase()) {
      const ext = path.extname(fileName)
      const base = path.basename(fileName, ext)
      dest = path.join(defaultPath, `${base}-${Date.now()}${ext}`)
    }
    if (dest.toLowerCase() !== filePath.toLowerCase()) {
      await fsp.copyFile(filePath, dest)
      cloud.schedule(1000)
    }
    const rel = path.relative(artifactsDir, dest).replace(/\\/g, '/')
    return {
      relativePath: rel,
      name: path.basename(dest),
      isDirectory: false,
    }
  }
})

ipcMain.handle('artifacts:pickDirectory', async (_e, subDir = '') => {
  const artifactsDir = path.join(vaultPath, 'artifacts')
  ensureVault()
  const startDir = subDir ? path.resolve(artifactsDir, subDir) : artifactsDir
  const defaultPath = startDir.startsWith(artifactsDir) && fs.existsSync(startDir) ? startDir : artifactsDir
  const res = await dialog.showOpenDialog(win!, {
    title: 'Select Artifact Folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  const dirPath = res.filePaths[0]
  if (dirPath.startsWith(artifactsDir)) {
    const rel = path.relative(artifactsDir, dirPath).replace(/\\/g, '/')
    return {
      relativePath: rel,
      name: path.basename(dirPath),
      isDirectory: true,
    }
  } else {
    const folderName = path.basename(dirPath)
    if (dirPath.toLowerCase() === artifactsDir.toLowerCase()) {
      return {
        relativePath: '',
        name: folderName,
        isDirectory: true,
      }
    }
    const dest = path.join(artifactsDir, folderName)
    if (!fs.existsSync(dest)) {
      await fsp.cp(dirPath, dest, { recursive: true })
      cloud.schedule(1000)
    }
    const rel = path.relative(artifactsDir, dest).replace(/\\/g, '/')
    return {
      relativePath: rel,
      name: folderName,
      isDirectory: true,
    }
  }
})

ipcMain.handle('artifacts:reveal', async (_e, relativePath = '') => {
  const artifactsDir = path.join(vaultPath, 'artifacts')
  ensureVault()
  const target = relativePath ? path.resolve(artifactsDir, relativePath) : artifactsDir
  await shell.openPath(target)
})
