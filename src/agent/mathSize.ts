/**
 * Math size, as the assistant sees and sets it. Every formula keeps a scale
 * (data-scale on its element; 1 = normal, where KaTeX draws at 1.05x the text
 * it sits in). This measures how big each formula really renders on the
 * canvas and changes the scale of one formula, some, or all math on a page in
 * a single call, reporting the measured size before and after.
 */
import { useStore } from '../store'
import type { Cell, Page } from '../types'

export const MIN_SCALE = 0.5
export const MAX_SCALE = 4
/** KaTeX's own size against the surrounding text (the `.katex { font-size: 1.05em }` rule). */
const KATEX_EM = 1.05
/** One "bigger" or "smaller" step. */
const STEP = 1.2

export interface MathInfo {
  /** 1-based, in reading order within the cell. */
  n: number
  display: boolean
  latex: string
  scale: number
  /** KaTeX font size in page px (what scale multiplies). */
  fontPx: number
  /** Font size the formula inherits (its em base), in page px. */
  emPx: number
  /** Body text size of the line or block around it, in page px. */
  textPx: number
  /** Drawn box in page px, when the page is open. */
  w?: number
  h?: number
  /** Width available to it in the cell, in page px. */
  room?: number
  onScreen?: boolean
  /** True when measured on the canvas, false when estimated from settings. */
  measured: boolean
}

const clampScale = (s: number) => Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)) * 100) / 100

export const scaleOf = (el: Element) => {
  const s = parseFloat(el.getAttribute('data-scale') || '')
  return s > 0 ? s : 1
}

/** Sets (or clears, at 1) a formula element's scale: the attribute the editor reads and the CSS variable that draws it. */
export function setScaleAttr(el: HTMLElement, scale: number) {
  if (Math.abs(scale - 1) < 0.005) {
    el.removeAttribute('data-scale')
    el.style.removeProperty('--math-scale')
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style')
  } else {
    el.setAttribute('data-scale', String(scale))
    el.style.setProperty('--math-scale', String(scale))
  }
}

function parse(html: string) {
  return new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html').body
}

const short = (tex: string, n = 48) => {
  const t = tex.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}...` : t
}

function cellNode(cellId: string): HTMLElement | null {
  return document.querySelector(`.canvas-wrap [data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null
}

