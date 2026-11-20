/**
 * Export and print: builds one HTML document (for PDF, printing and the live
 * preview) or Markdown from pages, or from a few cells of a page.
 *
 * Two layouts:
 *  - document: cells in reading order, cells side by side stay side by side,
 *    flowing over as many sheets as needed.
 *  - canvas: cells where they sit on the page, scaled to the sheet width
 *    (or to one sheet per page).
 */
import katex from 'katex'
import { lowlight } from 'lowlight'
import { storage } from './storage'
import { pathTo, useStore } from '../store'
import type { Cell, Page, Stroke, TreeNode } from '../types'
import { buildWidgetDoc, currentTheme, fromBase64, kindOf, mix, toHex, type WidgetKind, type WidgetTheme } from '../widgets/widget'
import { stripMathDelimiters } from '../editor/math'
import { htmlToMarkdown } from '../editor/markdown'

/* ------------------------------------------------------------------ options */

export type PaperSize = 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5'

export interface Paper {
  pageSize: PaperSize
  landscape: boolean
  /** Inches on every side. */
  margin: number
  pageNumbers: boolean
  header?: string
}

export interface ExportOptions {
  layout: 'document' | 'canvas'
  theme: 'light' | 'app'
  paper: Paper
  pageTitles: boolean
  /** Notebook > section and the date under each page title. */
  pageInfo: boolean
  cellTitles: boolean
  /** A contents list first, when there is more than one page. */
  toc: boolean
  /** Each page starts on a new sheet. */
  pageBreaks: boolean
  /** Freehand ink drawn on the page (canvas layout) and drawings in cells. */
  ink: boolean
  /** Canvas layout: each page shrunk to fit on one sheet. */
  fitSheet: boolean
  /** Text size, 1 = as in the app. */
  scale: number
  /** Several pages: one file, or one file per page. */
  files: 'combined' | 'separate'
  /** Markdown: YAML front matter with the title, place and dates. */
  frontMatter: boolean
}

export const DEFAULT_EXPORT: ExportOptions = {
  layout: 'document',
  theme: 'light',
  paper: { pageSize: 'A4', landscape: false, margin: 0.6, pageNumbers: true },
  pageTitles: true,
  pageInfo: true,
  cellTitles: true,
  toc: true,
  pageBreaks: true,
  ink: true,
  fitSheet: false,
  scale: 0.9,
  files: 'combined',
  frontMatter: false,
}

/** Inches, portrait. */
export const PAPER_INCHES: Record<PaperSize, [number, number]> = {
  A4: [8.27, 11.69],
  Letter: [8.5, 11],
  Legal: [8.5, 14],
  A3: [11.69, 16.54],
  A5: [5.83, 8.27],
}

export function paperPx(p: Paper) {
  const [w, h] = PAPER_INCHES[p.pageSize]
  const [W, H] = p.landscape ? [h, w] : [w, h]
  const band = p.pageNumbers || p.header ? 0 : 0
  return { w: W * 96, h: H * 96, innerW: (W - 2 * p.margin) * 96, innerH: (H - 2 * p.margin) * 96 - band, margin: p.margin * 96 }
}

const PREFS_KEY = 'notes:export-options'

/** What was last chosen in the export dialog (the assistant exports the same way). */
export function savedExportOptions(): ExportOptions {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')
    if (v && typeof v === 'object') return { ...DEFAULT_EXPORT, ...v, paper: { ...DEFAULT_EXPORT.paper, ...(v.paper || {}) } }
  } catch {
    /* fresh start */
  }
  return DEFAULT_EXPORT
}

export function saveExportOptions(o: ExportOptions) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(o))
  } catch {
    /* private window */
  }
}

/** Pages at and below a node, top to bottom, leaving out archived ones. */
export function pagesUnder(n: TreeNode): string[] {
  if (n.archived) return []
  const own = n.kind === 'page' ? [n.id] : []
  return [...own, ...n.children.flatMap(pagesUnder)]
}

/* ------------------------------------------------------------------ what to export */

export interface ExportItem {
  page: Page
  cells: Cell[]
  /** Notebook and sections above the page. */
  where: string[]
  /** Only some cells of the page. */
  partial: boolean
}

