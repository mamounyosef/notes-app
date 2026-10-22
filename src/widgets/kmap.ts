/**
 * Karnaugh maps as a drawing kind (```kmap): the agent writes what the map
 * holds (variables, ones, don't cares, groups) and this lays it out the way
 * a textbook or a lecture board does: Gray coded rows and columns, the
 * variable braces around the grid (X̄ X, Ȳ Y, Z̄ Z Z̄), and a loop for each
 * group, wrapping around the edges when the group does. Groups can be worked
 * out here ("auto", a minimal sum of products), so they are always right.
 */
import JSON5 from 'json5'

export interface KmapSpec {
  /** 2 to 4 variable names, most significant first. Rows take the first half. */
  vars: string[]
  /** Minterms that are 1. */
  ones?: number[]
  /** Don't cares, shown as X. */
  dc?: number[]
  /** Cells of each group (minterm numbers), or "auto" for a minimal sum of products. */
  groups?: number[][] | 'auto'
  /** Around the grid: variable braces, Gray codes, or both. Default both. */
  labels?: 'both' | 'bars' | 'codes'
  /** Show the 0 cells as 0 (default) or leave them empty. */
  zeros?: boolean
  /** The function's name for the expression line, e.g. "F". */
  name?: string
  /** Write the expression the groups give under the map. */
  expression?: boolean
  /** Show each cell's minterm number in its corner. */
  numbers?: boolean
}

export interface KmapTheme {
  text: string
  dim: string
  line: string
  font: string
  palette: string[]
}

const GRAY: Record<number, number[]> = { 1: [0, 1], 2: [0, 1, 3, 2] }
const bits = (v: number, n: number) => v.toString(2).padStart(n, '0')

export function parseKmap(src: string): KmapSpec {
  const j = JSON5.parse(src)
  if (!j || typeof j !== 'object') throw new Error('Write the map as an object: { vars: ["X","Y","Z"], ones: [0,1,2,3], groups: "auto" }')
  const vars = Array.isArray(j.vars) ? j.vars.map((v: unknown) => String(v)) : []
  if (vars.length < 2 || vars.length > 4) throw new Error('vars needs 2 to 4 variable names, e.g. ["X","Y","Z"].')
  const size = 1 << vars.length
  const list = (k: string) => {
    const v = j[k]
    if (v === undefined) return []
    if (!Array.isArray(v)) throw new Error(`${k} must be a list of minterm numbers.`)
    for (const m of v) if (!Number.isInteger(m) || m < 0 || m >= size) throw new Error(`${k}: ${m} is not a minterm of ${vars.length} variables (0 to ${size - 1}).`)
    return v as number[]
  }
  const groups = j.groups === 'auto' || j.groups === undefined ? (j.groups as 'auto' | undefined) : j.groups
  if (groups !== undefined && groups !== 'auto' && !(Array.isArray(groups) && groups.every((g: unknown) => Array.isArray(g))))
    throw new Error('groups must be "auto" or a list of groups, each a list of minterm numbers: [[0,1,2,3],[5,7]].')
  return {
    vars,
    ones: list('ones'),
    dc: list('dc'),
    groups,
    labels: j.labels === 'bars' || j.labels === 'codes' ? j.labels : 'both',
    zeros: j.zeros !== false,
    name: typeof j.name === 'string' ? j.name : 'F',
    expression: Boolean(j.expression),
    numbers: Boolean(j.numbers),
  }
}

/* ---------------- grouping ---------------- */

/** An implicant as a pattern per variable: 0, 1 or null (either). */
type Pattern = (0 | 1 | null)[]

const cellsOf = (p: Pattern) => {
  const out: number[] = []
  for (let m = 0; m < 1 << p.length; m++) if (p.every((b, i) => b === null || ((m >> (p.length - 1 - i)) & 1) === b)) out.push(m)
  return out
}

