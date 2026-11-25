/**
 * HTML blocks outside the app: open one as a page in Chrome (or the default
 * browser), and save one as an .html page or a .png picture.
 * The page itself is built in the renderer (buildWidgetDoc, standalone).
 */
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** chrome.exe in its usual places (per user install first). */
function findChrome(): string | null {
  const bases = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean) as string[]
  for (const b of bases) {
    const p = path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (fs.existsSync(p)) return p
  }
  return null
}

/** A safe file name from a title. */
export function fileSafe(name: string, fallback = 'widget'): string {
  const s = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  return s || fallback
}

const previewDir = () => path.join(app.getPath('temp'), 'notes-widgets')

export function setupWidgetFiles(getWin: () => BrowserWindow | null) {
  /** Writes the page to a temp file and opens it. browser: 'chrome' falls back to the default browser. */
  ipcMain.handle('widget:open', async (_e, html: string, name: string, browser: 'chrome' | 'default') => {
    try {
      const dir = previewDir()
      await fsp.mkdir(dir, { recursive: true })
      // Old previews (a day or more) are cleared as new ones are made.
      const now = Date.now()
      for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
        const p = path.join(dir, f)
        const st = await fsp.stat(p).catch(() => null)
        if (st && now - st.mtimeMs > 86_400_000) fsp.rm(p, { force: true }).catch(() => {})
      }
      const file = path.join(dir, `${fileSafe(name)} ${now.toString(36)}.html`)
      await fsp.writeFile(file, String(html || ''), 'utf8')
      if (browser === 'chrome') {
        const chrome = findChrome()
        if (chrome) {
          const child = spawn(chrome, [pathToFileURL(file).href], { detached: true, stdio: 'ignore', windowsHide: false })
          child.on('error', () => shell.openPath(file))
          child.unref()
          return { ok: true, file, browser: 'chrome' }
        }
      }
      const err = await shell.openPath(file)
      return err ? { ok: false, error: err, file } : { ok: true, file, browser: browser === 'chrome' ? 'default (Chrome not found)' : 'default' }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  /** Save dialog, then writes text or base64 bytes. Returns the path, or null when canceled. */
  ipcMain.handle('widget:save', async (_e, name: string, ext: 'html' | 'png' | 'svg', data: string, base64: boolean) => {
    const labels = { html: 'Web page', png: 'PNG image', svg: 'SVG image' } as const
    const win = getWin()
    const opts: Electron.SaveDialogOptions = {
      title: `Save as ${labels[ext]}`,
      defaultPath: path.join(app.getPath('documents'), `${fileSafe(name)}.${ext}`),
      filters: [{ name: labels[ext], extensions: [ext] }],
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    await fsp.writeFile(res.filePath, base64 ? Buffer.from(data, 'base64') : data, base64 ? undefined : 'utf8')
    return res.filePath
  })
}
