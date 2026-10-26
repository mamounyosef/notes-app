type Box = { left: number; top: number; right: number; bottom: number }
type Span = { from: number; to: number }
type Indexed = ReturnType<typeof indexText>

/** Whitespace-collapsed text of an element with each character mapped back to its text node. */
function indexText(root: HTMLElement) {
  const nodes: Text[] = []
  const map: { n: number; o: number }[] = []
  let text = ''
  let lastSpace = true
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement as HTMLElement | null)?.closest('.katex-mathml, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const ni = nodes.push(node) - 1
    const v = node.nodeValue || ''
    for (let o = 0; o < v.length; o++) {
      const ch = v[o]
      if (/\s/.test(ch)) {
        if (lastSpace) continue
        text += ' '
        lastSpace = true
      } else {
        text += ch
        lastSpace = false
      }
      map.push({ n: ni, o })
    }
  }
  return { nodes, map, text }
}

/** Lowercased, with every character kept at its place. */
function fold(t: string) {
  let s = ''
  for (const ch of t) {
    const l = ch.toLowerCase()
    s += l.length === ch.length ? l : ch
  }
  return s
}

/** The nth place a piece of text sits in a cell (or the start of it, when the whole is not there). */
function findAnchor(text: string, anchor: string, nth = 0): Span | null {
  const full = fold(anchor.replace(/\s+/g, ' ').trim())
  if (!full) return null
  const hay = fold(text)
  for (const len of [full.length, 200, 100, 50, 25, 12]) {
    if (len > full.length) continue
    const needle = full.slice(0, len).trim()
    if (!needle) continue
    let at = -1
    for (let i = 0, from = 0; i <= nth; i++) {
      const k = hay.indexOf(needle, from)
      if (k < 0) break
      at = k
      from = k + 1
    }
    if (at >= 0) return { from: at, to: at + needle.length }
  }
  return null
}

/**
 * Where text b differs from text a, as spans of b, word by word
 * (from === to: something was only removed there).
 */
export function changedSpans(a: string, b: string): Span[] {
  if (a === b) return []
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a[p] === b[p]) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  // A change that starts or ends inside a word takes the whole word.
  const word = (c: string | undefined) => c !== undefined && c !== ' '
  if (word(b[p - 1]) && (word(a[p]) || word(b[p]))) while (p > 0 && word(b[p - 1])) p--
  if (word(b[b.length - s]) && (word(a[a.length - s - 1]) || word(b[b.length - s - 1]))) while (s > 0 && word(b[b.length - s])) s--

  const tokens = (t: string, off: number) => [...t.matchAll(/[^ ]+/g)].map((m) => ({ w: m[0], from: off + m.index!, to: off + m.index! + m[0].length }))
  const A = tokens(a.slice(p, a.length - s), p)
  const B = tokens(b.slice(p, b.length - s), p)
  if (!B.length) return [{ from: p, to: p }]
  if (!A.length || A.length * B.length > 1_500_000) return [{ from: B[0].from, to: B[B.length - 1].to }]

  // Longest common run of words; what is left over in b is new.
  const n = A.length
  const m = B.length
  const W = m + 1
  const L = new Uint32Array((n + 1) * W)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * W + j] = A[i].w === B[j].w ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
  const out: Span[] = []
  let run: Span | null = null
  let gone = false
  const flush = (at: number) => {
    if (run) out.push(run)
    else if (gone) out.push({ from: at, to: at })
    run = null
    gone = false
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && A[i].w === B[j].w) {
      flush(B[j].from)
      i++
      j++
    } else if (j < m && (i >= n || L[i * W + j + 1] >= L[(i + 1) * W + j])) {
      run = { from: run ? run.from : B[j].from, to: B[j].to }
      j++
    } else {
      gone = true
      i++
    }
  }
  flush(B[m - 1].to)
  // Changes a short word apart read as one.
  const merged: Span[] = []
  for (const sp of out) {
    const prev = merged[merged.length - 1]
    if (prev && sp.from - prev.to <= 4) prev.to = Math.max(prev.to, sp.to)
    else merged.push({ ...sp })
  }
  return merged.slice(0, 30)
}