/** Every formula of a cell with its scale and size: measured on the canvas when the page is open, estimated otherwise. */
export function measureMath(cellId: string, html: string): MathInfo[] {
  const stored = [...parse(html).querySelectorAll('[data-latex]')].map((el) => ({
    display: el.tagName === 'DIV',
    latex: el.getAttribute('data-latex') || '',
    scale: scaleOf(el),
  }))
  if (!stored.length) return []
  const st = useStore.getState()
  const zoom = st.zoom || 1
  const base = st.settings.bodySize || 15
  const el = st.page?.cells.some((c) => c.id === cellId) ? cellNode(cellId) : null
  const nodes = el ? [...el.querySelectorAll('.ProseMirror .math-inline, .ProseMirror .math-block')] as HTMLElement[] : []
  const wrap = document.querySelector('.canvas-wrap')?.getBoundingClientRect()
  // Only trust the canvas when it shows the same formulas as the stored content.
  const live = nodes.length === stored.length
  return stored.map((m, i) => {
    const node = live ? nodes[i] : undefined
    const k = node?.querySelector('.katex') as HTMLElement | null
    if (!node || !k) {
      return { n: i + 1, ...m, emPx: base, textPx: base, fontPx: round(base * KATEX_EM * m.scale), measured: false }
    }
    const emPx = parseFloat(getComputedStyle(node).fontSize) || base
    const block = (node.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote') || node.closest('.ProseMirror') || node) as HTMLElement
    const textPx = m.display ? parseFloat(getComputedStyle(node.closest('.ProseMirror') || node).fontSize) || base : parseFloat(getComputedStyle(block).fontSize) || base
    const r = ((k.querySelector('.katex-html') as HTMLElement | null) || k).getBoundingClientRect()
    const host = (m.display ? node : block).getBoundingClientRect()
    return {
      n: i + 1,
      ...m,
      fontPx: round(parseFloat(getComputedStyle(k).fontSize) || emPx * KATEX_EM * m.scale),
      emPx: round(emPx),
      textPx: round(textPx),
      w: Math.round(r.width / zoom),
      h: Math.round(r.height / zoom),
      room: Math.round(host.width / zoom),
      onScreen: wrap ? r.bottom > wrap.top && r.top < wrap.bottom && r.right > wrap.left && r.left < wrap.right : undefined,
      measured: true,
    }
  })
}

const round = (v: number) => Math.round(v * 10) / 10

function describe(m: MathInfo, zoom: number) {
  const ratio = round(m.fontPx / m.textPx)
  const parts = [`#${m.n} ${m.display ? 'display' : 'inline'} "${short(m.latex)}"`, `scale ${m.scale}`, `font ${m.fontPx}px = ${ratio}x the ${m.textPx}px text`]
  if (m.measured && m.w !== undefined) {
    parts.push(`box ${m.w}x${m.h}px`)
    if (m.room && m.w > m.room + 2) parts.push(`TOO WIDE for the cell (${m.room}px room), it scrolls sideways`)
    parts.push(`on screen ${round(m.fontPx * zoom)}px at ${Math.round(zoom * 100)}% zoom${m.onScreen === false ? ' (scrolled off)' : ''}`)
  } else parts.push('estimated (page not drawn)')
  return parts.join(', ')
}

/** One block for read_cell, read_page and the context: each formula's size and how it compares to the text. */
export function mathReport(cellId: string, html: string, max = 30): string {
  if (!html || !html.includes('data-latex')) return ''
  const list = measureMath(cellId, html)
  if (!list.length) return ''
  const zoom = useStore.getState().zoom || 1
  const lines = list.slice(0, max).map((m) => `  ${describe(m, zoom)}`)
  if (list.length > max) lines.push(`  ...and ${list.length - max} more`)
  return `Math sizes in [${cellId}] (set them with set_math_size; scale 1 = normal):\n${lines.join('\n')}`
}

/**
 * A rewrite of a cell that copies a formula but leaves out its {scale=...}
 * would shrink it back to normal: the same LaTeX gets its old size again.
 */
export function keepMathScales(oldHtml: string, newHtml: string): string {
  if (!oldHtml.includes('data-scale') || !newHtml.includes('data-latex')) return newHtml
  const was = new Map<string, number>()
  parse(oldHtml).querySelectorAll('[data-latex][data-scale]').forEach((el) => was.set(`${el.tagName}|${el.getAttribute('data-latex')}`, scaleOf(el)))
  const body = parse(newHtml)
  let changed = false
  body.querySelectorAll('[data-latex]:not([data-scale])').forEach((el) => {
    const s = was.get(`${el.tagName}|${el.getAttribute('data-latex')}`)
    if (s) {
      setScaleAttr(el as HTMLElement, s)
      changed = true
    }
  })
  return changed ? body.innerHTML : newHtml
}

export interface MathSizeDeps {
  pageIdOr(id?: string): string
  pageOfCell(cellId: string, pageId?: string): Promise<string>
  loadPage(id: string): Promise<Page>
  findCell(page: Page, id: string): Cell
  edit(pageId: string, fn: (p: Page) => Page, cells: string[]): Promise<unknown>
}

type Args = Record<string, any>

export const SET_MATH_SIZE_DEF = {
  type: 'function',
  function: {
    name: 'set_math_size',
    description:
      'Make LaTeX formulas bigger or smaller (their rendered size), for one formula, several, all math in a cell, or all math on a page, in ONE call. ' +
      'Never resize math with \\large, \\Large, \\huge or font-size spans: use this. Give exactly one of scale, relative_to_text, px, factor or change. ' +
      'The result reports each formula\'s measured size before and after, so you know exactly what changed.',
    parameters: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Page id. Omit for the open page.' },
        cell_ids: { type: 'array', items: { type: 'string' }, description: 'Cells whose math to resize. Omit for every cell with math on the page.' },
        formulas: { type: 'array', items: { type: 'number' }, description: 'Only these formulas, by their 1-based # in the cell (as listed under "Math sizes"). Needs exactly one cell in cell_ids.' },
        match: { type: 'string', description: 'Only formulas whose LaTeX contains this text (e.g. "\\tanh").' },
        kind: { type: 'string', enum: ['all', 'display', 'inline'], description: 'display = formulas on their own line ($$...$$), inline = inside a sentence ($...$). Default all.' },
        scale: { type: 'number', description: `Absolute scale: 1 = normal, 1.5 = half again as big, 2 = double. ${MIN_SCALE} to ${MAX_SCALE}.` },
        relative_to_text: { type: 'number', description: 'Math font as a multiple of the text around it, e.g. 1.6 = 60% larger than the text.' },
        px: { type: 'number', description: 'Math font size in page px (the text is usually 14 to 16px).' },
        factor: { type: 'number', description: 'Multiply each formula\'s current size, e.g. 1.25 or 0.8. Keeps the formulas\' sizes relative to each other.' },
        change: { type: 'string', enum: ['bigger', 'smaller', 'reset'], description: 'One step (20%) bigger or smaller per `steps`; reset = normal size.' },
        steps: { type: 'number', description: 'With change: how many steps, default 1. "Much bigger" is 2 or 3.' },
      },
    },
  },
}

