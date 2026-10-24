/**
 * Diagram engines that run in Node, here in the main process:
 *  - graphviz  DOT source, laid out by Graphviz (WebAssembly)
 *  - tikz      a TikZ picture, typeset by TeX (TikZJax's WebAssembly build)
 * Each returns finished SVG, themed to the colors the page sends.
 * The libraries are loaded on first use and stay loaded.
 */
import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(__filename)

export interface DiagramTheme {
  dark: boolean
  bg: string
  text: string
  dim: string
  line: string
  font: string
  palette: string[]
}

/* ------------------------------------------------------------------ Graphviz */

let gvMod: Promise<any> | null = null

/** Theme defaults go first in the graph, so the source's own attributes win. */
function graphvizDefaults(t: DiagramTheme) {
  const font = 'Segoe UI'
  return `graph [bgcolor="transparent", fontname="${font}", fontcolor="${t.text}", color="${t.dim}"]; node [fontname="${font}", fontsize=13, color="${t.text}", fontcolor="${t.text}"]; edge [fontname="${font}", fontsize=12, color="${t.dim}", fontcolor="${t.text}"];`
}

async function renderGraphviz(src: string, t: DiagramTheme): Promise<string> {
  gvMod = gvMod || import('@hpcc-js/wasm-graphviz').then((m: any) => m.Graphviz.load())
  const gv = await gvMod
  const at = src.indexOf('{')
  if (at < 0 || !/^\s*(strict\s+)?(di)?graph\b/i.test(src)) throw new Error('Graphviz source must start with "digraph {" or "graph {".')
  const themed = `${src.slice(0, at + 1)} ${graphvizDefaults(t)} ${src.slice(at + 1)}`
  const svg: string = gv.layout(themed, 'svg', 'dot')
  // Drop the XML prolog and the comment Graphviz writes before <svg>.
  return svg.slice(svg.indexOf('<svg'))
}

/* ------------------------------------------------------------------ TikZ */

let tikzMod: Promise<any> | null = null
/** TeX runs one picture at a time. */
let tikzQueue: Promise<unknown> = Promise.resolve()
const fontCache = new Map<string, string>()

/** The Computer Modern fonts the picture uses, inlined so it works offline. */
function tikzFonts(svg: string): string {
  const dir = path.join(path.dirname(require.resolve('node-tikzjax/package.json')), 'css', 'bakoma', 'ttf')
  const used = new Set([...svg.matchAll(/font-family="([\w-]+)"/g)].map((m) => m[1]))
  let css = ''
  for (const f of used) {
    if (!fontCache.has(f)) {
      try {
        fontCache.set(f, fs.readFileSync(path.join(dir, `${f}.ttf`)).toString('base64'))
      } catch {
        fontCache.set(f, '')
      }
    }
    const b64 = fontCache.get(f)
    if (b64) css += `@font-face{font-family:${f};src:url(data:font/ttf;base64,${b64})}`
  }
  return css
}

export const TIKZ_LIBRARIES = 'arrows.meta,positioning,calc,fit,backgrounds,shapes.geometric,shapes.misc,shapes.multipart,decorations.pathreplacing,decorations.markings,shadows,matrix,chains,patterns,automata,quotes'

/**
 * TeX's own words for what went wrong, from its terminal output: the "!" error,
 * its context, and the line of the source it stopped at (counted in the source
 * as written, not the preamble around it).
 */
function texErrors(out: string[], body: string): string {
  const input = out.find((l) => l.includes('\\begin{document}') && l.includes(body.slice(0, 40))) || ''
  const offset = input ? (input.slice(0, input.lastIndexOf(body)).match(/\n/g) || []).length : 0
  const own = body.split('\n')
  const lines = out.join('\n').split('\n')
  const found: string[] = []
  for (let i = 0; i < lines.length && found.length < 3; i++) {
    if (!lines[i].startsWith('!') || /^!\s*(Emergency stop|==> Fatal error)/.test(lines[i])) continue
    let msg = lines[i].replace(/^!\s*/, '').trim()
    // TeX wraps long messages: the next line goes on until a blank, a help hint or the context.
    const next = lines[i + 1] || ''
    // (TeX breaks lines at 79 characters, even inside a word.)
    if (next.trim() && !/^(l\.\d|See |Type |<|\(|\.)/.test(next)) msg += (lines[i].length >= 79 ? '' : ' ') + next.trim()
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const m = /^l\.(\d+)\s?(.*)$/.exec(lines[j])
      if (m) {
        const n = Number(m[1]) - offset
        const text = own[n - 1]
        msg += n > 0 && text != null ? ` (source line ${n}: ${text.trim().slice(0, 140)})` : ` (near: ${m[2].trim().slice(0, 120)})`
        break
      }
    }
    if (!found.includes(msg)) found.push(msg)
  }
  return found.join(' | ')
}

async function renderTikz(src: string, _t: DiagramTheme): Promise<string> {
  tikzMod = tikzMod || import('node-tikzjax').then((m: any) => m.default?.default || m.default)
  const tex2svg = await tikzMod
  let body = src.trim()
  // A bare picture is wrapped in a document; a full one is used as written.
  const bare = !/\\begin\{document\}/.test(body)
  if (bare) body = `\\begin{document}\n${body}\n\\end{document}`
  const job = tikzQueue.then(async () => {
    // TeX reports to the console: catch it for the error message.
    const out: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '))
    try {
      const svg: string = await tex2svg(body, { tikzLibraries: TIKZ_LIBRARIES, texPackages: { amsmath: '', amssymb: '' }, showConsole: true })
      return { svg, errors: texErrors(out, body) }
    } catch (e: any) {
      return { svg: '', errors: texErrors(out, body) || String(e?.message || e) }
    } finally {
      console.log = log
    }
  })
  tikzQueue = job.catch(() => {})
  const res = await job
  // Line numbers count from the picture as written.
  const errors = bare ? res.errors.replace(/source line (\d+)/g, (_m, n) => `source line ${Number(n) - 1}`) : res.errors
  if (errors) throw new Error(`TeX error: ${errors}`)
  let svg = res.svg
  if (!/<(path|text|rect|circle|use)\b/.test(svg)) throw new Error('TikZ produced an empty picture. Check that the drawing commands are inside \\begin{tikzpicture} ... \\end{tikzpicture} and each ends with ";".')
  // Drawn as on paper (black on white, the page shows it on a white card), so
  // its own colors and light fills read the same in every theme.
  const css = tikzFonts(svg)
  // TeX sizes are in points: draw it at 1.5x so text is about 15px like the app's.
  svg = svg.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    const w = Number(/\swidth="([\d.]+)"/.exec(attrs)?.[1]) || 0
    const h = Number(/\sheight="([\d.]+)"/.exec(attrs)?.[1]) || 0
    const rest = attrs.replace(/\s(width|height)="[^"]*"/g, '')
    return `<svg${rest} width="${(w * 1.5).toFixed(1)}" height="${(h * 1.5).toFixed(1)}"><style>${css}</style>`
  })
  return svg
}

/* ------------------------------------------------------------------ IPC */

const RENDER: Record<string, (src: string, t: DiagramTheme) => Promise<string>> = { graphviz: renderGraphviz, tikz: renderTikz }

export function setupDiagrams() {
  ipcMain.handle('diagram:render', async (_e, kind: string, src: string, theme: DiagramTheme) => {
    const fn = RENDER[kind]
    if (!fn) return { ok: false, error: `Unknown diagram kind "${kind}".` }
    try {
      return { ok: true, svg: await fn(String(src || ''), theme) }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 2000) }
    }
  })
}