/** The pages (fresh from disk, or as open with unsaved typing), in the order given. */
export async function loadItems(pageIds: string[], cellIds?: string[]): Promise<ExportItem[]> {
  const st = useStore.getState()
  const out: ExportItem[] = []
  for (const id of pageIds) {
    let page: Page | null = st.activePageId === id && st.page ? st.page : null
    if (!page) {
      try {
        page = (await storage.readPage(id)).data
      } catch {
        page = null
      }
    }
    if (!page) continue
    const keep = cellIds?.length ? new Set(cellIds) : null
    const cells = page.cells.filter((c) => (keep ? keep.has(c.id) : !c.conflict || c.conflict.reason !== 'deleted-elsewhere'))
    const where = pathTo(st.workspace.tree, id).slice(0, -1).map((n) => n.title)
    out.push({ page, cells, where, partial: Boolean(keep) })
  }
  return out
}

/* ------------------------------------------------------------------ helpers */

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export const safeFileName = (s: string) =>
  (s || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'

const fmtDate = (t: number) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '')

const lum = (hex: string) => {
  const h = toHex(hex).slice(1)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Cells grouped into rows: cells whose heights overlap sit side by side,
 * the rest follow top to bottom. Rows read top to bottom, cells left to right.
 */
export function readingRows(cells: Cell[]): Cell[][] {
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: { bottom: number; cells: Cell[] }[] = []
  for (const c of sorted) {
    const row = rows[rows.length - 1]
    // Joins the row when it starts well before the row ends (not just touching it).
    if (row && c.y < row.bottom - Math.min(40, c.h * 0.3) && !row.cells.some((o) => c.x < o.x + o.w - 8 && o.x < c.x + c.w - 8)) {
      row.cells.push(c)
      row.bottom = Math.max(row.bottom, c.y + c.h)
    } else rows.push({ bottom: c.y + c.h, cells: [c] })
  }
  return rows.map((r) => r.cells.sort((a, b) => a.x - b.x))
}

/** Bounds of a set of strokes. */
function strokeBox(strokes: Stroke[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) {
    if (s.eraser) continue
    for (let i = 0; i < s.points.length; i += 2) {
      const pad = s.size / 2
      x0 = Math.min(x0, s.points[i] - pad)
      y0 = Math.min(y0, s.points[i + 1] - pad)
      x1 = Math.max(x1, s.points[i] + pad)
      y1 = Math.max(y1, s.points[i + 1] + pad)
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 }
}

function polylines(strokes: Stroke[], darken: boolean) {
  return strokes
    .filter((s) => !s.eraser && s.points.length >= 2)
    .map((s) => {
      const pts: string[] = []
      for (let i = 0; i < s.points.length; i += 2) pts.push(`${+s.points[i].toFixed(1)},${+s.points[i + 1].toFixed(1)}`)
      if (pts.length === 1) pts.push(pts[0])
      const color = darken && s.size <= 10 && lum(s.color) > 0.8 ? '#333333' : s.color
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${esc(color)}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"${s.size > 10 ? ' opacity="0.38"' : ''}/>`
    })
    .join('')
}

/** A drawing cropped to its strokes, as a standalone SVG. */
export function strokesSvg(strokes: Stroke[], darken = false): string | null {
  const b = strokeBox(strokes)
  if (!b) return null
  const pad = 4
  const w = Math.ceil(b.x1 - b.x0 + pad * 2)
  const h = Math.ceil(b.y1 - b.y0 + pad * 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${(b.x0 - pad).toFixed(1)} ${(b.y0 - pad).toFixed(1)} ${w} ${h}">${polylines(strokes, darken)}</svg>`
}

/** lowlight's tree as HTML. */
function hastHtml(node: any): string {
  if (!node) return ''
  if (node.type === 'text') return esc(node.value)
  const inner = (node.children || []).map(hastHtml).join('')
  if (node.type === 'element') {
    const cls = (node.properties?.className || []).join(' ')
    return `<${node.tagName}${cls ? ` class="${esc(cls)}"` : ''}>${inner}</${node.tagName}>`
  }
  return inner
}

function highlight(code: string, lang: string) {
  try {
    if (lang && lowlight.registered(lang)) return hastHtml(lowlight.highlight(lang, code))
  } catch {
    /* plain below */
  }
  return esc(code)
}

const LIGHT_PALETTE = ['#3b6fe0', '#c94f5a', '#b07d10', '#3f8f2f', '#2a7fc4', '#9147bb', '#20909e', '#c0692a']

function widgetTheme(o: ExportOptions): WidgetTheme {
  if (o.theme === 'app') return currentTheme()
  const t = currentTheme()
  return { ...t, dark: false, bg: '#ffffff', text: '#1e1e1e', dim: '#5c5c5c', faint: '#8a8a8a', line: '#d4d4d4', palette: LIGHT_PALETTE }
}

/* ------------------------------------------------------------------ cell content */

let frameSeq = 0

/** A cell's stored HTML made ready for paper: math drawn, code colored, diagrams placed, colors readable. */
async function cellBodyHtml(html: string, o: ExportOptions, wt: WidgetTheme): Promise<string> {
  const doc = new DOMParser().parseFromString(`<div id="r">${html || ''}</div>`, 'text/html')
  const root = doc.getElementById('r')!

  root.querySelectorAll<HTMLElement>('[data-latex]').forEach((el) => {
    const display = el.tagName === 'DIV'
    const tex = stripMathDelimiters(el.getAttribute('data-latex') || '')
    try {
      el.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' })
    } catch {
      el.textContent = tex
    }
    el.classList.add(display ? 'ex-math-block' : 'ex-math')
  })

  root.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
    const code = pre.querySelector('code')
    const lang = (code?.className.match(/language-([\w+-]+)/) || [])[1] || pre.getAttribute('data-language') || ''
    const text = code ? code.textContent || '' : pre.textContent || ''
    pre.classList.add('code-block')
    pre.innerHTML = `<code class="hljs${lang ? ` language-${esc(lang)}` : ''}">${highlight(text, lang)}</code>`
  })

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('div[data-html-embed]'))) {
    const kind = kindOf(el.getAttribute('data-kind')) as WidgetKind
    let src = ''
    try {
      src = fromBase64(el.getAttribute('data-html-src') || '')
    } catch {
      src = ''
    }
    const align = el.getAttribute('data-align') || 'left'
    const width = Number(el.getAttribute('data-width')) || 0
    const fixedH = Number(el.getAttribute('data-height')) || 0
    let docHtml = ''
    try {
      docHtml = await buildWidgetDoc(kind, src, wt, { opaque: true })
    } catch (e) {
      docHtml = `<p style="color:#c00">Could not draw this block: ${esc(String((e as Error)?.message || e))}</p>`
    }
    const name = `exw${++frameSeq}`
    const wrap = doc.createElement('div')
    wrap.className = 'ex-embed'
    wrap.style.textAlign = align
    wrap.innerHTML = `<iframe class="ex-frame" name="${name}" sandbox="allow-scripts" scrolling="no" data-w="${width}"${fixedH ? ` data-h="${fixedH}"` : ''} style="height:${fixedH || 120}px${width ? `;width:${width}px` : ''}" srcdoc="${esc(docHtml)}"></iframe>`
    el.replaceWith(wrap)
  }

  // Light paper: text picked for a dark screen would vanish on white.
  if (o.theme === 'light') {
    root.querySelectorAll<HTMLElement>('[style*="color"]').forEach((el) => {
      const c = el.style.color
      if (c && lum(c) > 0.72) el.style.color = mix(toHex(c), '#000000', 0.55)
    })
  }
  root.querySelectorAll('img').forEach((img) => img.setAttribute('loading', 'eager'))
  return root.innerHTML
}

