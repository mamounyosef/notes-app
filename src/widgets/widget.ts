/**
 * HTML blocks ("widgets") and the diagrams drawn in them.
 *
 * A block stores its source and a kind:
 *   - html     a self-contained HTML/SVG/JS widget
 *   - mermaid  Mermaid text: flowcharts, state machines, sequence, class, ER, mind maps, timelines...
 *   - wavedrom WaveDrom JSON: logic circuits ({assign}), timing diagrams ({signal}), register fields ({reg})
 *   - chart    a Chart.js config (JSON)
 *
 * The source only says what the figure contains; the libraries do the layout.
 * Mermaid and WaveDrom are drawn here, in the app (Mermaid is too big to load
 * in every block), and the finished SVG goes into the block. Chart.js and
 * KaTeX run inside the block's sandbox, only when the source uses them.
 * Everything is themed from the app's colors and works offline.
 */
import JSON5 from 'json5'
import { kmapExpressionTex, renderKmap } from './kmap'

export type WidgetKind = 'html' | 'mermaid' | 'wavedrom' | 'chart' | 'kmap' | 'graphviz' | 'tikz'
export const WIDGET_KINDS: WidgetKind[] = ['html', 'mermaid', 'wavedrom', 'chart', 'kmap', 'graphviz', 'tikz']
/** Drawn by the main process (Graphviz and TeX run in Node). */
const MAIN_KINDS = new Set<WidgetKind>(['graphviz', 'tikz'])

/** Block sources are stored as base64 (UTF-8 safe). */
export function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
}
export function fromBase64(b64: string): string {
  try {
    return decodeURIComponent(escape(atob(b64)))
  } catch {
    return ''
  }
}
export const kindOf = (k: unknown): WidgetKind => (WIDGET_KINDS.includes(k as WidgetKind) ? (k as WidgetKind) : 'html')

/** The Markdown fence name the agent writes for each kind. */
export const FENCE_OF: Record<WidgetKind, string> = { html: 'widget', mermaid: 'mermaid', wavedrom: 'wavedrom', chart: 'chart', kmap: 'kmap', graphviz: 'graphviz', tikz: 'tikz' }
export const KIND_OF_FENCE: Record<string, WidgetKind> = { widget: 'html', 'html-widget': 'html', mermaid: 'mermaid', wavedrom: 'wavedrom', chart: 'chart', chartjs: 'chart', kmap: 'kmap', karnaugh: 'kmap', graphviz: 'graphviz', dot: 'graphviz', tikz: 'tikz' }

export const KIND_LABEL: Record<WidgetKind, string> = {
  html: 'HTML widget',
  mermaid: 'Diagram',
  wavedrom: 'Logic / timing',
  chart: 'Chart',
  kmap: 'K-map',
  graphviz: 'Graphviz',
  tikz: 'TikZ figure',
}

/* ------------------------------------------------------------------ theme */

export interface WidgetTheme {
  dark: boolean
  bg: string
  text: string
  dim: string
  faint: string
  line: string
  accent: string
  font: string
  mono: string
  palette: string[]
}

const DARK_PALETTE = ['#7c9cff', '#e06c75', '#e5c07b', '#98c379', '#61afef', '#c678dd', '#56b6c2', '#d19a66']
const LIGHT_PALETTE = ['#3b6fe0', '#c94f5a', '#b07d10', '#3f8f2f', '#2a7fc4', '#9147bb', '#20909e', '#c0692a']

let probe: CanvasRenderingContext2D | null = null
/** Any CSS color as #rrggbb (Mermaid's theme only takes hex). */
export function toHex(color: string, fallback = '#888888'): string {
  probe = probe || document.createElement('canvas').getContext('2d')
  if (!probe || !color) return fallback
  probe.fillStyle = fallback
  probe.fillStyle = color.trim()
  const v = String(probe.fillStyle)
  if (v.startsWith('#')) return v
  const m = /rgba?\(([^)]+)\)/.exec(v)
  if (!m) return fallback
  const [r, g, b] = m[1].split(',').map((x) => Math.round(Number(x)))
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

