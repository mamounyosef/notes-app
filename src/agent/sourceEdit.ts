/**
 * Working on the source of a big drawing without resending it: an outline, reads
 * of any part, search (in the source and in the text the user sees), and edits
 * that are all or nothing. Pure (no DOM, no app imports) so it runs in Node tests.
 *
 * Offsets are characters, not lines: pasted HTML is often one enormous line.
 * Every edit in a call is placed against the source as it was read, so edits
 * never shift each other's offsets.
 */

/** Up to this size a drawing is shown whole; past it the model works on parts. */
export const BIG_SOURCE = 12000
/** The most one read returns. */
export const MAX_READ = 16000
/** `full` reads stop here: past it the source would crowd out the conversation. */
export const MAX_FULL_READ = 60000
/** Starts the stand-in shown instead of a big source. Update and copy code looks for it. */
export const KEPT_MARK = '[source kept:'

export function keptStub(index: number, chars: number) {
  return `${KEPT_MARK} drawing ${index}, ${chars} chars. Leave this block as it is to keep the drawing. Use read_drawing and edit_drawing to work on it.]`
}

export function keptIndex(src: string): number | null {
  const m = /^\s*\[source kept: drawing (\d+),/.exec(src)
  return m ? Number(m[1]) : null
}

/** Short tag for one exact source; offsets are only good for the version they were read from. */
export function sourceVersion(src: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 0x01000193)
  return `v${(h >>> 0).toString(36)}`
}

/* ---- HTML structure (forgiving: a broken page still gets an outline) ---- */

interface El {
  tag: string
  label: string
  start: number
  end: number
  kids: El[]
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style', 'textarea', 'title'])
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g

function scanTags(src: string, visit: (t: { close: boolean; name: string; attrs: string; start: number; end: number; selfClosed: boolean }) => void) {
  const re = new RegExp(TAG)
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (!m[2]) continue
    const name = m[2].toLowerCase()
    const close = m[1] === '/'
    const selfClosed = /\/\s*$/.test(m[3] || '')
    visit({ close, name, attrs: m[3] || '', start: m.index, end: re.lastIndex, selfClosed })
    if (!close && !selfClosed && RAW.has(name)) {
      // Script and style text can hold anything, even "<div>" in a string.
      const low = src.toLowerCase().indexOf(`</${name}`, re.lastIndex)
      if (low < 0) return
      re.lastIndex = low
    }
  }
}