/* ------------------------------------------------------------------ styles */

let editorCss: string | null = null

/** The app's own rules for note content and math, with their font files resolved. */
function collectEditorCss(): string {
  if (editorCss !== null) return editorCss
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    const base = sheet.href || document.baseURI
    const fix = (css: string) =>
      css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, _q, u) => {
        if (/^(data|blob|https?|file|asset):/i.test(u)) return m
        try {
          return `url("${new URL(u, base).href}")`
        } catch {
          return m
        }
      })
    for (const r of Array.from(rules)) {
      const css = r.cssText
      if (r instanceof CSSFontFaceRule) {
        if (/katex/i.test(css)) parts.push(fix(css))
      } else if (r instanceof CSSStyleRule) {
        if (/\.ProseMirror|\.katex|\.hljs/.test(r.selectorText) && !/\.ProseMirror-(focused|selectednode|gapcursor)|:hover|caret|cursor/.test(r.selectorText)) parts.push(fix(css))
      }
    }
  }
  editorCss = parts.join('\n')
  return editorCss
}

function themeVars(o: ExportOptions): string {
  const cs = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (let i = 0; i < cs.length; i++) {
    const n = cs[i]
    if (n.startsWith('--')) vars[n] = cs.getPropertyValue(n).trim()
  }
  if (o.theme === 'light') {
    Object.assign(vars, {
      '--bg-0': '#f6f6f6', '--bg-1': '#f0f0f0', '--bg-2': '#f7f7f7', '--bg-3': '#ececec', '--bg-4': '#dddddd',
      '--canvas': '#ffffff', '--cell-bg': '#ffffff', '--text': '#1e1e1e', '--text-dim': '#5c5c5c', '--text-faint': '#8a8a8a',
      '--line': '#d4d4d4', '--line-soft': '#e6e6e6',
    })
  }
  return `:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`
}

