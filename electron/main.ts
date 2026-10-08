import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const DIST_ELECTRON = __dirname
const ROOT = path.join(DIST_ELECTRON, '..')
const DIST = path.join(ROOT, 'dist')
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let win: BrowserWindow | null = null

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

function ensureVault(p = vaultPath) {
  fs.mkdirSync(path.join(p, 'pages'), { recursive: true })
  fs.mkdirSync(path.join(p, 'assets'), { recursive: true })
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
    title: 'Notes',
    width: 1500,
    height: 950,
    minWidth: 860,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#1f1f1f',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
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

  win.once('ready-to-show', () => win?.show())

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(DIST, 'index.html'))
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

  win.on('closed', () => {
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
// From source, a fixed id keeps Notes apart from any other Electron app.
const APP_ID = app.isPackaged ? process.execPath : 'com.mamoun.notesapp.source'
app.setAppUserModelId(APP_ID)

// Serve pasted images from the vault without disabling web security.
protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    ensureVault()

    protocol.handle('asset', (request) => {
      const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
      const file = path.join(vaultPath, 'assets', path.basename(name))
      return net.fetch(pathToFileURL(file).toString())
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
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
  return vaultPath
})

ipcMain.handle('vault:reveal', () => {
  shell.openPath(vaultPath)
})

ipcMain.handle('workspace:read', () => readJson(path.join(vaultPath, 'workspace.json'), null))

ipcMain.handle('workspace:write', async (_e, data: unknown) => {
  await atomicWrite(path.join(vaultPath, 'workspace.json'), JSON.stringify(data, null, 2))
  return true
})

ipcMain.handle('settings:read', () => readJson(path.join(vaultPath, 'settings.json'), null))

ipcMain.handle('settings:write', async (_e, data: unknown) => {
  await atomicWrite(path.join(vaultPath, 'settings.json'), JSON.stringify(data, null, 2))
  return true
})

ipcMain.handle('page:read', (_e, id: string) => readJson(pageFile(id), null))

ipcMain.handle('page:write', async (_e, id: string, data: unknown) => {
  await atomicWrite(pageFile(id), JSON.stringify(data, null, 2))
  return true
})

ipcMain.handle('page:delete', async (_e, id: string) => {
  const src = pageFile(id)
  try {
    const dest = path.join(vaultPath, '.trash', `${sanitizeId(id)}-${Date.now()}.json`)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.rename(src, dest)
  } catch {
    /* already gone */
  }
  return true
})

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
  return `asset://local/${name}`
})

ipcMain.handle('asset:import', async (_e, filePath: string) => {
  const buf = await fsp.readFile(filePath)
  const ext = (path.extname(filePath).slice(1) || 'png').toLowerCase()
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`
  const dest = path.join(vaultPath, 'assets', name)
  if (!fs.existsSync(dest)) await fsp.writeFile(dest, buf)
  return `asset://local/${name}`
})

/** Full-text search over every page file. Fast enough for tens of thousands. */
ipcMain.handle('search:all', async (_e, query: string) => {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const dir = path.join(vaultPath, 'pages')
  let names: string[] = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const results: any[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw: string
    try {
      raw = await fsp.readFile(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    if (!raw.toLowerCase().includes(q)) continue
    let page: any
    try {
      page = JSON.parse(raw)
    } catch {
      continue
    }
    const hits: { cellId: string; cellTitle: string; snippet: string }[] = []
    const titleHit = String(page.title || '').toLowerCase().includes(q)
    for (const cell of page.cells || []) {
      const text = stripHtml(`${cell.title || ''}<br>${cell.html || ''}`)
      const i = text.toLowerCase().indexOf(q)
      if (i >= 0) {
        hits.push({
          cellId: cell.id,
          cellTitle: cell.title || '',
          snippet: lineSnippet(text, i, q.length),
        })
      }
      if (hits.length >= 4) break
    }
    if (titleHit || hits.length) {
      results.push({ pageId: page.id || name.replace(/\.json$/, ''), title: page.title || 'Untitled', hits })
    }
    if (results.length >= 80) break
  }
  return results
})

function stripHtml(html: string) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
}

/** Snippet limited to the line (paragraph) containing the match. */
function lineSnippet(text: string, i: number, len: number) {
  const start = text.lastIndexOf('\n', i) + 1
  let end = text.indexOf('\n', i + len)
  if (end < 0) end = text.length
  return text.slice(Math.max(start, i - 40), Math.min(end, i + len + 60)).trim()
}

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