function parseElements(src: string): El[] {
  const root: El = { tag: '', label: '', start: 0, end: src.length, kids: [] }
  const stack = [root]
  scanTags(src, (t) => {
    if (t.close) {
      const at = stack.map((e) => e.tag).lastIndexOf(t.name)
      if (at < 1) return
      stack[at].end = t.end
      for (let i = stack.length - 1; i > at; i--) stack[i].end = t.start
      stack.length = at
      return
    }
    const id = /\sid\s*=\s*["']?([\w-]+)/i.exec(t.attrs)?.[1]
    const cls = /\sclass\s*=\s*["']?([\w-]+)/i.exec(t.attrs)?.[1]
    const el: El = { tag: t.name, label: `<${t.name}${id ? `#${id}` : cls ? `.${cls}` : ''}>`, start: t.start, end: t.end, kids: [] }
    stack[stack.length - 1].kids.push(el)
    if (!VOID.has(t.name) && !t.selfClosed) stack.push(el)
  })
  for (let i = stack.length - 1; i > 0; i--) stack[i].end = src.length
  return root.kids
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', oplus: '⊕', times: '×', minus: '−', ndash: '-', mdash: '-' }

/** The text the user sees, with where each character came from in the source. */
export function visibleText(src: string, from = 0, to = src.length) {
  let text = ''
  const at: number[] = []
  const put = (s: string, pos: number) => {
    for (const ch of s) {
      text += ch
      at.push(pos)
    }
  }
  const plain = (a: number, b: number) => {
    const re = /&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi
    let i = a
    const raw = src.slice(a, b)
    let m: RegExpExecArray | null
    while ((m = re.exec(raw))) {
      for (let k = i; k < a + m.index; k++) put(src[k], k)
      const e = m[1]
      const code = e[0] === '#' ? parseInt(e.slice(e[1] === 'x' || e[1] === 'X' ? 2 : 1), e[1] === 'x' || e[1] === 'X' ? 16 : 10) : NaN
      put(Number.isNaN(code) ? ENTITIES[e.toLowerCase()] ?? m[0] : String.fromCodePoint(code), a + m.index)
      i = a + m.index + m[0].length
    }
    for (let k = i; k < b; k++) put(src[k], k)
  }
  let pos = from
  let hidden = 0
  const part = src.slice(from, to)
  scanTags(part, (t) => {
    if (!hidden) plain(pos, from + t.start)
    pos = from + t.end
    if (RAW.has(t.name) && t.name !== 'title' && !t.selfClosed) hidden += t.close ? -1 : 1
  })
  if (!hidden) plain(pos, to)
  return { text, at }
}

const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A map of the source: the biggest parts are opened first until the map is about 70 lines. */
export function outlineSource(src: string, kind: string, wanted = 70): string[] {
  if (kind !== 'html') return outlineLines(src, wanted)
  const open: El[] = parseElements(src)
  if (!open.length) return outlineLines(src, wanted)
  const shown = [...open]
  const parents = new Set<El>()
  for (;;) {
    const next = shown
      .filter((e) => e.kids.length && !parents.has(e))
      .sort((a, b) => b.end - b.start - (a.end - a.start))[0]
    if (!next || next.end - next.start < 1500 || shown.length + next.kids.length > wanted) break
    parents.add(next)
    shown.push(...next.kids)
  }
  const depth = (e: El) => {
    let d = 0
    for (const p of parents) if (p !== e && p.start <= e.start && p.end >= e.end) d++
    return d
  }
  return shown
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((e) => {
      const words = squeeze(visibleText(src, e.start, e.end).text)
      return `${'  '.repeat(Math.min(depth(e), 6))}[${e.start}-${e.end}] ${e.label}${words ? ` "${clip(words, 70)}"` : ''}`
    })
}

function outlineLines(src: string, wanted: number) {
  const step = Math.max(600, Math.ceil(src.length / wanted))
  const out: string[] = []
  let start = 0
  while (start < src.length) {
    const nl = src.indexOf('\n', start + step)
    const end = nl < 0 ? src.length : nl + 1
    out.push(`[${start}-${end}] "${clip(squeeze(src.slice(start, end)), 70)}"`)
    start = end
  }
  return out
}

/* ---- search ---- */

export interface Hit {
  at: number
  end: number
  context: string
}

const around = (src: string, at: number, end: number, pad = 50) =>
  `${at > pad ? '…' : ''}${src.slice(Math.max(0, at - pad), at)}⟦${clip(src.slice(at, end), 120)}⟧${src.slice(end, end + pad)}${end + pad < src.length ? '…' : ''}`.replace(/\s+/g, ' ')

function allOf(src: string, needle: string, from: number, to: number) {
  const out: number[] = []
  let i = src.indexOf(needle, from)
  while (i >= 0 && i + needle.length <= to) {
    out.push(i)
    i = src.indexOf(needle, i + needle.length)
  }
  return out
}

/**
 * Finds text in the source, or failing that in what the user sees: "K1" is
 * written K<sub>1</sub> in the source, and the model only knows the screen.
 */
export function searchSource(src: string, query: string, o: { regex?: boolean; caseSensitive?: boolean; from?: number; to?: number; limit?: number } = {}) {
  const from = Math.max(0, o.from ?? 0)
  const to = Math.min(src.length, o.to ?? src.length)
  const limit = o.limit ?? 30
  const hits: Hit[] = []
  let total = 0
  const add = (at: number, end: number) => {
    total++
    if (hits.length < limit) hits.push({ at, end, context: around(src, at, end) })
  }
  if (o.regex) {
    const re = makeRegex(query, o.caseSensitive ? 'g' : 'gi')
    const part = src.slice(from, to)
    let m: RegExpExecArray | null
    while ((m = re.exec(part))) {
      if (!m[0]) {
        re.lastIndex++
        continue
      }
      add(from + m.index, from + m.index + m[0].length)
    }
    return { hits, total, where: 'source' as const }
  }
  const hay = o.caseSensitive ? src : src.toLowerCase()
  const q = o.caseSensitive ? query : query.toLowerCase()
  for (const i of allOf(hay, q, from, to)) add(i, i + q.length)
  if (total) return { hits, total, where: 'source' as const }
  const seen = visibleText(src, from, to)
  const text = o.caseSensitive ? seen.text : seen.text.toLowerCase()
  for (const i of allOf(text, q, 0, text.length)) add(seen.at[i], seen.at[i + q.length - 1] + 1)
  return { hits, total, where: 'visible text' as const }
}

function makeRegex(source: string, flags: string) {
  try {
    return new RegExp(source, flags)
  } catch (e) {
    throw new Error(`Bad regex: ${(e as Error).message}`)
  }
}

/* ---- edits ---- */

export interface SourceEdit {
  find?: string
  replace?: string
  all?: boolean
  occurrence?: number
  regex?: boolean
  from?: number
  to?: number
  copy_of?: { from: number; to: number; map?: { find: string; replace: string }[] }
}

export type EditResult =
  | { ok: true; next: string; report: string[]; applied: number }
  | { ok: false; errors: string[] }

interface Span {
  start: number
  end: number
  text: string
  edit: number
}

/** Same text with any run of spaces or line breaks, and with either kind of quote. */
function looseRegex(find: string) {
  const body = find
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/["']/g, `["']`))
    .join('\\s+')
    .replace(/>(?=<)/g, '>\\s*')
  return new RegExp(body, 'g')
}

/** Says where the model's text stops matching, so it can fix it without another read. */
function whyMissing(src: string, find: string, from: number, to: number) {
  let lo = 0
  let hi = find.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const i = src.indexOf(find.slice(0, mid), from)
    if (i >= 0 && i < to) lo = mid
    else hi = mid - 1
  }
  if (lo < 8) return 'Not found. Call read_drawing with find to locate the real text.'
  const i = src.indexOf(find.slice(0, lo), from)
  return `Not found. The first ${lo} chars match at offset ${i}, then the source has ${JSON.stringify(src.slice(i + lo, i + lo + 40))} where you wrote ${JSON.stringify(find.slice(lo, lo + 40))}.`
}

function spansOf(src: string, e: SourceEdit, n: number, version: string, given: string | undefined): { spans: Span[]; note?: string } | { error: string } {
  const copied = (): string | { error: string } => {
    if (e.copy_of) {
      const { from, to, map } = e.copy_of
      if (!(from >= 0 && to > from && to <= src.length)) return { error: `copy_of ${from}-${to} is outside the source (0-${src.length}).` }
      let t = src.slice(from, to)
      for (const m of map || []) {
        if (!m.find) continue
        if (!t.includes(m.find)) return { error: `copy_of map: ${JSON.stringify(m.find)} is not in the copied part, so the copy would be wrong.` }
        t = t.split(m.find).join(m.replace ?? '')
      }
      return t
    }
    return e.replace ?? { error: 'Give replace, or copy_of.' }
  }
  const text = copied()
  if (typeof text !== 'string') return text
  const usesOffsets = e.from !== undefined || e.to !== undefined || e.copy_of !== undefined
  if (usesOffsets && given !== version) {
    return { error: `Offsets need the current version: pass version "${version}"${given ? ` (you gave "${given}", the source changed since)` : ''} after reading the part again with read_drawing.` }
  }
  const from = e.from ?? 0
  const to = e.to ?? (e.find ? src.length : from)
  if (from < 0 || to > src.length || to < from) return { error: `Range ${from}-${to} is outside the source (0-${src.length}).` }
  if (!e.find) {
    if (e.from === undefined) return { error: 'Give find, or from (and to) with version.' }
    return { spans: [{ start: from, end: to, text, edit: n }] }
  }

  let found: { at: number; end: number; text: string }[]
  let note: string | undefined
  if (e.regex) {
    const re = makeRegex(e.find, 'g')
    const part = src.slice(from, to)
    found = []
    let m: RegExpExecArray | null
    while ((m = re.exec(part))) {
      if (!m[0]) return { error: 'The regex matches empty text.' }
      const one = new RegExp(`^(?:${e.find})$`)
      found.push({ at: from + m.index, end: from + m.index + m[0].length, text: one.test(m[0]) ? m[0].replace(one, text) : text })
    }
  } else {
    found = allOf(src, e.find, from, to).map((at) => ({ at, end: at + e.find!.length, text }))
    if (!found.length) {
      const loose = looseRegex(e.find)
      const part = src.slice(from, to)
      found = [...part.matchAll(loose)].map((m) => ({ at: from + m.index, end: from + m.index + m[0].length, text }))
      if (found.length) note = 'matched with different spacing or quotes'
    }
  }
  if (!found.length) return { error: e.regex ? 'The regex found nothing.' : whyMissing(src, e.find, from, to) }
  if (e.occurrence) {
    const one = found[e.occurrence - 1]
    if (!one) return { error: `occurrence ${e.occurrence} does not exist: the text is there ${found.length} time(s).` }
    found = [one]
  } else if (!e.all && found.length > 1) {
    const list = found.slice(0, 5).map((f) => `  at ${f.at}: ${around(src, f.at, f.end, 30)}`).join('\n')
    return { error: `Found ${found.length} times, so it is not clear which. Use all, occurrence, a longer find, or from and to.\n${list}` }
  }
  return { spans: found.map((f) => ({ start: f.at, end: f.end, text: f.text, edit: n })), note }
}

/** Applies every edit or none. Each one is placed against `src` as given. */
export function applySourceEdits(src: string, edits: SourceEdit[], given?: string): EditResult {
  const version = sourceVersion(src)
  const errors: string[] = []
  const spans: Span[] = []
  const report: string[] = []
  if (!edits.length) return { ok: false, errors: ['edits is empty.'] }
  edits.forEach((e, i) => {
    let r: ReturnType<typeof spansOf>
    try {
      r = spansOf(src, e, i + 1, version, given)
    } catch (err) {
      r = { error: (err as Error).message }
    }
    if ('error' in r) return void errors.push(`edit ${i + 1}: ${r.error}`)
    const real = r.spans.filter((s) => src.slice(s.start, s.end) !== s.text)
    if (!real.length) return void errors.push(`edit ${i + 1}: changes nothing (the new text equals the old).`)
    spans.push(...real)
    const first = real[0]
    const at = real.length > 1 ? `${real.length} places from offset ${first.start}` : `offset ${first.start}`
    report.push(`edit ${i + 1}: ${at}${r.note ? ` (${r.note})` : ''}`)
  })
  if (errors.length) return { ok: false, errors }
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1]
    const b = spans[i]
    if (b.start < a.end) errors.push(`edit ${a.edit} and edit ${b.edit} overlap at offset ${b.start}.`)
  }
  if (errors.length) return { ok: false, errors }
  let next = ''
  let pos = 0
  for (const s of spans) {
    next += src.slice(pos, s.start) + s.text
    pos = s.end
  }
  next += src.slice(pos)
  return { ok: true, next, report, applied: spans.length }
}

/* ---- safety checks on a finished source ---- */

function tagDebts(src: string) {
  const debt = new Map<string, number>()
  scanTags(src, (t) => {
    if (VOID.has(t.name) || t.selfClosed) return
    debt.set(t.name, (debt.get(t.name) || 0) + (t.close ? -1 : 1))
  })
  return debt
}

const LAZY = /(?:<!--|\/\/|\/\*|#)\s*(?:\.\.\.|…)|(?:\.\.\.|…)\s*\(?\s*(?:rest|remaining|unchanged|same as|existing|previous|other (?:parts|rounds|rows)|and so on)|\b(?:rest|remainder) of (?:the )?(?:code|file|source|html|content) (?:unchanged|stays|here|omitted)/i

/**
 * What an edit broke, in plain words. Only damage the edit itself caused counts:
 * a source that was already unbalanced does not block fixing it.
 */
export function sourceProblems(before: string, after: string, kind: string): string[] {
  const out: string[] = []
  if (!after.trim()) out.push('The source would be empty.')
  const lazy = LAZY.exec(after)
  if (lazy && !LAZY.test(before)) out.push(`It has a placeholder (${JSON.stringify(lazy[0])}) instead of real content.`)
  if (kind === 'html') {
    const a = tagDebts(before)
    const b = tagDebts(after)
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      const was = a.get(name) || 0
      const now = b.get(name) || 0
      if (now !== was) out.push(`<${name}> tags no longer balance: ${Math.abs(now)} ${now > 0 ? 'unclosed' : 'extra closing'}${was ? ` (was ${Math.abs(was)})` : ''}.`)
    }
  }
  if (kind === 'chart') {
    const parses = (s: string) => {
      try {
        JSON.parse(s)
        return ''
      } catch (e) {
        return (e as Error).message
      }
    }
    const err = parses(after)
    if (err && !parses(before)) out.push(`The JSON no longer parses: ${err}.`)
  }
  return out
}

/** A replacement of a big source that looks like a slip rather than a real rewrite. */
export function suspiciousRewrite(before: string, after: string) {
  if (before.length <= BIG_SOURCE || after.length >= before.length * 0.6) return ''
  return `The new source has ${after.length} chars and the current one ${before.length}. If this is a change to part of it, use edit_drawing. If you really mean to replace it with something much smaller, call again with rewrite: true.`
}