function docCss(o: ExportOptions, preview: boolean): string {
  const s = useStore.getState().settings
  const light = o.theme === 'light'
  const px = paperPx(o.paper)
  const body = Math.round(s.bodySize * o.scale * 10) / 10
  const titleColor = light ? (lum(s.titleColor) > 0.5 ? mix(toHex(s.titleColor), '#000000', 0.5) : s.titleColor) : s.titleColor
  const bodyColor = light ? '#1e1e1e' : s.bodyColor
  return `
${themeVars(o)}
${collectEditorCss()}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:${light ? '#ffffff' : 'var(--canvas)'};color:${bodyColor};font-family:var(--font-body,'Segoe UI',system-ui,sans-serif);font-size:${body}px;line-height:${s.lineHeight};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ProseMirror{white-space:normal;color:inherit}
.ProseMirror img{max-width:100%;height:auto}
.ProseMirror table{max-width:100%}
.ex-page{position:relative}
.ex-page + .ex-page{margin-top:${o.pageBreaks ? 0 : 36}px}
${o.pageBreaks ? '.ex-break{break-before:page}' : '.ex-break{border-top:1px solid var(--line);padding-top:24px}'}
.ex-head{margin:0 0 ${Math.round(14 * o.scale)}px}
.ex-title{font-family:var(--font-heading,'Segoe UI Semibold',sans-serif);font-size:${Math.round(s.pageTitleSize * o.scale)}px;line-height:1.2;margin:0;font-weight:600}
.ex-info{color:var(--text-faint);font-size:${Math.max(10, Math.round(12 * o.scale))}px;margin-top:4px}
.ex-row{display:flex;gap:${Math.round(18 * o.scale)}px;align-items:flex-start;margin:0 0 ${Math.round(14 * o.scale)}px}
.ex-cell{position:relative;min-width:0;break-inside:auto}
.ex-row > .ex-cell{flex:var(--grow) 1 0}
.ex-cell-title{font-family:var(--font-heading,'Segoe UI Semibold',sans-serif);font-size:${Math.round(s.titleSize * o.scale)}px;color:${titleColor};font-weight:600;margin:0 0 4px;break-after:avoid;line-height:1.3}
.ex-cell.boxed{border:1px solid var(--cell-border,var(--line));border-radius:${s.cellRadius}px;padding:${Math.round(s.cellPadding * 0.8)}px}
.ex-ink{position:absolute;inset:0;overflow:visible;pointer-events:none}
.ex-drawing{display:block;max-width:100%;height:auto}
.ex-embed{margin:6px 0;break-inside:avoid}
.ex-frame{border:0;width:100%;display:inline-block;background:transparent;vertical-align:top}
pre.code-block{break-inside:avoid}
.ex-math-block{break-inside:avoid}
.ex-canvas{position:relative}
.ex-canvas > .ex-cell{position:absolute}
.ex-canvas > .ex-page-ink{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.ex-fit{break-inside:avoid}
.ex-toc{margin:0 0 24px}
.ex-toc h2{font-family:var(--font-heading,sans-serif);font-size:${Math.round(22 * o.scale)}px;margin:0 0 10px}
.ex-toc ol{margin:0;padding-left:22px}
.ex-toc li{margin:4px 0}
.ex-toc a{color:inherit;text-decoration:none}
.ex-toc .ex-where{color:var(--text-faint);font-size:.85em;margin-left:8px}
.ex-empty{color:var(--text-faint);font-style:italic}
${
  preview
    ? `html{background:#6b6b6b}
body{background:transparent;padding:24px 0}
.ex-sheet{width:${px.w}px;min-height:${px.h}px;margin:0 auto 24px;padding:${px.margin}px;background:${light ? '#ffffff' : 'var(--canvas)'};box-shadow:0 4px 18px rgba(0,0,0,.35)}
.ex-break{break-before:auto}
.ex-page + .ex-page{margin-top:0}`
    : `.ex-sheet{display:contents}`
}
`
}

/** Runs in the document: sizes diagrams, reflows the canvas layout, then says it is ready. */
function docScript(o: ExportOptions, preview: boolean): string {
  const px = paperPx(o.paper)
  return `(function(){
var frames=[].slice.call(document.querySelectorAll('iframe.ex-frame'));
var waiting={};frames.forEach(function(f){waiting[f.name]=1});
var ready=false;
function layoutCanvas(){
  [].slice.call(document.querySelectorAll('.ex-canvas')).forEach(function(cv){
    var cells=[].slice.call(cv.querySelectorAll(':scope > .ex-cell')).map(function(el){return{el:el,x:+el.dataset.x,y:+el.dataset.y,w:+el.dataset.w,h:+el.dataset.h,grow:Math.max(0,el.offsetHeight-(+el.dataset.h)),shift:0}});
    cells.sort(function(a,b){return a.y-b.y});
    var bottom=+cv.dataset.h||0;
    cells.forEach(function(c,i){
      for(var j=0;j<i;j++){var p=cells[j];if(p.y+p.h<=c.y+1&&c.x<p.x+p.w&&p.x<c.x+c.w)c.shift=Math.max(c.shift,p.shift+p.grow)}
      c.el.style.top=(c.y+c.shift)+'px';
      bottom=Math.max(bottom,c.y+c.shift+c.el.offsetHeight);
    });
    cv.style.height=(bottom+8)+'px';
    var W=+cv.dataset.w||1, H=bottom+8;
    var z=Math.min(1,${px.innerW}/W);
    ${o.fitSheet ? `z=Math.min(z,${px.innerH - (o.pageTitles ? 90 : 0)}/H);` : ''}
    cv.style.zoom=z<0.999?String(z):'';
  });
}
function finish(){
  if(ready)return;ready=true;
  layoutCanvas();
  var imgs=[].slice.call(document.images).filter(function(i){return!i.complete});
  Promise.all(imgs.map(function(i){return new Promise(function(r){i.onload=i.onerror=r;setTimeout(r,6000)})})).then(function(){
    layoutCanvas();
    setTimeout(function(){window.__exportReady=true},150);
  });
}
addEventListener('message',function(e){
  var d=e.data;if(!d||!d.__widget)return;
  var f=null;for(var i=0;i<frames.length;i++)if(frames[i].name===d.__widget)f=frames[i];
  if(!f)return;
  if(d.type==='size'&&typeof d.h==='number'){
    var avail=f.parentElement.clientWidth||${Math.round(px.innerW)};
    var set=+f.dataset.w||0;
    var own=d.w>d.vw+2?d.w:(d.cw&&d.cw<d.vw-8?d.cw:0);
    var want=set||own;
    var z=want&&want>avail?avail/want:1;
    if(own&&own>avail){try{f.contentWindow.postMessage({__zoom:avail/own},'*')}catch(x){}}
    if(want)f.style.width=Math.min(avail,Math.ceil(want*z)+2)+'px';
    if(!f.dataset.h)f.style.height=Math.ceil(d.h*(own&&own>avail?avail/own:1))+'px';
    if(ready)layoutCanvas();
  }
  if(d.type==='done'){delete waiting[f.name];if(!Object.keys(waiting).length)setTimeout(finish,350)}
});
if(!frames.length)setTimeout(finish,30);
setTimeout(finish,8000);
${preview ? `window.__exportPreview=true;` : ''}
})();`
}

/* ------------------------------------------------------------------ HTML document */

async function cellHtml(c: Cell, o: ExportOptions, wt: WidgetTheme, abs: boolean): Promise<string> {
  const title = o.cellTitles && c.showTitle && c.title?.trim() ? `<div class="ex-cell-title">${esc(c.title)}</div>` : ''
  let body = ''
  if (c.kind === 'ink' || (!c.html && c.strokes?.length)) {
    const svg = o.ink && c.strokes?.length ? strokesSvg(c.strokes, o.theme === 'light') : null
    body = svg && !abs ? svg.replace('<svg ', '<svg class="ex-drawing" ') : ''
  } else body = `<div class="ProseMirror">${await cellBodyHtml(c.html, o, wt)}</div>`
  // Ink on a text cell, or an ink cell in place: drawn over the cell where it was.
  const overlay =
    o.ink && c.strokes?.length && (abs || (c.kind !== 'ink' && c.html))
      ? `<svg class="ex-ink" width="${c.w}" height="${c.h}">${polylines(c.strokes, o.theme === 'light')}</svg>`
      : ''
  const app = o.theme === 'app'
  const style: string[] = []
  if (app && c.bg) style.push(`background:${c.bg}`)
  if (app && c.border) style.push(`--cell-border:${c.border}`)
  const boxed = app && (c.bg || c.border) ? ' boxed' : ''
  if (abs) style.push(`left:${c.x}px`, `top:${c.y}px`, `width:${c.w}px`, `min-height:${c.kind === 'ink' ? c.h : 0}px`)
  return `<div class="ex-cell${boxed}" data-x="${c.x}" data-y="${c.y}" data-w="${c.w}" data-h="${c.h}" style="${style.join(';')};--grow:${Math.max(1, c.w)}">${overlay}${title}${body}</div>`
}

async function pageHtml(it: ExportItem, o: ExportOptions, wt: WidgetTheme, first: boolean): Promise<string> {
  const { page } = it
  const head =
    o.pageTitles || o.pageInfo
      ? `<header class="ex-head">${o.pageTitles ? `<h1 class="ex-title">${esc(page.title || 'Untitled page')}</h1>` : ''}${
          o.pageInfo
            ? `<div class="ex-info">${esc([it.where.join(' › '), fmtDate(page.updatedAt), it.partial ? `${it.cells.length} selected cell${it.cells.length === 1 ? '' : 's'}` : ''].filter(Boolean).join('  ·  '))}</div>`
            : ''
        }</header>`
      : ''
  let body = ''
  if (!it.cells.length && !(o.ink && page.strokes?.length)) body = `<p class="ex-empty">This page is empty.</p>`
  else if (o.layout === 'canvas') {
    const cells = it.cells
    const strokes = o.ink && !it.partial ? page.strokes || [] : []
    const sb = strokeBox(strokes)
    const x0 = Math.min(...cells.map((c) => c.x), sb ? sb.x0 : Infinity)
    const y0 = Math.min(...cells.map((c) => c.y), sb ? sb.y0 : Infinity)
    const x1 = Math.max(...cells.map((c) => c.x + c.w), sb ? sb.x1 : -Infinity)
    const y1 = Math.max(...cells.map((c) => c.y + c.h), sb ? sb.y1 : -Infinity)
    const shifted = cells.map((c) => ({ ...c, x: c.x - x0, y: c.y - y0 }))
    const parts = await Promise.all(shifted.sort((a, b) => a.z - b.z).map((c) => cellHtml(c, o, wt, true)))
    const ink = strokes.length
      ? `<svg class="ex-page-ink" width="${Math.ceil(x1 - x0)}" height="${Math.ceil(y1 - y0)}" viewBox="${x0} ${y0} ${Math.ceil(x1 - x0)} ${Math.ceil(y1 - y0)}">${polylines(strokes, o.theme === 'light')}</svg>`
      : ''
    body = `<div class="ex-canvas${o.fitSheet ? ' ex-fit' : ''}" data-w="${Math.ceil(x1 - x0)}" data-h="${Math.ceil(y1 - y0)}" style="width:${Math.ceil(x1 - x0)}px;height:${Math.ceil(y1 - y0)}px">${ink}${parts.join('')}</div>`
  } else {
    const rows = readingRows(it.cells)
    const out: string[] = []
    for (const row of rows) out.push(`<div class="ex-row">${(await Promise.all(row.map((c) => cellHtml(c, o, wt, false)))).join('')}</div>`)
    body = out.join('')
  }
  return `<section class="ex-page${first ? '' : ' ex-break'}" id="p-${esc(page.id)}"><div class="ex-sheet">${head}${body}</div></section>`
}

/** One printable HTML document for all the items. */
export async function buildHtml(items: ExportItem[], o: ExportOptions, opts: { preview?: boolean; title?: string } = {}): Promise<string> {
  const wt = widgetTheme(o)
  const pages: string[] = []
  const toc =
    o.toc && items.length > 1
      ? `<section class="ex-page"><div class="ex-sheet"><nav class="ex-toc"><h2>Contents</h2><ol>${items
          .map((it) => `<li><a href="#p-${esc(it.page.id)}">${esc(it.page.title || 'Untitled page')}</a>${it.where.length ? `<span class="ex-where">${esc(it.where.join(' › '))}</span>` : ''}</li>`)
          .join('')}</ol></nav></div></section>`
      : ''
  for (let i = 0; i < items.length; i++) pages.push(await pageHtml(items[i], o, wt, i === 0 && !toc))
  const title = opts.title || (items.length === 1 ? items[0].page.title : `${items.length} pages`) || 'Notes'
  let body = `${toc}${pages.join('')}`
  // Chromium leaves sandboxed frames out of printed sheets. Paper copies are drawn
  // in their own isolated window with no access to the app, so there the frames
  // run unsandboxed; the preview inside the app keeps them sandboxed.
  if (!opts.preview) body = body.replace(/(<iframe class="ex-frame" name="exw\d+") sandbox="allow-scripts"/g, '$1')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="color-scheme" content="${o.theme === 'light' ? 'light' : 'dark'}"><style>${docCss(o, Boolean(opts.preview))}</style></head><body${opts.preview ? ' class="preview"' : ''}>${body}<script>${docScript(o, Boolean(opts.preview))}</script></body></html>`
}

/* ------------------------------------------------------------------ Markdown */

export interface MdFile {
  name: string
  text: string
}

export interface MdBundle {
  files: MdFile[]
  /** Pictures from the notes folder to copy into assets/. */
  assets: string[]
  /** Drawings made here, written into assets/. */
  drawings: MdFile[]
}

const FENCE: Record<WidgetKind, string> = { html: 'html', mermaid: 'mermaid', wavedrom: 'wavedrom', chart: 'chart', kmap: 'kmap', graphviz: 'dot', tikz: 'tikz' }

function cellMarkdown(c: Cell, o: ExportOptions, assets: Set<string>, drawings: MdFile[], assetDir: string): string {
  const title = o.cellTitles && c.title?.trim() ? `## ${c.title.trim()}\n\n` : ''
  let md = ''
  if (c.html) {
    const doc = new DOMParser().parseFromString(`<div id="r">${c.html}</div>`, 'text/html')
    const root = doc.getElementById('r')!
    root.querySelectorAll<HTMLElement>('div[data-html-embed]').forEach((el) => {
      const kind = kindOf(el.getAttribute('data-kind'))
      let src = ''
      try {
        src = fromBase64(el.getAttribute('data-html-src') || '')
      } catch {
        /* empty block */
      }
      const pre = doc.createElement('pre')
      const code = doc.createElement('code')
      code.className = `language-${FENCE[kind]}`
      code.textContent = src.replace(/\n+$/, '')
      pre.appendChild(code)
      el.replaceWith(pre)
    })
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || ''
      const m = src.match(/^asset:\/\/local\/(.+)$/)
      if (m) {
        const name = decodeURIComponent(m[1]).split(/[\\/]/).pop()!
        assets.add(name)
        img.setAttribute('src', `${assetDir}/${encodeURI(name)}`)
      }
      if (!img.getAttribute('alt')) img.setAttribute('alt', 'image')
    })
    md = htmlToMarkdown(root.innerHTML)
  }
  if (o.ink && c.strokes?.length) {
    const svg = strokesSvg(c.strokes)
    if (svg) {
      const name = `drawing-${c.id}.svg`
      drawings.push({ name, text: svg })
      md += `${md ? '\n\n' : ''}![Drawing](${assetDir}/${name})`
    }
  }
  return (title + md).trim()
}