/** The new scale for one formula, from whichever size argument was given. */
function targetScale(a: Args, m: MathInfo): number {
  if (a.scale !== undefined) return Number(a.scale)
  if (a.relative_to_text !== undefined) return (Number(a.relative_to_text) * m.textPx) / (m.emPx * KATEX_EM)
  if (a.px !== undefined) return Number(a.px) / (m.emPx * KATEX_EM)
  if (a.factor !== undefined) return m.scale * Number(a.factor)
  const steps = Math.max(1, Math.min(8, Math.round(Number(a.steps) || 1)))
  if (a.change === 'bigger') return m.scale * STEP ** steps
  if (a.change === 'smaller') return m.scale / STEP ** steps
  return 1
}

const nextFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))

export async function setMathSize(a: Args, d: MathSizeDeps) {
  const given = ['scale', 'relative_to_text', 'px', 'factor', 'change'].filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== '')
  if (given.length !== 1) throw new Error(`Give exactly one of scale, relative_to_text, px, factor or change (got ${given.join(', ') || 'none'}).`)
  const key = given[0]
  if (key !== 'change' && !(Number(a[key]) > 0)) throw new Error(`${key} must be a positive number.`)
  if (key === 'change' && !['bigger', 'smaller', 'reset'].includes(a.change)) throw new Error('change must be bigger, smaller or reset.')

  const ids: string[] = Array.isArray(a.cell_ids) ? a.cell_ids.map((x: unknown) => String(x).replace(/^\[|\]$/g, '')).filter(Boolean) : []
  const pid = ids.length ? await d.pageOfCell(ids[0], a.page_id) : d.pageIdOr(a.page_id)
  const page = await d.loadPage(pid)
  const cells = ids.length ? ids.map((id) => d.findCell(page, id)) : page.cells.filter((c) => c.html?.includes('data-latex'))
  if (!cells.length) throw new Error('No math on that page.')
  const picks = Array.isArray(a.formulas) ? a.formulas.map(Number).filter((n: number) => n > 0) : []
  if (picks.length && cells.length !== 1) throw new Error('formulas needs exactly one cell in cell_ids.')
  const kind = a.kind === 'display' || a.kind === 'inline' ? a.kind : 'all'
  const match = typeof a.match === 'string' ? a.match.trim() : ''

  // Work out every formula's new scale from its measured size.
  const plan = new Map<string, { before: MathInfo[]; scales: Map<number, number>; html: string }>()
  for (const c of cells) {
    const before = measureMath(c.id, c.html)
    const scales = new Map<number, number>()
    for (const m of before) {
      if (picks.length && !picks.includes(m.n)) continue
      if (kind !== 'all' && (kind === 'display') !== m.display) continue
      if (match && !m.latex.includes(match)) continue
      scales.set(m.n, clampScale(targetScale(a, m)))
    }
    if (!scales.size) continue
    const body = parse(c.html)
    ;[...body.querySelectorAll('[data-latex]')].forEach((el, i) => {
      const s = scales.get(i + 1)
      if (s !== undefined) setScaleAttr(el as HTMLElement, s)
    })
    plan.set(c.id, { before, scales, html: body.innerHTML })
  }
  if (!plan.size) {
    const seen = cells.map((c) => mathReport(c.id, c.html, 12)).filter(Boolean).join('\n')
    throw new Error(`No formula matched (kind ${kind}${match ? `, match "${match}"` : ''}${picks.length ? `, formulas ${picks.join(',')}` : ''}). What is there:\n${seen || 'no math'}`)
  }

  await d.edit(pid, (p) => ({ ...p, cells: p.cells.map((c) => (plan.has(c.id) ? { ...c, html: plan.get(c.id)!.html } : c)) }), [...plan.keys()])
  const open = useStore.getState().page?.id === pid
  if (open) await nextFrames()

  // Measure again, now that the canvas has drawn the new sizes.
  const zoom = useStore.getState().zoom || 1
  const now = open ? useStore.getState().page! : await d.loadPage(pid)
  const out: string[] = []
  let changed = 0
  let clamped = 0
  let firstBefore = 0
  let firstAfter = 0
  for (const [id, { before, scales }] of plan) {
    const c = now.cells.find((x) => x.id === id)
    const after = c ? measureMath(id, c.html) : []
    out.push(`Cell [${id}]:`)
    for (const m of before) {
      const s = scales.get(m.n)
      if (s === undefined) continue
      const b = m
      const n = after[m.n - 1]
      if (!firstBefore) {
        firstBefore = b.fontPx
        firstAfter = n?.fontPx ?? b.fontPx
      }
      if (s !== b.scale) changed++
      if (s === MIN_SCALE || s === MAX_SCALE) clamped++
      const box = b.w !== undefined && n?.w !== undefined ? `, box ${b.w}x${b.h} -> ${n.w}x${n.h}px` : ''
      const wide = n?.room && n.w !== undefined && n.w > n.room + 2 ? `, NOW TOO WIDE for the cell (${n.room}px room): it scrolls sideways` : ''
      out.push(
        `  #${m.n} ${m.display ? 'display' : 'inline'} "${short(m.latex)}": scale ${b.scale} -> ${s}, font ${b.fontPx} -> ${n?.fontPx ?? '?'}px (${round(b.fontPx / b.textPx)}x -> ${n ? round(n.fontPx / n.textPx) : '?'}x the ${b.textPx}px text)${box}${wide}${n?.measured === false ? ' (estimated, page not drawn)' : ''}`,
      )
    }
  }
  if (clamped) out.push(`${clamped} formula(s) hit the size limit (scale ${MIN_SCALE} to ${MAX_SCALE}).`)
  if (!changed) out.push('Nothing changed: those formulas already had that size.')
  if (open) out.push(`Zoom is ${Math.round(zoom * 100)}%, so on screen sizes are the page px times ${round(zoom)}.`)
  const total = [...plan.values()].reduce((n, p) => n + p.scales.size, 0)
  const verb = key === 'change' ? (a.change === 'reset' ? 'Reset' : a.change === 'bigger' ? 'Enlarged' : 'Shrank') : 'Resized'
  return {
    content: out.join('\n'),
    summary: `${verb} ${total} ${total === 1 ? 'formula' : 'formulas'}`,
    detail: `${firstBefore}px -> ${firstAfter}px math font${total > 1 ? ' (first one)' : ''}`,
    ok: true,
    target: { pageId: pid, cellId: [...plan.keys()][0] },
  }
}