/** The pattern of a set of cells, or null when they are not one valid group. */
export function patternOf(cells: number[], n: number): Pattern | null {
  const set = [...new Set(cells)]
  if (!set.length || set.length & (set.length - 1)) return null
  const p: Pattern = []
  for (let i = 0; i < n; i++) {
    const vals = new Set(set.map((m) => (m >> (n - 1 - i)) & 1))
    p.push(vals.size === 2 ? null : (([...vals][0] as 0 | 1)))
  }
  return cellsOf(p).length === set.length ? p : null
}

/** A minimal sum of products: the fewest groups, then the fewest letters. */
export function solveKmap(n: number, ones: number[], dc: number[]): number[][] {
  const on = new Set(ones)
  const ok = new Set([...ones, ...dc])
  if (!on.size) return []
  const all: Pattern[] = []
  const walk = (p: Pattern) => {
    if (p.length === n) {
      const c = cellsOf(p)
      if (c.every((m) => ok.has(m)) && c.some((m) => on.has(m))) all.push(p)
      return
    }
    for (const b of [0, 1, null] as const) walk([...p, b])
  }
  walk([])
  const sets = all.map((p) => new Set(cellsOf(p)))
  // Prime: no bigger implicant holds it.
  const primes = all.filter((_, i) => !sets.some((s, j) => j !== i && s.size > sets[i].size && [...sets[i]].every((m) => s.has(m))))
  const pc = primes.map((p) => cellsOf(p))
  const lits = (p: Pattern) => p.filter((b) => b !== null).length
  let best: number[] | null = null
  const cost = (pick: number[]) => pick.length * 100 + pick.reduce((s, i) => s + lits(primes[i]), 0)
  const need = [...on]
  const search = (pick: number[], left: number[]) => {
    if (best && pick.length > best.length) return
    if (!left.length) {
      if (!best || cost(pick) < cost(best)) best = [...pick]
      return
    }
    // Cover the first uncovered one with each prime that holds it.
    const m = left[0]
    pc.forEach((cells, i) => {
      if (!cells.includes(m) || pick.includes(i)) return
      search([...pick, i], left.filter((x) => !cells.includes(x)))
    })
  }
  search([], need)
  return (best || []).map((i) => pc[i])
}

/** The product term of a group, e.g. [{ v: "X", not: true }, { v: "Y" }]; empty means 1. */
export function termOf(cells: number[], vars: string[]) {
  const p = patternOf(cells, vars.length)
  if (!p) return null
  return p.flatMap((b, i) => (b === null ? [] : [{ v: vars[i], not: b === 0 }]))
}

/** The expression in plain text with ' for a complement: F = X' + YZ. */
export function expressionText(spec: KmapSpec, groups: number[][]) {
  const terms = groups.map((g) => termOf(g, spec.vars))
  if (!terms.length) return `${spec.name} = 0`
  if (terms.some((t) => t && !t.length)) return `${spec.name} = 1`
  return `${spec.name} = ${terms.map((t) => (t || []).map((l) => `${l.v}${l.not ? "'" : ''}`).join('')).join(' + ')}`
}

/** The expression as TeX (real bars), when the map asks for it; empty otherwise. */
export function kmapExpressionTex(src: string): string {
  let spec: KmapSpec
  try {
    spec = parseKmap(src)
  } catch {
    return ''
  }
  if (!spec.expression) return ''
  const groups = resolveGroups(spec)
  const name = spec.name || 'F'
  const v = (s: string) => (s.length > 1 ? `\\mathit{${s}}` : s)
  const terms = groups.map((g) => termOf(g, spec.vars) || [])
  if (!terms.length) return `${name} = 0`
  if (terms.some((t) => !t.length)) return `${name} = 1`
  // A thin space only next to a barred letter, so the bars stay apart.
  const term = (t: { v: string; not: boolean }[]) =>
    t.map((l, i) => (i && (l.not || t[i - 1].not) ? '\\,' : '') + (l.not ? `\\overline{${v(l.v)}}` : v(l.v))).join('')
  return `${name} = ${terms.map(term).join(' + ')}`
}