function pageMd(it: ExportItem, o: ExportOptions, assets: Set<string>, drawings: MdFile[], level = 1, assetDir = 'assets'): string {
  const { page } = it
  const lines: string[] = []
  if (o.frontMatter && level === 1) {
    const q = (s: string) => JSON.stringify(s)
    lines.push('---', `title: ${q(page.title || 'Untitled page')}`)
    if (it.where.length) lines.push(`location: ${q(it.where.join(' / '))}`)
    if (page.createdAt) lines.push(`created: ${new Date(page.createdAt).toISOString()}`)
    if (page.updatedAt) lines.push(`updated: ${new Date(page.updatedAt).toISOString()}`)
    lines.push('---', '')
  }
  const h = '#'.repeat(level)
  if (o.pageTitles) lines.push(`${h} ${page.title || 'Untitled page'}`, '')
  if (o.pageInfo && (it.where.length || page.updatedAt)) lines.push(`*${[it.where.join(' › '), fmtDate(page.updatedAt)].filter(Boolean).join(' · ')}*`, '')
  const blocks = readingRows(it.cells)
    .flat()
    .map((c) => {
      let md = cellMarkdown(c, o, assets, drawings, assetDir)
      // Cell titles sit one level under the page title.
      if (level > 1) md = md.replace(/^(#{1,5}) /gm, (_m, hs) => `${'#'.repeat(Math.min(6, hs.length + level - 1))} `)
      return md
    })
    .filter(Boolean)
  lines.push(blocks.join('\n\n'))
  if (o.ink && !it.partial && page.strokes?.length) {
    const svg = strokesSvg(page.strokes)
    if (svg) {
      const name = `page-drawing-${page.id}.svg`
      drawings.push({ name, text: svg })
      lines.push('', `![Drawing on the page](${assetDir}/${name})`)
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-')

/** Markdown files for the items: one combined file, or one per page. */
export function buildMarkdown(items: ExportItem[], o: ExportOptions, combinedName: string): MdBundle {
  const assets = new Set<string>()
  const drawings: MdFile[] = []
  const files: MdFile[] = []
  if (o.files === 'separate' || items.length === 1) {
    const used = new Set<string>()
    for (const it of items) {
      let base = safeFileName(it.page.title || 'Untitled page')
      for (let n = 2; used.has(base.toLowerCase()); n++) base = `${safeFileName(it.page.title)} (${n})`
      used.add(base.toLowerCase())
      files.push({ name: `${base}.md`, text: pageMd(it, o, assets, drawings) })
    }
  } else {
    const parts: string[] = [`# ${combinedName}`, '']
    if (o.toc) {
      parts.push('## Contents', '', ...items.map((it, i) => `${i + 1}. [${it.page.title || 'Untitled page'}](#${slug(it.page.title || 'Untitled page')})`), '')
    }
    for (const it of items) parts.push('---', '', pageMd(it, { ...o, frontMatter: false, pageTitles: true }, assets, drawings, 2))
    files.push({ name: `${safeFileName(combinedName)}.md`, text: parts.join('\n').replace(/\n{3,}/g, '\n\n') })
  }
  return { files, assets: [...assets], drawings }
}

/* ------------------------------------------------------------------ desktop bridge */

export interface Exporter {
  saveDialog(name: string, ext: string, label: string): Promise<string | null>
  pickFolder(): Promise<string | null>
  pdf(html: string, paper: Paper, out: string): Promise<{ ok: boolean; error?: string }>
  print(html: string, paper: Paper): Promise<{ ok: boolean; error?: string }>
  writeText(out: string, content: string): Promise<boolean>
  copyAssets(names: string[], dir: string): Promise<number>
  reveal(p: string): Promise<void>
  open(p: string): Promise<string>
  resolvePath(p: string): Promise<string>
}

/** A file name per page, numbered when two pages share a title. */
export function fileNameFor(it: ExportItem, all: ExportItem[]) {
  const base = safeFileName(it.page.title || 'Untitled page')
  const same = all.filter((x) => safeFileName(x.page.title || 'Untitled page').toLowerCase() === base.toLowerCase())
  return same.length > 1 ? `${base} (${same.indexOf(it) + 1})` : base
}

/**
 * Writes the items straight to a place (no dialogs): `target` is a file, or a
 * folder the files go into. Returns the files written.
 */
export async function exportToPath(items: ExportItem[], o: ExportOptions, format: 'pdf' | 'md' | 'html', target: string, name: string): Promise<string[]> {
  const ex = exporter
  if (!ex) throw new Error('Saving files works only in the desktop app.')
  const ext = format === 'md' ? 'md' : format
  const isFile = /\.(pdf|md|markdown|html?)$/i.test(target)
  const separate = o.files === 'separate' && items.length > 1
  const dir = isFile ? dirOf(target) : target
  const written: string[] = []
  if (format === 'md') {
    const bundle = buildMarkdown(items, o, name)
    for (const f of bundle.files) {
      const out = isFile && bundle.files.length === 1 ? target : joinPath(dir, f.name)
      await ex.writeText(out, f.text)
      written.push(out)
    }
    const assetDir = joinPath(dir, 'assets')
    if (bundle.assets.length) await ex.copyAssets(bundle.assets, assetDir)
    for (const d of bundle.drawings) await ex.writeText(joinPath(assetDir, d.name), d.text)
    return written
  }
  const groups = separate ? items.map((it) => ({ list: [it], file: joinPath(dir, `${fileNameFor(it, items)}.${ext}`) })) : [{ list: items, file: isFile ? target : joinPath(dir, `${safeFileName(name)}.${ext}`) }]
  for (const g of groups) {
    const html = await buildHtml(g.list, o, { title: g.list.length === 1 ? g.list[0].page.title : name })
    if (format === 'html') await ex.writeText(g.file, html)
    else {
      const r = await ex.pdf(html, o.paper, g.file)
      if (!r.ok) throw new Error(r.error || 'PDF failed')
    }
    written.push(g.file)
  }
  return written
}

/** The name for a set of pages: the page title, the section they share, or a count. */
export function exportName(items: ExportItem[]) {
  if (!items.length) return 'Notes'
  if (items.length === 1) return items[0].page.title || 'Untitled page'
  const places = new Set(items.map((i) => i.where.join(' › ')))
  if (places.size === 1 && items[0].where.length) return items[0].where[items[0].where.length - 1]
  return `Notes (${items.length} pages)`
}

export const exporter: Exporter | null = (window as any).notes?.exporter || null

export const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`
export const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