function rgb(hex: string) {
  const h = toHex(hex).slice(1)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
/** a mixed with b: t = 0 is a, t = 1 is b. */
export function mix(a: string, b: string, t: number) {
  const A = rgb(a)
  const B = rgb(b)
  return `#${A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('')}`
}
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** The colors around `el` (its cell's background when it has its own). */
export function currentTheme(el?: Element | null): WidgetTheme {
  const root = getComputedStyle(document.documentElement)
  const v = (name: string, fb: string) => root.getPropertyValue(name).trim() || fb
  let bg = toHex(v('--cell-bg', '#242424'))
  const cell = el?.closest('.cell') as HTMLElement | null
  if (cell) {
    const c = getComputedStyle(cell).backgroundColor
    if (c && !/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') bg = toHex(c, bg)
  }
  const dark = luminance(bg) < 0.5
  const text = toHex(v('--text', dark ? '#e6e6e6' : '#1e1e1e'))
  return {
    dark,
    bg,
    text,
    dim: toHex(v('--text-dim', dark ? '#a5a5a5' : '#5c5c5c')),
    faint: toHex(v('--text-faint', dark ? '#7a7a7a' : '#8a8a8a')),
    line: toHex(v('--line', dark ? '#383838' : '#d4d4d4')),
    accent: toHex(v('--accent', '#7c9cff')),
    font: "'Segoe UI', system-ui, sans-serif",
    mono: "Consolas, 'Cascadia Mono', monospace",
    palette: dark ? DARK_PALETTE : LIGHT_PALETTE,
  }
}

/* ------------------------------------------------------------------ Mermaid (drawn in the app) */

let mermaidMod: Promise<any> | null = null
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

function mermaidConfig(t: WidgetTheme) {
  const p = t.palette
  const tint = (c: string, k = t.dark ? 0.24 : 0.14) => mix(t.bg, c, k)
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: t.font,
    themeVariables: {
      darkMode: t.dark,
      background: t.bg,
      fontFamily: t.font,
      fontSize: '15px',
      primaryColor: tint(p[0]),
      primaryTextColor: t.text,
      primaryBorderColor: p[0],
      secondaryColor: tint(p[3]),
      secondaryTextColor: t.text,
      secondaryBorderColor: p[3],
      tertiaryColor: tint(p[2], t.dark ? 0.16 : 0.1),
      tertiaryTextColor: t.text,
      tertiaryBorderColor: p[2],
      lineColor: t.dim,
      textColor: t.text,
      titleColor: t.text,
      mainBkg: tint(p[0]),
      nodeBorder: p[0],
      nodeTextColor: t.text,
      clusterBkg: mix(t.bg, t.text, 0.04),
      clusterBorder: t.line,
      edgeLabelBackground: t.bg,
      labelBackground: t.bg,
      noteBkgColor: tint(p[2]),
      noteTextColor: t.text,
      noteBorderColor: p[2],
      actorBkg: tint(p[0]),
      actorBorder: p[0],
      actorTextColor: t.text,
      actorLineColor: t.dim,
      signalColor: t.text,
      signalTextColor: t.text,
      sequenceNumberColor: t.bg,
      activationBkgColor: tint(p[4]),
      activationBorderColor: p[4],
      labelBoxBkgColor: tint(p[0]),
      labelBoxBorderColor: p[0],
      labelTextColor: t.text,
      loopTextColor: t.text,
      stateBkg: tint(p[0]),
      stateLabelColor: t.text,
      transitionColor: t.dim,
      transitionLabelColor: t.text,
      compositeBackground: mix(t.bg, t.text, 0.04),
      altBackground: mix(t.bg, t.text, 0.06),
      classText: t.text,
      git0: p[0], git1: p[1], git2: p[2], git3: p[3], git4: p[4], git5: p[5], git6: p[6], git7: p[7],
      ...Object.fromEntries(p.map((c, i) => [`pie${i + 1}`, c])),
      ...Object.fromEntries(p.map((c, i) => [`cScale${i}`, tint(c, t.dark ? 0.45 : 0.3)])),
      pieTitleTextColor: t.text,
      pieSectionTextColor: t.dark ? '#111111' : '#ffffff',
      pieLegendTextColor: t.text,
      pieStrokeColor: t.bg,
      pieOuterStrokeColor: t.line,
      quadrant1Fill: tint(p[3], 0.18), quadrant2Fill: tint(p[0], 0.18), quadrant3Fill: tint(p[1], 0.14), quadrant4Fill: tint(p[2], 0.18),
      quadrantPointFill: p[0],
      quadrantTitleFill: t.text, quadrantXAxisTextFill: t.text, quadrantYAxisTextFill: t.text,
      quadrant1TextFill: t.text, quadrant2TextFill: t.text, quadrant3TextFill: t.text, quadrant4TextFill: t.text,
      xyChart: { backgroundColor: t.bg, titleColor: t.text, xAxisLabelColor: t.text, xAxisTitleColor: t.text, xAxisTickColor: t.dim, xAxisLineColor: t.dim, yAxisLabelColor: t.text, yAxisTitleColor: t.text, yAxisTickColor: t.dim, yAxisLineColor: t.dim, plotColorPalette: p.join(', ') },
    },
    flowchart: { curve: 'basis', padding: 14, nodeSpacing: 46, rankSpacing: 52 },
    sequence: { mirrorActors: false, messageFontSize: 14 },
  }
}

/** Mermaid text to SVG. Throws with Mermaid's own message on a syntax error. */
export function renderMermaid(code: string, t: WidgetTheme): Promise<string> {
  mermaidMod = mermaidMod || import('mermaid').then((m) => m.default)
  const job = queue.then(async () => {
    const mermaid = await mermaidMod!
    mermaid.initialize(mermaidConfig(t))
    const id = `wmmd${Date.now().toString(36)}${seq++}`
    try {
      const { svg } = await mermaid.render(id, code.trim())
      return svg as string
    } finally {
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  })
  queue = job.catch(() => {})
  return job
}

/* ------------------------------------------------------------------ WaveDrom (drawn in the app) */

let wdMod: Promise<any> | null = null
let darkSkin: Promise<any> | null = null
let wdIndex = 0

function logicStyle(t: WidgetTheme) {
  const gate = mix(t.bg, t.palette[0], t.dark ? 0.3 : 0.16)
  return `<style>
.pinname,.wirename,.bodylabel{fill:${t.text};font-family:${t.mono};font-size:13px}
.wirename:hover{fill:${t.palette[0]}}
.gate,.dff{fill:${gate};stroke:${t.text};color:${t.text}}
.gate:hover{fill:${mix(t.bg, t.palette[2], 0.45)} !important}
.port{fill:${mix(t.bg, t.palette[3], t.dark ? 0.3 : 0.18)};stroke:${t.text};color:${t.text}}
.bind{fill:${mix(t.bg, t.palette[1], 0.25)};stroke:${t.text}}
.wire{stroke:${t.text}}
.grid{fill:none}
.siglabel{fill:${t.bg};stroke:${t.line}}
.slicelabel{fill:${t.text};stroke:${t.bg}}
</style>`
}

/** WaveDrom source (JSON5: keys may be unquoted) to SVG. */
export async function renderWaveDrom(code: string, t: WidgetTheme): Promise<string> {
  let src: any
  try {
    src = JSON5.parse(code)
  } catch (e) {
    throw new Error(`WaveDrom source is not valid JSON: ${(e as Error).message}`)
  }
  if (!src || typeof src !== 'object' || !(src.signal || src.assign || src.reg)) throw new Error('WaveDrom source needs a "signal", "assign" or "reg" key.')
  wdMod = wdMod || import('wavedrom').then((m: any) => m.default || m)
  const wd = await wdMod
  let skin = wd.waveSkin
  if (t.dark && src.signal) {
    darkSkin = darkSkin || import('wavedrom/skins/dark.js' as any).then((m: any) => m.default || m)
    skin = (await darkSkin)?.dark ? await darkSkin : skin
  }
  const index = wdIndex++
  let svg: string = wd.onml.stringify(wd.renderAny(index, src, skin))
  // Timing diagrams paint a white page behind themselves: let the cell show through.
  svg = svg.replace(/fill:\s*white(?=["; ])/g, 'fill:none')
  if (src.assign) svg = svg.replace(/<\/svg>\s*$/, `${logicStyle(t)}</svg>`)
  if (src.reg) svg = svg.replace(/(<svg[^>]*>)/, `$1<style>text{fill:${t.text}}rect,path,line{stroke:${t.text}}</style>`)
  // Its natural size is small: let it grow with the cell, up to about twice as big.
  const natural = Number(/<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"/.exec(svg)?.[1]) || 0
  if (natural && /<svg[^>]*\bviewBox=/.test(svg)) {
    const grow = src.assign ? 2.2 : 1.7
    svg = svg.replace(/<svg([^>]*)>/, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="100%" style="max-width:${Math.round(natural * grow)}px;height:auto">`)
  }
  return svg
}

/* ------------------------------------------------------------------ the document inside a block */

let chartJs: Promise<string> | null = null
let katexJs: Promise<string> | null = null
const loadChart = () => (chartJs = chartJs || import('vendor-chart-umd?raw' as any).then((m: any) => m.default as string))
const loadKatex = () => (katexJs = katexJs || import('vendor-katex-umd?raw' as any).then((m: any) => m.default as string))

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** Keeps a library's code from ending the <script> it sits in. */
const inlineScript = (code: string) => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`

export function looksLikeHtmlDocument(text: string): boolean {
  const t = text.trimStart().substring(0, 300).toLowerCase()
  return t.startsWith('<!doctype html') || t.startsWith('<html') || (t.includes('<head') && t.includes('<body'))
}

const errorBox = (what: string, msg: string) =>
  `<div class="w-error" data-w-error="${escHtml(`${what}: ${msg}`)}"><b>${escHtml(what)} could not be drawn</b><pre>${escHtml(msg)}</pre></div>`

/** Draws the Mermaid and WaveDrom parts of an HTML widget here, so the block gets plain SVG. */
async function prerenderHtml(src: string, t: WidgetTheme): Promise<string> {
  if (!/class\s*=\s*["'][^"']*\bmermaid\b|type\s*=\s*["']wavedrom/i.test(src)) return src
  const full = looksLikeHtmlDocument(src)
  const doc = new DOMParser().parseFromString(full ? src : `<!doctype html><html><head></head><body>${src}</body></html>`, 'text/html')
  for (const el of [...doc.querySelectorAll('.mermaid')]) {
    const code = el.textContent || ''
    const box = doc.createElement('div')
    box.className = 'w-diagram'
    try {
      box.innerHTML = await renderMermaid(code, t)
    } catch (e) {
      box.innerHTML = errorBox('Mermaid diagram', String((e as Error).message || e))
    }
    el.replaceWith(box)
  }
  for (const el of [...doc.querySelectorAll('script')].filter((s) => (s.getAttribute('type') || '').toLowerCase() === 'wavedrom')) {
    const box = doc.createElement('div')
    box.className = 'w-diagram'
    try {
      box.innerHTML = await renderWaveDrom(el.textContent || '', t)
    } catch (e) {
      box.innerHTML = errorBox('WaveDrom figure', String((e as Error).message || e))
    }
    el.replaceWith(box)
  }
  return full ? `<!doctype html>\n${doc.documentElement.outerHTML}` : doc.body.innerHTML
}

function baseStyle(t: WidgetTheme, opaque: boolean, full: boolean) {
  const vars = `:root{--bg:${t.bg};--fg:${t.text};--dim:${t.dim};--faint:${t.faint};--line:${t.line};--accent:${t.accent};${t.palette.map((c, i) => `--c${i + 1}:${c};`).join('')}--font:${t.font};--mono:${t.mono};--soft:${mix(t.bg, t.text, 0.05)};--soft2:${mix(t.bg, t.text, 0.1)};color-scheme:${t.dark ? 'dark' : 'light'}}`
  const always = `${opaque ? `html,body{background:${t.bg} !important}` : ''}.w-error{border:1px solid #e06c75;border-radius:8px;padding:8px 12px;margin:6px 0;color:#e06c75;font:13px/1.4 ${t.font}}.w-error pre{white-space:pre-wrap;margin:6px 0 0;font:12px/1.4 ${t.mono}}`
  if (full) return `<style>${vars}${always}</style>`
  return `<style>${vars}
html,body{margin:0;padding:0;background:transparent;color:var(--fg);font:15px/1.5 var(--font)}
body{padding:6px 4px;overflow:hidden}
*{box-sizing:border-box}
h1,h2,h3,h4{margin:.4em 0 .3em;line-height:1.25}
p{margin:.35em 0}
a{color:var(--accent)}
code,pre{font-family:var(--mono)}
svg{max-width:100%;height:auto}
.w-diagram{display:flex;justify-content:center;margin:4px 0}
.w-kmap-expr{text-align:center;font-size:17px;margin:2px 0 6px}
.w-diagram>svg{max-width:100%;height:auto}
.w-chart-box{position:relative;width:100%}
table{border-collapse:collapse;margin:6px 0}
th,td{border:1px solid var(--line);padding:4px 10px;text-align:center}
th{background:var(--soft)}
button{font:inherit;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:4px 12px;cursor:pointer}
button:hover{background:var(--soft2)}
button.on,button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:${t.dark ? '#10131a' : '#ffffff'}}
input,select,textarea{font:inherit;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:3px 8px}
input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--accent)}
.card{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.muted{color:var(--dim)}
.on-led{color:var(--c4)}.off-led{color:var(--faint)}
${always}</style>`
}

const MATH_RE = /\$\$|\\\(|\\\[|\$[^\s$][^$\n]*?\$/

/**
 * connect(from, to, options) for widgets: arrows between HTML elements, from
 * where they really are after layout (HTML has no connectors of its own).
 * from / to: an element or a CSS selector. Options:
 *   from, to   side to leave / enter: 'top' 'bottom' 'left' 'right' (default: facing sides)
 *   route      'straight' (default), 'elbow' (right angles), 'around-left' / 'around-right'
 *              (a skip connection that goes out to the side and back in)
 *   gap        how far an 'around' route stays out from the boxes, px (default 24)
 *   label      text at the middle; bus: '64' draws a slash with that width; dashed, dotted
 *   color      (default the theme's dim color); head: false for a plain line; both: true for two heads
 * Drawn on a layer over the page and redrawn whenever the layout changes.
 */
const WIRES = String.raw`(function () {
  var list = [], last = '';
  window.connect = function (a, b, o) { list.push({ a: a, b: b, o: o || {} }); if (window.__wires) requestAnimationFrame(window.__wires) };
  function el(x) { return typeof x === 'string' ? document.querySelector(x) : x }
  function box(e) { var r = e.getBoundingClientRect(); return { l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY, cx: (r.left + r.right) / 2 + scrollX, cy: (r.top + r.bottom) / 2 + scrollY } }
  function at(B, side) { return side === 'top' ? [B.cx, B.t] : side === 'bottom' ? [B.cx, B.b] : side === 'left' ? [B.l, B.cy] : [B.r, B.cy] }
  function facing(A, B) {
    if (B.b <= A.t) return ['top', 'bottom']; if (B.t >= A.b) return ['bottom', 'top'];
    return B.l >= A.r ? ['right', 'left'] : ['left', 'right'];
  }
  var NS = 'http://www.w3.org/2000/svg';
  function mk(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n }
  window.__wires = function () {
    var items = list.map(function (w) { var A = el(w.a), B = el(w.b); return A && B ? { w: w, A: box(A), B: box(B) } : null }).filter(Boolean);
    var sig = JSON.stringify(items.map(function (i) { return [i.A, i.B] }));
    if (sig === last && document.querySelector('svg.w-wires')) return; last = sig;
    var old = document.querySelector('svg.w-wires'); if (old) old.remove();
    if (!items.length) return;
    var svg = mk('svg', { class: 'w-wires', width: '1', height: '1', style: 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:5' });
    var T = window.__theme || {};
    items.forEach(function (it) {
      var o = it.w.o, A = it.A, B = it.B, f = facing(A, B), route = o.route || 'straight', gap = o.gap == null ? 24 : o.gap;
      var sa = o.from || (route === 'around-right' ? 'right' : route === 'around-left' ? 'left' : f[0]);
      var sb = o.to || (route === 'around-right' ? 'right' : route === 'around-left' ? 'left' : f[1]);
      var p = at(A, sa), q = at(B, sb), pts = [p];
      if (route === 'around-right' || route === 'around-left') {
        var x = route === 'around-right' ? Math.max(A.r, B.r) + gap : Math.min(A.l, B.l) - gap;
        var vert = sa === 'top' || sa === 'bottom';
        if (vert) pts.push([p[0], p[1] + (sa === 'top' ? -gap / 2 : gap / 2)], [x, p[1] + (sa === 'top' ? -gap / 2 : gap / 2)]); else pts.push([x, p[1]]);
        if (sb === 'top' || sb === 'bottom') pts.push([x, q[1] + (sb === 'top' ? -gap / 2 : gap / 2)], [q[0], q[1] + (sb === 'top' ? -gap / 2 : gap / 2)]); else pts.push([x, q[1]]);
      } else if (route === 'elbow') {
        var va = sa === 'top' || sa === 'bottom', vb = sb === 'top' || sb === 'bottom';
        if (va && vb) { var my = (p[1] + q[1]) / 2; pts.push([p[0], my], [q[0], my]) }
        else if (!va && !vb) { var mx = (p[0] + q[0]) / 2; pts.push([mx, p[1]], [mx, q[1]]) }
        else if (va) pts.push([p[0], q[1]]); else pts.push([q[0], p[1]]);
      }
      pts.push(q);
      var color = o.color || T.dim || '#999', d = 'M' + pts.map(function (s) { return s[0].toFixed(1) + ' ' + s[1].toFixed(1) }).join(' L');
      svg.appendChild(mk('path', { d: d, fill: 'none', stroke: color, 'stroke-width': o.width || 1.6, 'stroke-dasharray': o.dotted ? '2 4' : o.dashed ? '6 4' : '' }));
      function head(tip, from) {
        var dx = tip[0] - from[0], dy = tip[1] - from[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, s = 8;
        svg.appendChild(mk('polygon', { points: [tip, [tip[0] - ux * s - uy * s * 0.45, tip[1] - uy * s + ux * s * 0.45], [tip[0] - ux * s + uy * s * 0.45, tip[1] - uy * s - ux * s * 0.45]].map(function (v) { return v[0].toFixed(1) + ',' + v[1].toFixed(1) }).join(' '), fill: color }));
      }
      if (o.head !== false) head(q, pts[pts.length - 2]);
      if (o.both) head(p, pts[1]);
      // Middle of the longest segment carries the label and the bus mark.
      var k = 0, best = -1;
      for (var i = 0; i < pts.length - 1; i++) { var len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); if (len > best) { best = len; k = i } }
      var m = [(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2], horiz = Math.abs(pts[k + 1][0] - pts[k][0]) > Math.abs(pts[k + 1][1] - pts[k][1]);
      if (o.bus != null) svg.appendChild(mk('line', { x1: m[0] - 5, y1: m[1] + 5, x2: m[0] + 5, y2: m[1] - 5, stroke: color, 'stroke-width': 1.4 }));
      var text = o.label != null ? String(o.label) : o.bus != null ? String(o.bus) : '';
      if (text) {
        var t = mk('text', { x: horiz ? m[0] : m[0] + 9, y: horiz ? m[1] - 7 : m[1], 'text-anchor': horiz ? 'middle' : 'start', 'dominant-baseline': horiz ? 'auto' : 'central', fill: o.labelColor || T.text || 'currentColor', 'font-size': o.fontSize || 12, 'font-family': T.font || 'sans-serif' });
        t.textContent = text; svg.appendChild(t);
      }
    });
    document.body.appendChild(svg);
  };
  addEventListener('load', function () { window.__wires() });
  addEventListener('resize', function () { window.__wires() });
})();`

/** Runs in the block: charts, math, then reports size, errors and "done". */
const RUNTIME = String.raw`(async function () {
  var T = window.__theme, errs = window.__errors, id = window.name;
  function post(m) { try { m.__widget = id; parent.postMessage(m, '*') } catch (e) {} }
  document.querySelectorAll('[data-w-error]').forEach(function (e) { errs.push(e.getAttribute('data-w-error')) });
  document.querySelectorAll('script.w-chart').forEach(function (s) {
    try {
      var cfg = Function('"use strict";return (' + s.textContent + ')')();
      var box = document.createElement('div'); box.className = 'w-chart-box'; box.style.height = (cfg.height || 320) + 'px';
      var c = document.createElement('canvas'); box.appendChild(c); s.replaceWith(box);
      cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false }, cfg.options || {});
      var many = /^(pie|doughnut|polarArea)$/.test(cfg.type);
      ((cfg.data && cfg.data.datasets) || []).forEach(function (d, i) {
        var col = T.palette[i % T.palette.length];
        if (d.backgroundColor == null) d.backgroundColor = many ? T.palette : ((d.type || cfg.type) === 'line' || (d.type || cfg.type) === 'radar' ? col + '33' : col + 'cc');
        if (d.borderColor == null) d.borderColor = many ? T.bg : col;
      });
      new Chart(c, cfg);
    } catch (e) { errs.push('Chart: ' + e.message); var b = document.createElement('div'); b.className = 'w-error'; b.textContent = 'Chart could not be drawn: ' + e.message; s.replaceWith(b) }
  });
  if (window.katex) {
    var re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g;
    var skip = { SCRIPT: 1, STYLE: 1, PRE: 1, CODE: 1, TEXTAREA: 1, svg: 1, SVG: 1, MATH: 1, math: 1 };
    var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
      for (var p = n.parentNode; p && p !== document.body; p = p.parentNode) if (skip[p.nodeName]) return NodeFilter.FILTER_REJECT;
      return re.test(n.data) ? (re.lastIndex = 0, NodeFilter.FILTER_ACCEPT) : NodeFilter.FILTER_SKIP } });
    var nodes = []; while (walk.nextNode()) nodes.push(walk.currentNode);
    nodes.forEach(function (n) {
      var html = n.data.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      html = html.replace(re, function (m, a, b, c, d) {
        var tex = a || b || c || d, display = Boolean(a || b);
        try { return katex.renderToString(tex.replace(/&lt;/g, '<').replace(/&amp;/g, '&'), { displayMode: display, output: 'mathml', throwOnError: false }) } catch (e) { errs.push('Math: ' + e.message); return m }
      });
      var span = document.createElement('span'); span.innerHTML = html; n.replaceWith.apply(n, Array.prototype.slice.call(span.childNodes));
    });
  }
  try { if (document.fonts) await document.fonts.ready } catch (e) {}
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) });
  // Arrows made with connect(), now that the boxes are where they will stay.
  if (window.__wires) window.__wires();
  // Readable labels in every theme: a diagram's own fills (pastel boxes on a dark
  // page, dark boxes on a light one) can match the theme's text color, so each
  // label takes dark or light text from whatever is drawn under it.
  (function () {
    function lum(c) { var m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; var p = m[1].split(',').map(parseFloat); if (p.length > 3 && p[3] < 0.5) return null; return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255 }
    var page = lum(getComputedStyle(document.body).backgroundColor); if (page === null) page = T.dark ? 0.1 : 0.95;
    // The smallest filled shape of the same svg around the label's center (hit
    // testing would miss whatever lies below the frame's first screenful).
    function under(lab) {
      var r = lab.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return null;
      var x = r.left + r.width / 2, y = r.top + r.height / 2, svg = lab.ownerSVGElement || lab.closest('svg');
      while (svg && svg.parentNode && svg.parentNode.closest && svg.parentNode.closest('svg')) svg = svg.parentNode.closest('svg');
      var best = null, bestA = Infinity;
      [].slice.call(svg ? svg.querySelectorAll('rect, path, polygon, ellipse, circle') : []).forEach(function (el) {
        if (el.closest('defs, marker, clipPath, mask, pattern, text, foreignObject')) return;
        // A faint tint (a K-map loop's 8% fill) leaves the page showing through: it is not what the label sits on.
        var cs = getComputedStyle(el); if (+cs.fillOpacity * +cs.opacity < 0.5) return;
        var v = lum(cs.fill); if (v === null) return;
        var b = el.getBoundingClientRect(), a = b.width * b.height;
        if (x > b.left && x < b.right && y > b.top && y < b.bottom && a < bestA) { best = v; bestA = a }
      });
      if (best !== null) return best;
      for (var p = svg && svg.parentElement; p; p = p.parentElement) { var v = lum(getComputedStyle(p).backgroundColor); if (v !== null) return v }
      return page;
    }
    function fix(lab, prop, targets) {
      var bg = under(lab); if (bg === null) return;
      var fg = lum(getComputedStyle(lab)[prop]); if (fg === null || Math.abs(bg - fg) >= 0.4) return;
      var c = bg > 0.5 ? '#1e1e1e' : '#f2f2f2';
      targets.forEach(function (t) { t.style.setProperty(prop, c, 'important') });
    }
    document.querySelectorAll('.w-diagram svg text').forEach(function (tx) { fix(tx, 'fill', [tx].concat([].slice.call(tx.querySelectorAll('tspan')))) });
    document.querySelectorAll('.w-diagram svg foreignObject').forEach(function (fo) {
      var inner = [].slice.call(fo.querySelectorAll('*')).filter(function (e) { return (e.textContent || '').trim() });
      if (inner.length) fix(inner[inner.length - 1], 'color', inner);
    });
  })();
  // Measured problems in the drawings, for the agent's check (window.__lint()):
  // text on text, a line or shape running through text, parts cut off, tiny text.
  window.__lint = function () {
    var out = [], seen = {};
    function name(el) { var t = (el.textContent || '').trim().replace(/\s+/g, ' '); return t ? '"' + t.slice(0, 30) + '"' : '<' + el.nodeName.toLowerCase() + '>' }
    function add(k, msg) { if (!seen[k] && out.length < 20) { seen[k] = 1; out.push(msg) } }
    function area(a) { return Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top) }
    function inter(a, b) { var w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 0 && h > 0 ? w * h : 0 }
    function shown(el) { var cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0 }
    // Laid out by Mermaid or WaveDrom (not a K-map, which is checked fully): only some checks apply.
    function lib(el) { var d = el.closest('.w-diagram'); return Boolean(d) && !el.closest('.w-kmap, .w-own') }
    var texts = [].slice.call(document.querySelectorAll('svg text')).filter(function (el) { return shown(el) && (el.textContent || '').trim() }).slice(0, 200).map(function (el) { return { el: el, r: el.getBoundingClientRect() } });
    var i, j, k;
    for (i = 0; i < texts.length; i++) {
      var fs = parseFloat(getComputedStyle(texts[i].el).fontSize) || 0, sc = texts[i].el.getScreenCTM(), px = fs * (sc ? Math.abs(sc.a) : 1);
      if (/[\u0304\u0305\u0332\u0333]/.test(texts[i].el.textContent || '')) add('comb' + i, 'Text ' + name(texts[i].el) + ' uses a combining bar or underline character, which draws through or beside the letter: write <tspan text-decoration="overline">Z</tspan> for a bar over a letter (underline for a line under it).');
      if (px && px < 10) {
        if (lib(texts[i].el) || texts[i].el.closest('.w-tikz')) add('tinylib', 'Text such as ' + name(texts[i].el) + ' shows at only ' + px.toFixed(1) + 'px: the diagram is wider than the cell, so it is scaled down. Make the cell wider, use fewer columns or steps, or split it.');
        else add('tiny' + i, 'Text ' + name(texts[i].el) + ' is tiny (' + px.toFixed(1) + 'px); make it at least 12px.');
      }
      for (j = i + 1; j < texts.length; j++) {
        var a = texts[i].r, b = texts[j].r, o = inter(a, b);
        // TeX splits a word into pieces at kerns: neighbours on one baseline touch by a pixel or two.
        if (texts[i].el.closest('.w-tikz') && Math.abs(a.bottom - b.bottom) < 1.5 && Math.min(a.right, b.right) - Math.max(a.left, b.left) < 3) continue;
        if (o > 0.2 * Math.min(area(a), area(b))) add('tt' + i + '_' + j, 'Text ' + name(texts[i].el) + ' overlaps text ' + name(texts[j].el) + '.');
      }
    }
    // Inner part of each text box: a line through it crosses the letters.
    var cores = texts.map(function (t) { var r = t.r, w = r.right - r.left, h = r.bottom - r.top; return { left: r.left + w * 0.12, right: r.right - w * 0.12, top: r.top + h * 0.3, bottom: r.bottom - h * 0.22 } });
    var shapes = [].slice.call(document.querySelectorAll('svg path, svg line, svg polyline, svg polygon, svg rect, svg circle, svg ellipse')).filter(function (el) {
      // A library's lines often run behind filled boxes under their labels.
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol') || lib(el)) return false;
      var cs = getComputedStyle(el); return shown(el) && cs.stroke && cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0;
    }).slice(0, 400);
    shapes.forEach(function (el, si) {
      var len = 0; try { len = el.getTotalLength() } catch (e) {}
      var m = el.getScreenCTM(); if (!len || !m) return;
      // A clipped shape only shows inside its clip.
      var clip = null, cp = /url\(["']?#([^"')]+)/.exec(el.getAttribute('clip-path') || '');
      if (cp) { var ce = document.getElementById(cp[1]); clip = ce && ce.firstElementChild ? ce.firstElementChild.getBoundingClientRect() : null }
      var steps = Math.min(500, Math.ceil(len / 3));
      for (k = 0; k <= steps; k++) {
        var p = el.getPointAtLength(len * k / steps), x = m.a * p.x + m.c * p.y + m.e, y = m.b * p.x + m.d * p.y + m.f;
        if (clip && (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom)) continue;
        for (i = 0; i < cores.length; i++) {
          var c = cores[i];
          if (x > c.left && x < c.right && y > c.top && y < c.bottom) add('st' + si + '_' + i, 'A <' + el.nodeName.toLowerCase() + '> line runs through text ' + name(texts[i].el) + ': move the text or the line.');
        }
      }
    });
    // Cut off: drawn outside its svg's box or the page.
    var vw = document.documentElement.clientWidth;
    [].slice.call(document.querySelectorAll('svg')).forEach(function (svg) {
      if (svg.parentNode && svg.parentNode.closest && svg.parentNode.closest('svg')) return;
      // The connect() layer is a point the arrows draw out from.
      if (svg.classList.contains('w-wires')) return;
      // Laid out by Mermaid or WaveDrom: their edges are theirs, not something the source can fix.
      if (svg.closest('.w-diagram') && !svg.classList.contains('w-kmap') && !svg.closest('.w-own')) return;
      var sr = svg.getBoundingClientRect();
      [].slice.call(svg.querySelectorAll('text, path, line, polyline, polygon, rect, circle, ellipse')).forEach(function (el, ei) {
        if (el.closest('defs, clipPath, mask, marker, pattern, symbol') || el.hasAttribute('clip-path') || !shown(el)) return;
        var r = el.getBoundingClientRect(); if (r.width < 1 && r.height < 1) return;
        // Text and shapes count at once; a bare line or path only when well outside (diagram libraries let lines run to the edge).
        var tol = /^(line|path|polyline)$/i.test(el.nodeName) ? 8 : 2, sides = [];
        if (r.left < sr.left - tol) sides.push('left'); if (r.right > sr.right + tol) sides.push('right');
        if (r.top < sr.top - tol) sides.push('top'); if (r.bottom > sr.bottom + tol) sides.push('bottom');
        if (sides.length) add('cut' + ei, name(el) + ' is cut off at the ' + sides.join(' and ') + ' edge of its svg: enlarge the viewBox or move it in.');
        else if (r.right > vw + 2) add('page' + ei, name(el) + ' runs past the right edge of the block.');
      });
    });
    return out;
  };
  var last = -1, lastW = -1, lastCw = -1, Z = 1;
  // The real extent of what is drawn. Page boxes that stretch to the frame
  // (height:100%, 100vh, centering) would report the frame's own size, so
  // for the moment of measuring they go back to fitting their content.
  var mo = null;
  function measure() {
    var b = document.body, de = document.documentElement, vh = de.clientHeight;
    var undo = [];
    function set(el, prop, v) { undo.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]); el.style.setProperty(prop, v, 'important') }
    set(de, 'height', 'auto'); set(de, 'min-height', '0');
    set(b, 'height', 'auto'); set(b, 'min-height', '0');
    var all = b.getElementsByTagName('*'), i, el, cs, nm;
    for (i = 0; i < all.length && i < 6000; i++) {
      el = all[i]; nm = el.nodeName;
      if (nm === 'SCRIPT' || nm === 'STYLE') continue;
      cs = getComputedStyle(el);
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;
      if (Math.abs(parseFloat(cs.minHeight) - vh) < 2) set(el, 'min-height', '0');
      if (Math.abs(parseFloat(cs.height) - vh) < 2 && el.children.length && !/^(svg|canvas|img|video|iframe)$/i.test(nm)) set(el, 'height', 'auto');
    }
    var top = Infinity, left = Infinity, bottom = 0, right = 0, sx = window.scrollX, sy = window.scrollY;
    for (i = 0; i < all.length && i < 6000; i++) {
      el = all[i]; nm = el.nodeName;
      if (nm === 'SCRIPT' || nm === 'STYLE' || nm === 'LINK' || nm === 'META') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.position === 'fixed' || cs.visibility === 'hidden') continue;
      if (r.top + sy < top) top = r.top + sy;
      if (r.left + sx < left) left = r.left + sx;
      if (r.bottom + sy > bottom) bottom = r.bottom + sy;
      if (r.right + sx > right) right = r.right + sx;
    }
    var br = b.getBoundingClientRect(), bs = getComputedStyle(b);
    // Rects come back zoomed (see __zoom below), styles and scrollWidth do not: count all of it zoomed.
    var bodyBottom = br.bottom + sy + (parseFloat(bs.marginBottom) || 0) * Z;
    var bodyRight = br.right + sx + (parseFloat(bs.marginRight) || 0) * Z;
    var h, w;
    if (top === Infinity) { h = bodyBottom; w = de.scrollWidth * Z }
    else {
      // Content pushed above or left of the frame (centered and overflowing) still counts.
      h = Math.max(bottom, bodyBottom) - Math.min(0, top);
      w = Math.max(right, Math.min(bodyRight, right + 40)) - Math.min(0, left);
    }
    // How wide the content is when nothing stretches it (0: it fills whatever
    // room it gets: a percentage width, a chart, an svg without a size).
    var cw = 0, flexible = false;
    for (i = 0; i < all.length && i < 6000 && !flexible; i++) {
      el = all[i]; nm = el.nodeName;
      if (nm === 'SCRIPT' || nm === 'STYLE') continue;
      if (/^(canvas|iframe|video)$/i.test(nm)) { flexible = true; break }
      try {
        var sm = el.computedStyleMap(), sw = sm.get('width'), mx = sm.get('max-width');
        if (sw && sw.unit === 'percent' && !(mx && mx.unit === 'px')) flexible = true;
        else if (nm.toLowerCase() === 'svg' && !el.getAttribute('width') && String(sw) === 'auto') flexible = true;
      } catch (e) { flexible = true }
    }
    if (!flexible) {
      set(de, 'width', 'max-content'); set(b, 'width', 'max-content');
      var mr = b.getBoundingClientRect();
      cw = mr.width + ((parseFloat(bs.marginLeft) || 0) + (parseFloat(bs.marginRight) || 0)) * Z;
    }
    for (i = undo.length - 1; i >= 0; i--) { var u = undo[i]; if (u[2]) u[0].style.setProperty(u[1], u[2], u[3]); else u[0].style.removeProperty(u[1]) }
    // The style changes above were only for measuring: not news.
    if (mo) mo.takeRecords();
    // Reported at the content's own size, whatever it is zoomed to.
    return { h: Math.ceil(h / Z), w: Math.ceil(w / Z), cw: Math.ceil(cw / Z) };
  }
  var pending = 0;
  function send() {
    pending = 0;
    // The layout moved: arrows follow (a no-op when nothing they join moved).
    if (window.__wires) window.__wires();
    var m = measure(), h = Math.max(20, m.h), w = m.w;
    window.__widget = { done: true, h: h, w: w, cw: m.cw, errors: errs.slice() };
    if (Math.abs(h - last) > 2 || Math.abs(w - lastW) > 2 || Math.abs(m.cw - lastCw) > 2) { last = h; lastW = w; lastCw = m.cw; post({ type: 'size', h: h, w: w, cw: m.cw, vw: Math.round(document.documentElement.getBoundingClientRect().width / Z) }) }
  }
  function soon() { if (!pending) pending = requestAnimationFrame(send) }
  send();
  post({ type: 'done', errors: errs.slice() });
  try { var ro = new ResizeObserver(soon); ro.observe(document.body); ro.observe(document.documentElement); for (var k = 0; k < document.body.children.length; k++) ro.observe(document.body.children[k]) } catch (e) {}
  try { mo = new MutationObserver(soon); mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true }) } catch (e) {}
  addEventListener('load', soon);
  addEventListener('message', function (e) { if (e.data && e.data.__measure) { last = -1; send() } });
  // A figure shown smaller than its own size is zoomed here rather than scaled
  // by the page around it, so its text is drawn at the size it shows, sharp.
  addEventListener('message', function (e) {
    var z = e.data && e.data.__zoom;
    if (typeof z !== 'number' || !(z > 0) || Math.abs(z - Z) < 0.001) return;
    Z = z; document.documentElement.style.zoom = z === 1 ? '' : String(z); soon();
  });
  [150, 450, 1000, 2500].forEach(function (t) { setTimeout(send, t) });
})();`

export interface BuildOptions {
  /** Paint the theme background (for pictures of the block). */
  opaque?: boolean
}

/** The full HTML document a block shows in its sandbox. */
export async function buildWidgetDoc(kind: WidgetKind, src: string, t: WidgetTheme, opts: BuildOptions = {}): Promise<string> {
  let body: string
  if (kind === 'mermaid') {
    try {
      body = `<div class="w-diagram">${await renderMermaid(src, t)}</div>`
    } catch (e) {
      body = errorBox('Mermaid diagram', String((e as Error).message || e))
    }
  } else if (kind === 'wavedrom') {
    try {
      body = `<div class="w-diagram">${await renderWaveDrom(src, t)}</div>`
    } catch (e) {
      body = errorBox('WaveDrom figure', String((e as Error).message || e))
    }
  } else if (kind === 'kmap') {
    try {
      const tex = kmapExpressionTex(src)
      body = `<div class="w-diagram">${renderKmap(src, { text: t.text, dim: t.dim, line: t.line, font: t.font, palette: t.palette })}</div>` + (tex ? `<div class="w-kmap-expr">$${tex}$</div>` : '')
    } catch (e) {
      body = errorBox('K-map', String((e as Error).message || e))
    }
  } else if (MAIN_KINDS.has(kind)) {
    const theme = { dark: t.dark, bg: t.bg, text: t.text, dim: t.dim, line: t.line, font: t.font, palette: t.palette }
    const desk = (window as any).notes
    const r: { ok: boolean; svg?: string; error?: string } = desk?.diagram
      ? await desk.diagram.render(kind, src, theme).catch((e: any) => ({ ok: false, error: String(e?.message || e) }))
      : { ok: false, error: 'Only the desktop app can draw this.' }
    // A TikZ picture is placed by its author, so it gets every layout check (like a K-map),
    // and it is drawn as on paper, on a white card.
    body = r.ok
      ? kind === 'tikz'
        ? `<div class="w-diagram w-own w-tikz"><div style="background:#fff;border-radius:8px;padding:14px;max-width:100%">${r.svg}</div></div>`
        : `<div class="w-diagram">${r.svg}</div>`
      : errorBox(KIND_LABEL[kind], r.error || 'unknown error')
  } else if (kind === 'chart') {
    body = `<script type="application/json" class="w-chart">${src.replace(/<\/script/gi, '<\\/script')}</script>`
  } else {
    body = await prerenderHtml(src, t)
  }

  const full = kind === 'html' && looksLikeHtmlDocument(body)
  const needChart = kind === 'chart' || /\bnew\s+Chart\s*\(|\bChart\./.test(body)
  const needMath = MATH_RE.test(kind === 'html' || kind === 'kmap' ? body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '') : '')
  const needWires = kind === 'html' && /\bconnect\s*\(/.test(body)
  const libs = [needChart ? inlineScript(await loadChart()) : '', needMath ? inlineScript(await loadKatex()) : '', needWires ? inlineScript(WIRES) : ''].join('')
  const theme = { dark: t.dark, bg: t.bg, text: t.text, dim: t.dim, line: t.line, accent: t.accent, palette: t.palette, font: t.font }
  const setup = inlineScript(
    `window.__theme=${JSON.stringify(theme)};window.__errors=[];` +
      `addEventListener('error',function(e){window.__errors.push(String(e.message||e))});` +
      `addEventListener('unhandledrejection',function(e){window.__errors.push(String((e.reason&&e.reason.message)||e.reason))});`,
  )
  const chartDefaults = needChart
    ? inlineScript(
        `if(window.Chart){var d=Chart.defaults;d.color=${JSON.stringify(t.dim)};d.borderColor=${JSON.stringify(mix(t.bg, t.text, 0.12))};d.font.family=${JSON.stringify(t.font)};d.font.size=13;d.maintainAspectRatio=false;d.plugins.legend.labels.color=${JSON.stringify(t.text)};d.plugins.title.color=${JSON.stringify(t.text)};${opts.opaque ? 'd.animation=false;' : ''}}`,
      )
    : ''
  const head = `<meta charset="utf-8"><meta name="color-scheme" content="${t.dark ? 'dark' : 'light'}">${baseStyle(t, Boolean(opts.opaque), full)}${setup}${libs}${chartDefaults}`
  const runtime = inlineScript(RUNTIME)

  if (full) {
    let doc = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + head) : body.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`)
    doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${runtime}</body>`) : doc + runtime
    return doc
  }
  return `<!doctype html><html><head>${head}</head><body>${body}${runtime}</body></html>`
}