/** What the agent is told about a map it drew: its groups and expression. */
export function describeKmap(src: string): string {
  const spec = parseKmap(src)
  const groups = resolveGroups(spec)
  return `K-map groups: ${groups.map((g) => `[${g.join(',')}]`).join(' ') || 'none'}; ${expressionText(spec, groups)}`
}

function resolveGroups(spec: KmapSpec): number[][] {
  const n = spec.vars.length
  if (spec.groups === 'auto') return solveKmap(n, spec.ones || [], spec.dc || [])
  const groups = spec.groups || []
  groups.forEach((g) => {
    if (!patternOf(g, n)) throw new Error(`Group [${g.join(',')}] is not a valid K-map group: it needs 1, 2, 4 or 8 cells forming a rectangle (wrapping around the edges is fine).`)
  })
  return groups
}

/* ---------------- drawing ---------------- */

let measureCtx: CanvasRenderingContext2D | null | undefined
/** Width of a label in the drawing's font (a canvas measures it; a fair guess without one). */
function textWidth(s: string, size: number, font: string, weight = 500) {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    } catch {
      measureCtx = null
    }
  }
  if (!measureCtx) return s.length * size * 0.62
  measureCtx.font = `${weight} ${size}px ${font}`
  return measureCtx.measureText(s).width
}