/** A DOM range over characters [from, to) of indexed text, without edge spaces. */
function rangeOf(ix: Indexed, from: number, to: number): Range | null {
  while (from < to && ix.text[from] === ' ') from++
  while (to > from && ix.text[to - 1] === ' ') to--
  const a = ix.map[from]
  const b = ix.map[to - 1]
  if (from >= to || !a || !b) return null
  const range = document.createRange()
  range.setStart(ix.nodes[a.n], a.o)
  range.setEnd(ix.nodes[b.n], b.o + 1)
  return range
}

/** Merges a range's client rects into one box per text line. */
function lineBoxes(range: Range) {
  const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
  rects.sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: Box[] = []
  for (const r of rects) {
    const prev = lines[lines.length - 1]
    const overlap = prev ? Math.min(prev.bottom, r.bottom) - Math.max(prev.top, r.top) : 0
    if (prev && overlap > Math.min(prev.bottom - prev.top, r.height) * 0.5) {
      prev.left = Math.min(prev.left, r.left)
      prev.right = Math.max(prev.right, r.right)
      prev.top = Math.min(prev.top, r.top)
      prev.bottom = Math.max(prev.bottom, r.bottom)
    } else {
      lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
  }
  return lines
}

/** A thin caret where text was taken out: before the next character, or after the previous one. */
function caretBox(ix: Indexed, at: number): Box | null {
  const edge = (i: number, right: boolean) => {
    const r = rangeOf(ix, i, i + 1)
    const rect = r && [...r.getClientRects()].find((x) => x.height > 1)
    return rect ? { x: right ? rect.right : rect.left, top: rect.top, bottom: rect.bottom } : null
  }
  let c: { x: number; top: number; bottom: number } | null = null
  for (let i = at; !c && i < Math.min(ix.text.length, at + 3); i++) c = edge(i, false)
  for (let i = at - 1; !c && i >= Math.max(0, at - 3); i--) c = edge(i, true)
  return c ? { left: c.x - 1.5, right: c.x + 1.5, top: c.top, bottom: c.bottom } : null
}

const unionOf = (boxes: Box[]): Box =>
  boxes.reduce((m, l) => ({ left: Math.min(m.left, l.left), top: Math.min(m.top, l.top), right: Math.max(m.right, l.right), bottom: Math.max(m.bottom, l.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity })

const cellEl = (cellId: string) => document.querySelector(`.canvas-wrap [data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null

/** The text of every cell on the open page, taken before a tool runs, so a reveal can tell exactly what it changed. */
export function cellTexts(): Map<string, string> {
  const out = new Map<string, string>()
  document.querySelectorAll<HTMLElement>('.canvas-wrap [data-cell-id]').forEach((el) => out.set(el.dataset.cellId!, indexText(el).text))
  return out
}

/** The part of the canvas you can actually see: a floating chat over it does not count. */
function viewRect(wrap: HTMLElement): Box {
  const w = wrap.getBoundingClientRect()
  const v = { left: w.left + wrap.clientLeft, top: w.top + wrap.clientTop, right: w.left + wrap.clientLeft + wrap.clientWidth, bottom: w.top + wrap.clientTop + wrap.clientHeight }
  const fp = document.querySelector('.agent-panel.floating') as HTMLElement | null
  const r = fp?.getBoundingClientRect()
  if (r && r.width && r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom) {
    const width = v.right - v.left
    if (r.left - v.left >= width * 0.4) v.right = Math.min(v.right, r.left - 8)
    else if (v.right - r.right >= width * 0.4) v.left = Math.max(v.left, r.right + 8)
  }
  return v
}

/** Scroll offsets that bring a box into view; an axis it already sits well inside is left alone. */
function goalFor(wrap: HTMLElement, f: Box) {
  const v = viewRect(wrap)
  const pad = 64
  const edge = 20
  const vh = v.bottom - v.top
  const vw = v.right - v.left
  const h = f.bottom - f.top
  const wd = f.right - f.left
  let dy = 0
  if (h <= vh - pad * 2) {
    if (f.top < v.top + edge || f.bottom > v.bottom - edge) dy = f.top - v.top - (vh - h) / 2
  } else if (f.top < v.top + edge || f.top > v.top + vh * 0.4) dy = f.top - v.top - pad
  let dx = 0
  if (wd <= vw - pad * 2) {
    if (f.left < v.left + edge || f.right > v.right - edge) dx = f.left - v.left - (vw - wd) / 2
  } else if (f.left < v.left + edge || f.left > v.left + vw * 0.4) dx = f.left - v.left - pad
  return {
    top: Math.round(Math.min(Math.max(0, wrap.scrollTop + dy), Math.max(0, wrap.scrollHeight - wrap.clientHeight))),
    left: Math.round(Math.min(Math.max(0, wrap.scrollLeft + dx), Math.max(0, wrap.scrollWidth - wrap.clientWidth))),
  }
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r))

/** Waits for a changed cell to finish rendering: its text differs from before (when known) and holds still. */
async function settledCell(cellId: string, before: string | undefined, stale: () => boolean) {
  const t0 = performance.now()
  let last = ''
  let lastH = -1
  let still = 0
  while (performance.now() - t0 < 1500) {
    await frame()
    if (stale()) return null
    const el = cellEl(cellId)
    if (!el) continue
    const text = indexText(el).text
    // Give the new content a moment to land before taking the old one as final.
    if (before !== undefined && text === before && performance.now() - t0 < 300) continue
    const h = el.offsetHeight
    if (text === last && h === lastH) {
      if (++still >= 2) return el
    } else {
      still = 0
      last = text
      lastH = h
    }
  }
  return stale() ? null : cellEl(cellId)
}

let revealToken = 0

export interface RevealOptions {
  /** The cell's text before the change (from cellTexts), to find exactly what changed. */
  before?: string
  /** Text to look for when there is no before, or nothing in the text changed. */
  anchor?: string
  /** Which occurrence of the anchor. */
  nth?: number
  /** Called with where the change ended up, so a later click can find it again. */
  onSpot?: (spot: { anchor: string; nth: number }) => void
}

/**
 * Shows you what the agent just changed: finds the exact words it added,
 * rewrote or removed (by comparing the cell's text before and after), scrolls
 * once to them only if they are not already on screen, then marks each spot.
 */
export function scrollToCell(cellId: string, opts: RevealOptions = {}) {
  const token = ++revealToken
  const stale = () => token !== revealToken
  const wrap = document.querySelector('.canvas-wrap') as HTMLElement | null
  if (!wrap) return
  void (async () => {
    const el = await settledCell(cellId, opts.before, stale)
    if (!el || stale()) return
    document.querySelectorAll('.agent-reveal').forEach((n) => n.remove())

    // What changed, as character spans of the cell's text now (null: the whole cell).
    const ix0 = indexText(el)
    let spans: Span[] | null = null
    if (opts.before !== undefined) {
      const d = changedSpans(opts.before, ix0.text)
      if (d.length) spans = d
    }
    if (!spans && opts.anchor?.trim()) {
      const hit = findAnchor(ix0.text, opts.anchor, opts.nth)
      if (hit) spans = [hit]
    }
    const textLen = ix0.text.length

    if (spans?.length && opts.onSpot) {
      const sp = spans[0]
      const from = sp.from === sp.to ? Math.max(0, sp.from - 24) : sp.from
      const to = sp.from === sp.to ? sp.to + 24 : sp.to
      const anchor = ix0.text.slice(from, Math.min(to, from + 400)).trim()
      const hay = fold(ix0.text)
      const needle = fold(anchor)
      const start = hay.indexOf(needle, from)
      let nth = 0
      for (let k = hay.indexOf(needle); k >= 0 && k < start; k = hay.indexOf(needle, k + 1)) nth++
      if (anchor) opts.onSpot({ anchor, nth })
    }

    // Where each change is on screen right now, clipped to the cell (a fixed-height cell hides its overflow).
    type Mark = { boxes: Box[]; kind: 'line' | 'caret' | 'cell' }
    let lastMarks: Mark[] = []
    const measure = (): Mark[] => {
      const cell = cellEl(cellId)
      if (!cell) return lastMarks
      const cr = cell.getBoundingClientRect()
      const whole: Mark[] = [{ boxes: [{ left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom }], kind: 'cell' }]
      if (!spans) return (lastMarks = whole)
      const ix = indexText(cell)
      if (ix.text.length !== textLen) return lastMarks.length ? lastMarks : (lastMarks = whole)
      const clip = (b: Box) => ({ left: Math.max(b.left, cr.left), top: Math.max(b.top, cr.top), right: Math.min(b.right, cr.right), bottom: Math.min(b.bottom, cr.bottom) })
      const marks: Mark[] = []
      for (const sp of spans) {
        const raw = sp.from === sp.to ? [caretBox(ix, sp.from)].filter((b): b is Box => !!b) : (() => { const r = rangeOf(ix, sp.from, sp.to); return r ? lineBoxes(r) : [] })()
        const boxes = raw.map(clip).filter((b) => b.bottom - b.top > 1 && b.right - b.left > 0)
        if (boxes.length) marks.push({ boxes, kind: sp.from === sp.to ? 'caret' : 'line' })
      }
      return (lastMarks = marks.length ? marks : whole)
    }

    // The spot to bring into view: every change when they fit together, else the first one.
    const focus = (marks: Mark[]) => {
      const v = viewRect(wrap)
      const all = unionOf(marks.flatMap((m) => m.boxes))
      if (all.bottom - all.top <= v.bottom - v.top - 128 && all.right - all.left <= v.right - v.left - 128) return all
      return unionOf(marks[0].boxes)
    }

    const mark = () => {
      const host = wrap.firstElementChild as HTMLElement | null
      if (!host || stale()) return
      const marks = measure()
      const hr = host.getBoundingClientRect()
      const layer = document.createElement('div')
      layer.className = 'agent-reveal'
      let i = 0
      for (const m of marks) {
        for (const l of m.boxes.slice(0, 40)) {
          const bit = document.createElement('div')
          bit.className = m.kind === 'cell' ? 'agent-reveal-cell' : m.kind === 'caret' ? 'agent-reveal-caret' : 'agent-reveal-line'
          const padX = m.kind === 'cell' ? 6 : m.kind === 'caret' ? 0 : 3
          const padY = m.kind === 'cell' ? 6 : 2
          bit.style.left = `${l.left - hr.left - padX}px`
          bit.style.top = `${l.top - hr.top - padY}px`
          bit.style.width = `${l.right - l.left + padX * 2}px`
          bit.style.height = `${l.bottom - l.top + padY * 2}px`
          bit.style.animationDelay = `${Math.min(i++, 12) * 60}ms`
          layer.appendChild(bit)
        }
      }
      host.appendChild(layer)
      setTimeout(() => layer.remove(), 2600)
    }

    // You typing in another cell: never pull the page out from under you.
    const ae = document.activeElement as HTMLElement | null
    const busy = !!ae && wrap.contains(ae) && (ae.isContentEditable || /^(INPUT|TEXTAREA)$/.test(ae.tagName)) && !ae.closest(`[data-cell-id="${CSS.escape(cellId)}"]`)
    const from = { top: wrap.scrollTop, left: wrap.scrollLeft }
    const to0 = goalFor(wrap, focus(measure()))
    const far = Math.hypot(to0.top - from.top, to0.left - from.left)
    if (busy || far < 2) return mark()

    // One smooth glide there (the cell has settled, so the target holds); your own scrolling ends it.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const duration = reduced ? 0 : Math.min(800, 300 + far * 0.3)
    let stop = false
    const cancel = () => { stop = true }
    const evs = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
    evs.forEach((e) => wrap.addEventListener(e, cancel, { passive: true }))
    const t0 = performance.now()
    const to = to0
    for (;;) {
      const now = await frame()
      if (stale() || stop) break
      const k = duration ? Math.min(1, (now - t0) / duration) : 1
      const e = 1 - Math.pow(1 - k, 3)
      wrap.scrollTo({ top: from.top + (to.top - from.top) * e, left: from.left + (to.left - from.left) * e, behavior: 'instant' as ScrollBehavior })
      if (k >= 1) break
    }
    evs.forEach((e) => wrap.removeEventListener(e, cancel))
    if (!stale()) mark()
  })()
}
