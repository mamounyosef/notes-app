/**
 * Export and print: turns a ready made HTML document (built in the page by
 * src/lib/exportDoc.ts) into a PDF or sends it to the printer, and writes
 * Markdown bundles with their pictures.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'

export interface PaperOptions {
  pageSize: 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5'
  landscape: boolean
  /** Inches on every side. */
  margin: number
  /** Page numbers at the bottom of every sheet. */
  pageNumbers: boolean
  /** Shown at the top of every sheet, if any. */
  header?: string
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** Loads the document in a hidden window and waits until its diagrams and pictures are drawn. */
async function loadDoc(html: string) {
  const file = path.join(app.getPath('temp'), `notes-export-${process.pid}-${Date.now()}.html`)
  await fsp.writeFile(file, html, 'utf8')
  const w = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1400,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      spellcheck: false,
      // No preload, no Node: the document cannot reach the app or the computer.
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
    },
  })
  // Nothing in an export may open or go anywhere.
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  try {
    await w.loadFile(file)
    const until = Date.now() + 15000
    while (Date.now() < until) {
      const ready = await w.webContents.executeJavaScript('window.__exportReady === true').catch(() => false)
      if (ready) break
      await new Promise((r) => setTimeout(r, 120))
    }
    await w.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => true)
  } finally {
    fsp.unlink(file).catch(() => {})
  }
  return w
}

function pdfOptions(p: PaperOptions): Electron.PrintToPDFOptions {
  const footer = p.pageNumbers
    ? `<div style="width:100%;font-size:8px;font-family:Segoe UI,sans-serif;color:#888;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
    : '<div></div>'
  const header = p.header
    ? `<div style="width:100%;font-size:8px;font-family:Segoe UI,sans-serif;color:#999;padding:0 ${p.margin}in;text-align:right">${esc(p.header)}</div>`
    : '<div></div>'
  return {
    pageSize: p.pageSize,
    landscape: p.landscape,
    printBackground: true,
    displayHeaderFooter: p.pageNumbers || Boolean(p.header),
    headerTemplate: header,
    footerTemplate: footer,
    margins: { top: p.margin, bottom: p.margin, left: p.margin, right: p.margin },
    generateDocumentOutline: true,
  }
}

export function setupExporter(getWin: () => BrowserWindow | null, getVault: () => string) {
  ipcMain.handle('export:saveDialog', async (_e, name: string, ext: string, label: string) => {
    const win = getWin()
    const opts = { defaultPath: name, filters: [{ name: label, extensions: [ext] }] }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return res.canceled || !res.filePath ? null : res.filePath
  })

  ipcMain.handle('export:pickFolder', async () => {
    const win = getWin()
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder for the files' }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  /** Writes a PDF of the document to `out`. */
  ipcMain.handle('export:pdf', async (_e, html: string, paper: PaperOptions, out: string) => {
    const w = await loadDoc(html)
    try {
      const data = await w.webContents.printToPDF(pdfOptions(paper))
      await fsp.mkdir(path.dirname(out), { recursive: true })
      await fsp.writeFile(out, data)
      return { ok: true, bytes: data.length }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    } finally {
      w.destroy()
    }
  })

  /** The printer dialog for the document. */
  ipcMain.handle('export:print', async (_e, html: string, paper: PaperOptions) => {
    const w = await loadDoc(html)
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      w.webContents.print(
        {
          silent: false,
          printBackground: true,
          landscape: paper.landscape,
          pageSize: paper.pageSize,
          margins: { marginType: 'custom', top: paper.margin * 72, bottom: paper.margin * 72, left: paper.margin * 72, right: paper.margin * 72 },
          header: paper.header || undefined,
          footer: undefined,
        },
        (ok, reason) => {
          w.destroy()
          // Closing the dialog is not an error.
          resolve(ok || /cancel/i.test(reason || '') ? { ok } : { ok: false, error: reason })
        },
      )
    })
  })

  ipcMain.handle('export:writeText', async (_e, out: string, content: string) => {
    await fsp.mkdir(path.dirname(out), { recursive: true })
    await fsp.writeFile(out, content, 'utf8')
    return true
  })

  /** Copies pictures from the notes folder (by asset name) into `dir`. Missing ones are skipped. */
  ipcMain.handle('export:copyAssets', async (_e, names: string[], dir: string) => {
    const from = path.join(getVault(), 'assets')
    await fsp.mkdir(dir, { recursive: true })
    let copied = 0
    for (const n of names) {
      const name = path.basename(n)
      try {
        await fsp.copyFile(path.join(from, name), path.join(dir, name))
        copied++
      } catch {
        /* gone from the notes folder */
      }
    }
    return copied
  })

  /**
   * A place the assistant names, made absolute: "~", %VARS%, and a leading
   * Desktop, Documents, Downloads, Pictures or Home folder name are understood.
   */
  ipcMain.handle('export:resolvePath', (_e, p: string) => {
    let s = String(p || '').trim().replace(/^["']|["']$/g, '')
    s = s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m)
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(app.getPath('home'), s.slice(1))
    const known: Record<string, Parameters<typeof app.getPath>[0]> = { desktop: 'desktop', documents: 'documents', downloads: 'downloads', pictures: 'pictures', home: 'home' }
    const first = s.split(/[\\/]/)[0].toLowerCase()
    if (!path.isAbsolute(s) && known[first]) s = path.join(app.getPath(known[first]), s.slice(first.length))
    if (!path.isAbsolute(s)) s = path.join(app.getPath('documents'), s)
    return path.normalize(s)
  })

  ipcMain.handle('export:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('export:open', (_e, p: string) => shell.openPath(p))
}
