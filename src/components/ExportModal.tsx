/**
 * Export / print dialog: pick pages (or a few cells), the look and the paper,
 * see a live preview, then save a PDF, Markdown or HTML, or print.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, findNode, pathTo } from '../store'
import {
  savedExportOptions,
  saveExportOptions,
  buildHtml,
  buildMarkdown,
  dirOf,
  exporter,
  joinPath,
  loadItems,
  safeFileName,
  type ExportItem,
  type ExportOptions,
  type PaperSize,
} from '../lib/exportDoc'
import { storage } from '../lib/storage'
import { X, Download, File as FileIcon, Copy, Check } from './Icons'


const PrinterI = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9V3h12v6" />
    <rect x="3" y="9" width="18" height="8" rx="2" />
    <path d="M6 14h12v7H6z" />
  </svg>
)

const MARGINS: { label: string; v: number }[] = [
  { label: 'None', v: 0 },
  { label: 'Narrow', v: 0.4 },
  { label: 'Normal', v: 0.6 },
  { label: 'Wide', v: 1 },
]

function Seg<T extends string | boolean>({ value, options, onChange }: { value: T; options: { v: T; label: string; title?: string }[]; onChange(v: T): void }) {
  return (
    <div className="ex-seg">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Tick({ on, label, hint, onChange, disabled }: { on: boolean; label: string; hint?: string; onChange(v: boolean): void; disabled?: boolean }) {
  return (
    <label className={`ex-tick ${disabled ? 'disabled' : ''}`} title={hint}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export default function ExportModal() {
  const req = useStore((s) => s.exportRequest)!
  const tree = useStore((s) => s.workspace.tree)
  const close = () => useStore.getState().openExport(null)

  const [o, setO] = useState<ExportOptions>(savedExportOptions)
  const set = (patch: Partial<ExportOptions>) => setO((cur) => ({ ...cur, ...patch }))
  const setPaper = (patch: Partial<ExportOptions['paper']>) => setO((cur) => ({ ...cur, paper: { ...cur.paper, ...patch } }))
  useEffect(() => saveExportOptions(o), [o])

  // Pages in the order asked; each can be left out here.
  const [picked, setPicked] = useState<string[]>(req.pageIds)
  const [wholePage, setWholePage] = useState(false)
  const cellIds = req.cellIds?.length && !wholePage ? req.cellIds : undefined
  const ids = useMemo(() => req.pageIds.filter((id) => picked.includes(id)), [req.pageIds, picked])

  const [items, setItems] = useState<ExportItem[] | null>(null)
  useEffect(() => {
    let cancelled = false
    loadItems(ids, cellIds).then((r) => !cancelled && setItems(r))
    return () => {
      cancelled = true
    }
  }, [ids.join(','), cellIds?.join(',')])

  const multi = (items?.length || 0) > 1
  const combinedName = useMemo(() => {
    if (!items?.length) return 'Notes'
    if (items.length === 1) return items[0].page.title || 'Untitled page'
    // Pages from one section are named after it.
    const places = new Set(items.map((i) => i.where.join(' › ')))
    if (places.size === 1 && items[0].where.length) return items[0].where[items[0].where.length - 1]
    return `Notes (${items.length} pages)`
  }, [items])

  // Live preview, rebuilt shortly after each change.
  const [previewDoc, setPreviewDoc] = useState('')
  const [building, setBuilding] = useState(false)
  useEffect(() => {
    if (!items) return
    setBuilding(true)
    let cancelled = false
    const t = setTimeout(async () => {
      const html = await buildHtml(items, o, { preview: true, title: combinedName })
      if (!cancelled) {
        setPreviewDoc(html)
        setBuilding(false)
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [items, o, combinedName])

  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<{ msg: string; path?: string; error?: boolean } | null>(null)

  const run = async (label: string, fn: () => Promise<{ msg: string; path?: string } | null>) => {
    if (!items?.length || busy) return
    setBusy(label)
    setDone(null)
    try {
      const r = await fn()
      if (r) setDone(r)
    } catch (e: any) {
      setDone({ msg: `Failed: ${String(e?.message || e)}`, error: true })
    } finally {
      setBusy(null)
    }
  }

  const docFor = (list: ExportItem[], title: string) => buildHtml(list, o, { title })
  const paper = { ...o.paper, header: o.paper.header || undefined }

  const savePdf = () =>
    run('Making PDF', async () => {
      if (!exporter) {
        await printInPage(await docFor(items!, combinedName))
        return { msg: 'Choose "Save as PDF" in the print dialog' }
      }
      if (multi && o.files === 'separate') {
        const dir = await exporter.pickFolder()
        if (!dir) return null
        let n = 0
        for (const it of items!) {
          const r = await exporter.pdf(await docFor([it], it.page.title), paper, joinPath(dir, `${uniqueName(it, items!)}.pdf`))
          if (!r.ok) throw new Error(r.error)
          n++
        }
        return { msg: `Saved ${n} PDFs`, path: dir }
      }
      const out = await exporter.saveDialog(`${safeFileName(combinedName)}.pdf`, 'pdf', 'PDF document')
      if (!out) return null
      const r = await exporter.pdf(await docFor(items!, combinedName), paper, out)
      if (!r.ok) throw new Error(r.error)
      return { msg: 'PDF saved', path: out }
    })

  const print = () =>
    run('Opening printer', async () => {
      const html = await docFor(items!, combinedName)
      if (!exporter) {
        await printInPage(html)
        return null
      }
      const r = await exporter.print(html, paper)
      if (!r.ok && r.error) throw new Error(r.error)
      return r.ok ? { msg: 'Sent to the printer' } : null
    })

  const saveMd = () =>
    run('Writing Markdown', async () => {
      const bundle = buildMarkdown(items!, o, combinedName)
      if (!exporter) {
        for (const f of bundle.files) await storage.exportFile(f.name, f.text)
        return { msg: 'Markdown downloaded (pictures stay as links)' }
      }
      let dir: string
      let first: string
      if (bundle.files.length === 1) {
        const out = await exporter.saveDialog(bundle.files[0].name, 'md', 'Markdown')
        if (!out) return null
        dir = dirOf(out)
        first = out
        await exporter.writeText(out, bundle.files[0].text)
      } else {
        const picked = await exporter.pickFolder()
        if (!picked) return null
        dir = picked
        first = joinPath(dir, bundle.files[0].name)
        for (const f of bundle.files) await exporter.writeText(joinPath(dir, f.name), f.text)
      }
      const assetDir = joinPath(dir, 'assets')
      if (bundle.assets.length) await exporter.copyAssets(bundle.assets, assetDir)
      for (const d of bundle.drawings) await exporter.writeText(joinPath(assetDir, d.name), d.text)
      const extra = bundle.assets.length + bundle.drawings.length
      return {
        msg: `${bundle.files.length === 1 ? 'Markdown saved' : `Saved ${bundle.files.length} Markdown files`}${extra ? `, ${extra} picture${extra === 1 ? '' : 's'} in assets` : ''}`,
        path: bundle.files.length === 1 ? first : dir,
      }
    })

  const saveHtml = () =>
    run('Writing HTML', async () => {
      const html = await docFor(items!, combinedName)
      if (!exporter) {
        await storage.exportFile(`${safeFileName(combinedName)}.html`, html)
        return { msg: 'HTML downloaded' }
      }
      const out = await exporter.saveDialog(`${safeFileName(combinedName)}.html`, 'html', 'Web page')
      if (!out) return null
      await exporter.writeText(out, html)
      return { msg: 'HTML saved (pictures load from the notes folder in this app only)', path: out }
    })

  const [copied, setCopied] = useState(false)
  const copyMd = async () => {
    if (!items?.length) return
    const b = buildMarkdown(items, { ...o, files: 'combined' }, combinedName)
    await navigator.clipboard.writeText(b.files.map((f) => f.text).join('\n\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  // Keys: Esc closes, Ctrl+P prints, Ctrl+S saves the PDF.
  const keys = useRef({ print, savePdf })
  keys.current = { print, savePdf }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        keys.current.print()
      } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        keys.current.savePdf()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const cellsTotal = items?.reduce((n, i) => n + i.cells.length, 0) ?? 0
  const source = req.cellIds?.length
    ? (() => {
        const page = findNode(tree, req.pageIds[0])
        return `${wholePage ? 'Whole page' : `${req.cellIds!.length} selected cell${req.cellIds!.length === 1 ? '' : 's'}`} of "${page?.title || 'page'}"`
      })()
    : `${ids.length} of ${req.pageIds.length} page${req.pageIds.length === 1 ? '' : 's'}`

  return (
    <div className="overlay ex-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal ex-modal">
        <div className="modal-head">
          <PrinterI />
          <h2>Export or print</h2>
          <span className="ex-sub">{source}</span>
          <div className="spacer" />
          <button className="tb-btn" title="Close (Esc)" onClick={close}>
            <X size={15} />
          </button>
        </div>

        <div className="ex-main">
          <div className="ex-side">
            {req.cellIds?.length ? (
              <section>
                <h3>What</h3>
                <Seg
                  value={wholePage}
                  onChange={(v) => setWholePage(Boolean(v))}
                  options={[
                    { v: false, label: `Selected cells (${req.cellIds.length})` },
                    { v: true, label: 'Whole page' },
                  ]}
                />
              </section>
            ) : req.pageIds.length > 1 ? (
              <section>
                <h3>
                  Pages
                  <span className="ex-count">
                    {ids.length}/{req.pageIds.length}
                  </span>
                  <button className="ex-link" onClick={() => setPicked(picked.length === req.pageIds.length ? [] : req.pageIds)}>
                    {picked.length === req.pageIds.length ? 'None' : 'All'}
                  </button>
                </h3>
                <div className="ex-pages">
                  {req.pageIds.map((id) => {
                    const n = findNode(tree, id)
                    const where = pathTo(tree, id).slice(0, -1).map((x) => x.title).join(' › ')
                    return (
                      <label key={id} className="ex-page-row" title={where}>
                        <input
                          type="checkbox"
                          checked={picked.includes(id)}
                          onChange={(e) => setPicked(e.target.checked ? [...picked, id] : picked.filter((x) => x !== id))}
                        />
                        <span className="ex-page-name">{n?.title || 'Untitled page'}</span>
                      </label>
                    )
                  })}
                </div>
              </section>
            ) : null}

            <section>
              <h3>Layout</h3>
              <Seg
                value={o.layout}
                onChange={(layout) => set({ layout })}
                options={[
                  { v: 'document', label: 'Document', title: 'Cells in reading order, flowing over the sheets. Cells side by side stay side by side.' },
                  { v: 'canvas', label: 'As on page', title: 'Cells where they sit on the page, scaled to the sheet' },
                ]}
              />
              {o.layout === 'canvas' && <Tick on={o.fitSheet} label="Fit each page on one sheet" onChange={(fitSheet) => set({ fitSheet })} />}
            </section>

            <section>
              <h3>Colors</h3>
              <Seg
                value={o.theme}
                onChange={(theme) => set({ theme })}
                options={[
                  { v: 'light', label: 'Paper (light)', title: 'Dark text on white, saves ink. Light text colors are darkened to stay readable.' },
                  { v: 'app', label: 'App theme', title: 'The colors you see in the app, cell colors included' },
                ]}
              />
            </section>

            <section>
              <h3>Paper</h3>
              <div className="ex-line">
                <select value={o.paper.pageSize} onChange={(e) => setPaper({ pageSize: e.target.value as PaperSize })}>
                  {(['A4', 'Letter', 'Legal', 'A3', 'A5'] as PaperSize[]).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <Seg
                  value={o.paper.landscape}
                  onChange={(landscape) => setPaper({ landscape })}
                  options={[
                    { v: false, label: 'Portrait' },
                    { v: true, label: 'Landscape' },
                  ]}
                />
              </div>
              <div className="ex-line">
                <span className="ex-label">Margins</span>
                <select value={o.paper.margin} onChange={(e) => setPaper({ margin: Number(e.target.value) })}>
                  {MARGINS.map((m) => (
                    <option key={m.v} value={m.v}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ex-line">
                <span className="ex-label">Text size</span>
                <input type="range" min={0.6} max={1.4} step={0.05} value={o.scale} onChange={(e) => set({ scale: Number(e.target.value) })} />
                <span className="ex-val">{Math.round(o.scale * 100)}%</span>
              </div>
              <div className="ex-line">
                <span className="ex-label">Header</span>
                <input
                  className="ex-input"
                  placeholder="Text at the top of each sheet"
                  value={o.paper.header || ''}
                  onChange={(e) => setPaper({ header: e.target.value })}
                />
              </div>
            </section>

            <section>
              <h3>Show</h3>
              <Tick on={o.pageTitles} label="Page titles" onChange={(pageTitles) => set({ pageTitles })} />
              <Tick on={o.pageInfo} label="Notebook, section and date" onChange={(pageInfo) => set({ pageInfo })} />
              <Tick on={o.cellTitles} label="Cell titles" onChange={(cellTitles) => set({ cellTitles })} />
              <Tick on={o.ink} label="Ink and drawings" hint="Ink drawn on the page shows in the 'As on page' layout and as a picture in Markdown" onChange={(ink) => set({ ink })} />
              <Tick on={o.paper.pageNumbers} label="Page numbers" onChange={(pageNumbers) => setPaper({ pageNumbers })} />
              {multi && <Tick on={o.toc} label="Contents list" onChange={(toc) => set({ toc })} />}
              {multi && <Tick on={o.pageBreaks} label="Each page on a new sheet" onChange={(pageBreaks) => set({ pageBreaks })} />}
            </section>

            {multi && (
              <section>
                <h3>Files</h3>
                <Seg
                  value={o.files}
                  onChange={(files) => set({ files })}
                  options={[
                    { v: 'combined', label: 'One file' },
                    { v: 'separate', label: 'A file per page' },
                  ]}
                />
              </section>
            )}

            <section>
              <h3>Markdown</h3>
              <Tick
                on={o.frontMatter}
                label="Front matter (title, place, dates)"
                hint="A YAML block at the top, read by Obsidian and static site tools"
                onChange={(frontMatter) => set({ frontMatter })}
              />
              <div className="ex-note">Pictures go into an "assets" folder next to the file.</div>
            </section>
          </div>

          <div className="ex-preview">
            {previewDoc ? <iframe title="Preview" className="ex-preview-frame" srcDoc={previewDoc} /> : <div className="ex-wait">Preparing preview...</div>}
            {building && previewDoc && <div className="ex-building">Updating...</div>}
          </div>
        </div>

        <div className="ex-foot">
          <div className={`ex-status ${done?.error ? 'error' : ''}`}>
            {busy ? (
              <span className="shimmer">{busy}...</span>
            ) : done ? (
              <>
                <span>{done.msg}</span>
                {done.path && exporter && (
                  <>
                    <button className="ex-link" onClick={() => exporter!.open(done.path!)}>
                      Open
                    </button>
                    <button className="ex-link" onClick={() => exporter!.reveal(done.path!)}>
                      Show in folder
                    </button>
                  </>
                )}
              </>
            ) : items ? (
              <span className="ex-dim">
                {items.length} page{items.length === 1 ? '' : 's'}, {cellsTotal} cell{cellsTotal === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="ex-dim">Loading...</span>
            )}
          </div>
          <button className="btn" title="Copy everything as Markdown" disabled={!items?.length} onClick={copyMd}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn" title="A web page with the same look" disabled={!items?.length || Boolean(busy)} onClick={saveHtml}>
            <FileIcon size={14} /> HTML
          </button>
          <button className="btn" title="Markdown file(s), pictures in an assets folder" disabled={!items?.length || Boolean(busy)} onClick={saveMd}>
            <Download size={14} /> Markdown
          </button>
          <button className="btn" title="Print (Ctrl+P)" disabled={!items?.length || Boolean(busy)} onClick={print}>
            <PrinterI size={14} /> Print
          </button>
          <button className="btn primary" title="Save as PDF (Ctrl+S)" disabled={!items?.length || Boolean(busy)} onClick={savePdf}>
            <Download size={14} /> PDF
          </button>
        </div>
      </div>
    </div>
  )
}

/** A file name for a page, numbered when two pages share a title. */
function uniqueName(it: ExportItem, all: ExportItem[]) {
  const base = safeFileName(it.page.title || 'Untitled page')
  const same = all.filter((x) => safeFileName(x.page.title || 'Untitled page').toLowerCase() === base.toLowerCase())
  return same.length > 1 ? `${base} (${same.indexOf(it) + 1})` : base
}

/** Browser version (no desktop app): the browser's own print dialog. */
async function printInPage(html: string) {
  const f = document.createElement('iframe')
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  f.srcdoc = html
  document.body.appendChild(f)
  await new Promise<void>((resolve) => {
    const until = Date.now() + 10000
    const check = () => ((f.contentWindow as any)?.__exportReady || Date.now() > until ? resolve() : setTimeout(check, 120))
    f.onload = check
  })
  f.contentWindow?.print()
  setTimeout(() => f.remove(), 60000)
}