const escX = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderKmap(src: string, t: KmapTheme): string {
  const spec = parseKmap(src)
  const groups = resolveGroups(spec)
  const n = spec.vars.length
  const rowVars = spec.vars.slice(0, Math.floor(n / 2))
  const colVars = spec.vars.slice(Math.floor(n / 2))
  const rows = GRAY[rowVars.length]
  const cols = GRAY[colVars.length]
  const C = 46
  const bars = spec.labels !== 'codes'
  const codes = spec.labels !== 'bars'
  const font = `font-family="${escX(t.font)}"`

  // Room around the grid: codes next to it, braces outside the codes.
  const BR = 30
  const CODE = 22
  const top = 8 + (codes && !bars ? 16 : 0) + (bars && colVars.length > 1 ? BR : 0) + (codes ? CODE : 0) + (bars && colVars.length === 1 ? BR : 0)
  const left = 8 + (bars && rowVars.length > 1 ? BR : 0) + (codes ? CODE + 6 : 0) + (bars && rowVars.length === 1 ? 26 : 0)
  const gw = cols.length * C
  const gh = rows.length * C
  const bottom = bars && colVars.length > 1 ? BR + 6 : 10
  const right = bars && rowVars.length > 1 ? BR + 8 : 12
  const W = left + gw + right
  const H = top + gh + bottom

  const out: string[] = []
  const text = (x: number, y: number, s: string, size: number, anchor = 'middle', color = t.text, weight = 400) =>
    `<text x="${x}" y="${y}" font-size="${size}" ${font} fill="${color}" text-anchor="${anchor}" dominant-baseline="central" font-weight="${weight}">${escX(s)}</text>`
  /** A variable name, with a bar over it when complemented (a real line, not a combining mark). */
  const varLabel = (x: number, y: number, v: string, not: boolean, size = 16, anchor = 'middle') => {
    const w = textWidth(v, size, t.font)
    const x0 = anchor === 'end' ? x - w : anchor === 'start' ? x : x - w / 2
    return text(x, y, v, size, anchor, t.text, 500) + (not ? `<line x1="${x0 + 1}" y1="${y - size * 0.62}" x2="${x0 + w - 1}" y2="${y - size * 0.62}" stroke="${t.text}" stroke-width="1.4"/>` : '')
  }
  /** A curly brace along a side; `out` is the direction its point faces. */
  const brace = (a: number, b: number, at: number, side: 'top' | 'bottom' | 'left' | 'right') => {
    const d = 6
    const s = side === 'top' || side === 'left' ? -1 : 1
    const m = (a + b) / 2
    const p =
      side === 'top' || side === 'bottom'
        ? `M${a + 3},${at} Q${a + 3},${at + s * d} ${a + 9},${at + s * d} L${m - 6},${at + s * d} Q${m},${at + s * d} ${m},${at + 2 * s * d} Q${m},${at + s * d} ${m + 6},${at + s * d} L${b - 9},${at + s * d} Q${b - 3},${at + s * d} ${b - 3},${at}`
        : `M${at},${a + 3} Q${at + s * d},${a + 3} ${at + s * d},${a + 9} L${at + s * d},${m - 6} Q${at + s * d},${m} ${at + 2 * s * d},${m} Q${at + s * d},${m} ${at + s * d},${m + 6} L${at + s * d},${b - 9} Q${at + s * d},${b - 3} ${at},${b - 3}`
    return `<path d="${p}" fill="none" stroke="${t.dim}" stroke-width="1.6"/>`
  }
  /** Runs of the same value of one variable along the Gray order. */
  const runs = (order: number[], nv: number, bit: number) => {
    const res: { from: number; to: number; on: boolean }[] = []
    order.forEach((code, i) => {
      const on = ((code >> (nv - 1 - bit)) & 1) === 1
      const last = res[res.length - 1]
      if (last && last.on === on) last.to = i
      else res.push({ from: i, to: i, on })
    })
    return res
  }

  // Grid.
  out.push(`<rect x="${left}" y="${top}" width="${gw}" height="${gh}" fill="none" stroke="${t.text}" stroke-width="2"/>`)
  for (let i = 1; i < cols.length; i++) out.push(`<line x1="${left + i * C}" y1="${top}" x2="${left + i * C}" y2="${top + gh}" stroke="${t.text}" stroke-width="1.4"/>`)
  for (let i = 1; i < rows.length; i++) out.push(`<line x1="${left}" y1="${top + i * C}" x2="${left + gw}" y2="${top + i * C}" stroke="${t.text}" stroke-width="1.4"/>`)

  // Gray codes beside the grid, and the corner label (rows \ columns).
  if (codes) {
    cols.forEach((c, i) => out.push(text(left + i * C + C / 2, top - CODE / 2 - 2, bits(c, colVars.length), 13, 'middle', t.dim)))
    rows.forEach((r, i) => out.push(text(left - 8, top + i * C + C / 2, bits(r, rowVars.length), 13, 'end', t.dim)))
    // The corner, when there are no braces to name the variables: a diagonal, column variables above it, row variables below it.
    if (!bars) {
      out.push(`<line x1="${left - 26}" y1="${top - 26}" x2="${left}" y2="${top}" stroke="${t.dim}" stroke-width="1"/>`)
      out.push(text(left - 8, top - 28, colVars.join(''), 12, 'start', t.dim))
      out.push(text(left - 22, top - 4, rowVars.join(''), 12, 'end', t.dim))
    }
  }

  // Variable braces: like the board, each run of a variable's value gets a brace and its name (barred when 0).
  if (bars) {
    const sides: Record<string, { v: string; bit: number; axis: 'col' | 'row' }> = {}
    if (colVars.length === 1) sides.top = { v: colVars[0], bit: 0, axis: 'col' }
    else {
      sides.bottom = { v: colVars[0], bit: 0, axis: 'col' }
      sides.top = { v: colVars[1], bit: 1, axis: 'col' }
    }
    if (rowVars.length === 2) {
      sides.left = { v: rowVars[0], bit: 0, axis: 'row' }
      sides.right = { v: rowVars[1], bit: 1, axis: 'row' }
    }
    for (const [side, s] of Object.entries(sides) as [('top' | 'bottom' | 'left' | 'right'), (typeof sides)[string]][]) {
      const order = s.axis === 'col' ? cols : rows
      const nv = s.axis === 'col' ? colVars.length : rowVars.length
      for (const r of runs(order, nv, s.bit)) {
        if (side === 'top' || side === 'bottom') {
          const a = left + r.from * C
          const b = left + (r.to + 1) * C
          const at = side === 'top' ? top - (codes ? CODE : 0) - 4 : top + gh + 4
          out.push(brace(a, b, at, side))
          out.push(varLabel((a + b) / 2, side === 'top' ? at - 20 : at + 22, s.v, !r.on))
        } else {
          const a = top + r.from * C
          const b = top + (r.to + 1) * C
          const at = side === 'left' ? left - (codes ? CODE + 6 : 0) - 4 : left + gw + 4
          out.push(brace(a, b, at, side))
          out.push(varLabel(side === 'left' ? at - 16 : at + 16, (a + b) / 2, s.v, !r.on, 16, side === 'left' ? 'end' : 'start'))
        }
      }
    }
    // One row variable: its name beside each row.
    if (rowVars.length === 1)
      rows.forEach((r, i) => out.push(varLabel(left - (codes ? CODE + 6 : 0) - 8, top + i * C + C / 2, rowVars[0], r === 0, 16, 'end')))
  }

  // Values.
  const ones = new Set(spec.ones)
  const dc = new Set(spec.dc)
  rows.forEach((r, ri) =>
    cols.forEach((c, ci) => {
      const m = (r << colVars.length) | c
      const x = left + ci * C + C / 2
      const y = top + ri * C + C / 2
      const v = ones.has(m) ? '1' : dc.has(m) ? 'X' : spec.zeros ? '0' : ''
      if (v) out.push(text(x, y + 1, v, 19, 'middle', v === '0' ? t.dim : t.text))
      if (spec.numbers) out.push(text(left + ci * C + C - 4, top + ri * C + 8, String(m), 9, 'end', t.dim))
    }),
  )

  // Group loops: rounded rectangles, open at the edge when they wrap around.
  const clipId = `kc${Math.random().toString(36).slice(2, 8)}`
  out.push(`<clipPath id="${clipId}"><rect x="${left - 3}" y="${top - 3}" width="${gw + 6}" height="${gh + 6}"/></clipPath>`)
  const segs = (idx: number[], len: number) => {
    // Contiguous runs of positions, cyclic: a run touching both ends wraps.
    const s = [...new Set(idx)].sort((a, b) => a - b)
    const parts: number[][] = []
    s.forEach((p) => {
      const last = parts[parts.length - 1]
      if (last && p === last[last.length - 1] + 1) last.push(p)
      else parts.push([p])
    })
    if (parts.length > 1 && parts[0][0] === 0 && parts[parts.length - 1].slice(-1)[0] === len - 1)
      return parts.map((p) => ({ from: p[0], to: p[p.length - 1], openStart: p[0] === 0, openEnd: p[p.length - 1] === len - 1 }))
    return parts.map((p) => ({ from: p[0], to: p[p.length - 1], openStart: false, openEnd: false }))
  }
  groups.forEach((g, gi) => {
    const color = t.palette[gi % t.palette.length] || t.text
    const ri = [...new Set(g.map((m) => rows.indexOf(m >> colVars.length)))]
    const ci = [...new Set(g.map((m) => cols.indexOf(m & ((1 << colVars.length) - 1))))]
    const pad = 5 + (gi % 3) * 3
    for (const rs of segs(ri, rows.length))
      for (const cs of segs(ci, cols.length)) {
        let x1 = left + cs.from * C + pad
        let x2 = left + (cs.to + 1) * C - pad
        let y1 = top + rs.from * C + pad
        let y2 = top + (rs.to + 1) * C - pad
        if (cs.openStart) x1 -= C
        if (cs.openEnd) x2 += C
        if (rs.openStart) y1 -= C
        if (rs.openEnd) y2 += C
        const r = Math.min(16, (x2 - x1) / 2, (y2 - y1) / 2)
        out.push(
          `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" rx="${r}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="2.4"${cs.openStart || cs.openEnd || rs.openStart || rs.openEnd ? ` clip-path="url(#${clipId})"` : ''}/>`,
        )
      }
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="w-kmap">${out.join('')}</svg>`
}
