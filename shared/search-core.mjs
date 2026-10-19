/**
 * Ranked search over notes, shared by the desktop app, the browser server and
 * the browser-only build.
 *
 * - Every word of the query must match somewhere on the page (title, its
 *   notebook and section names, cell titles or cell text). If no page has
 *   them all, pages matching most of them are shown instead.
 * - A word matches exactly, as the start of a word ("grad" finds "gradient"),
 *   inside a word, or approximately: typos within an edit distance of 1 for
 *   words of 4 to 7 letters and 2 for longer ones ("backpropogation").
 * - Accents and case are ignored. "Quoted text" must appear as written.
 * - Ranking: exact beats prefix beats substring beats typo; titles weigh more
 *   than body text; the whole query appearing as a phrase, words close
 *   together, and recently edited pages all score higher.
 */

const FIELD_WEIGHT = { title: 6, path: 2.5, cellTitle: 4, body: 1 }
const KIND_SCORE = { exact: 1, prefix: 0.8, inner: 0.5, fuzzy: 0.35 }
const MAX_PAGES = 60
const MAX_CELLS = 4

/** Lowercase and strip accents, keeping the string the same length where possible. */
export function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
}

/** Splits a query into terms and "quoted phrases". */
export function parseQuery(q) {
  const terms = []
  const phrases = []
  const s = fold(q)
  const re = /"([^"]+)"|(\S+)/g
  let m
  while ((m = re.exec(s))) {
    if (m[1] && m[1].trim()) phrases.push(m[1].trim())
    else if (m[2]) {
      const t = m[2].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      if (t) terms.push(t)
    }
  }
  return { terms: [...new Set(terms)], phrases, raw: s.replace(/"/g, '').trim() }
}

/** Damerau-Levenshtein distance, giving up early once it exceeds max. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev2 = new Array(b.length + 1)
  let prev = new Array(b.length + 1)
  let cur = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

const allowedTypos = (t) => (t.length >= 8 ? 2 : t.length >= 4 ? 1 : 0)

/** Words of a folded text with their positions. */
function wordsOf(text) {
  const out = []
  const re = /[\p{L}\p{N}]+/gu
  let m
  while ((m = re.exec(text))) out.push({ w: m[0], i: m.index })
  return out
}

/**
 * Best match of one term in a text. Returns { kind, start, end, score } or null.
 * `words` is the text's word list, computed once per text.
 */
function matchTerm(term, text, words) {
  let best = null
  const take = (kind, start, end) => {
    const score = KIND_SCORE[kind]
    if (!best || score > best.score) best = { kind, start, end, score }
  }
  for (const { w, i } of words) {
    if (w === term) return { kind: 'exact', start: i, end: i + w.length, score: KIND_SCORE.exact }
    if (w.startsWith(term)) take('prefix', i, i + term.length)
  }
  if (best) return best
  const at = text.indexOf(term)
  if (at >= 0) return { kind: 'inner', start: at, end: at + term.length, score: KIND_SCORE.inner }
  const max = allowedTypos(term)
  if (!max) return null
  let bestD = max + 1
  for (const { w, i } of words) {
    if (w.length < 3) continue
    // Compare with the word, and with its start for prefix typos ("backprop" vs "backpropagation").
    const d = Math.min(distance(term, w, max), w.length > term.length ? distance(term, w.slice(0, term.length), max) : max + 1)
    if (d < bestD) {
      bestD = d
      best = { kind: 'fuzzy', start: i, end: i + w.length, score: KIND_SCORE.fuzzy * (d === 1 ? 1 : 0.7) }
      if (d === 1 && w.length === term.length) break
    }
  }
  return best
}

/** Scores one field; returns { score, matched: Set<term>, marks: [start,end][] }. */
function scoreField(q, text, weight) {
  const folded = fold(text)
  const words = wordsOf(folded)
  const matched = new Set()
  const marks = []
  /** How each term matched here, and the word it matched (shown for near matches). */
  const how = new Map()
  let score = 0
  for (const t of q.terms) {
    const m = matchTerm(t, folded, words)
    if (!m) continue
    matched.add(t)
    how.set(t, { kind: m.kind, word: text.slice(m.start, m.end) })
    marks.push([m.start, m.end])
    score += m.score * weight
  }
  for (const p of q.phrases) {
    const at = folded.indexOf(p)
    if (at < 0) continue
    matched.add(`"${p}`)
    marks.push([at, at + p.length])
    score += 1.2 * weight
  }
  // Whole query as written, and words sitting close together.
  if (q.terms.length > 1 && q.raw && folded.includes(q.raw)) score += 1.5 * weight
  else if (marks.length > 1) {
    const starts = marks.map((m) => m[0]).sort((a, b) => a - b)
    const span = starts[starts.length - 1] - starts[0]
    if (span < 80) score += 0.5 * weight * (1 - span / 80)
  }
  // A short field that is mostly the match (a title that is the query) is a strong hit.
  if (folded.length && score && folded.length < 60) score *= 1 + Math.min(1, q.raw.length / folded.length) * 0.5
  return { score, matched, marks, folded, how }
}

function mergeMarks(marks) {
  const s = [...marks].sort((a, b) => a[0] - b[0])
  const out = []
  for (const m of s) {
    const last = out[out.length - 1]
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1])
    else out.push([m[0], m[1]])
  }
  return out
}

/** A snippet of the line holding the first match, with marks moved into it. */
function snippetOf(text, marks) {
  if (!marks.length) return { snippet: text.slice(0, 120), marks: [] }
  const ms = mergeMarks(marks)
  const first = ms[0]
  const lineStart = text.lastIndexOf('\n', first[0]) + 1
  let lineEnd = text.indexOf('\n', first[1])
  if (lineEnd < 0) lineEnd = text.length
  const start = Math.max(lineStart, first[0] - 50)
  const end = Math.min(lineEnd, Math.max(first[1] + 90, start + 140))
  const out = ms.filter((m) => m[0] >= start && m[1] <= end).map((m) => [m[0] - start, m[1] - start])
  const lead = start > lineStart ? '...' : ''
  const tail = end < lineEnd ? '...' : ''
  return {
    snippet: lead + text.slice(start, end) + tail,
    marks: out.map((m) => [m[0] + lead.length, m[1] + lead.length]),
  }
}

const RANK = { exact: 4, prefix: 3, inner: 2, fuzzy: 1 }

/** Terms whose best match in these fields was only approximate, with the word that matched. */
function nearOf(terms, fields) {
  const out = []
  for (const t of terms) {
    let best = null
    for (const f of fields) {
      const h = f.how.get(t)
      if (h && (!best || RANK[h.kind] > RANK[best.kind])) best = h
    }
    if (best?.kind === 'fuzzy') out.push({ term: t, word: best.word })
  }
  return out
}

/**
 * pages: [{ id, title, path: string[], cells: [{ id, title, html }], updatedAt }]
 * Returns [{ pageId, title, score, titleMarks, pathText, hits: [{ cellId, cellTitle, snippet, marks, titleMarks }] }]
 */
export function searchPages(query, pages, now = Date.now()) {
  const q = parseQuery(query)
  const need = q.terms.length + q.phrases.length
  if (!need) return []
  const results = []
  for (const page of pages) {
    const pageMatched = new Set()
    const title = scoreField(q, page.title || '', FIELD_WEIGHT.title)
    title.matched.forEach((t) => pageMatched.add(t))
    const pathText = (page.path || []).join(' / ')
    const path = scoreField(q, pathText, FIELD_WEIGHT.path)
    path.matched.forEach((t) => pageMatched.add(t))
    const cells = []
    const bodies = []
    for (const cell of page.cells || []) {
      const ct = scoreField(q, cell.title || '', FIELD_WEIGHT.cellTitle)
      const text = stripHtml(cell.html)
      const body = scoreField(q, text, FIELD_WEIGHT.body)
      if (!ct.score && !body.score) continue
      ct.matched.forEach((t) => pageMatched.add(t))
      body.matched.forEach((t) => pageMatched.add(t))
      const all = new Set([...ct.matched, ...body.matched])
      // A cell holding every word on its own beats one that only shares a word.
      const cover = all.size / need
      cells.push({ score: (ct.score + body.score) * (0.5 + cover), cell, text, body, ct })
      bodies.push(ct, body)
    }
    const coverage = pageMatched.size / need
    if (!coverage) continue
    cells.sort((a, b) => b.score - a.score)
    const top = cells.slice(0, MAX_CELLS)
    let score = title.score + path.score * 0.6 + top.reduce((s, c, i) => s + c.score / (i + 1), 0)
    // Recently edited pages get a small lift (up to 15% within a week).
    const age = Math.max(0, now - (page.updatedAt || 0)) / 864e5
    score *= 1 + 0.15 * Math.max(0, 1 - age / 7)
    results.push({
      coverage,
      score: score * coverage * coverage,
      pageId: page.id,
      title: page.title || 'Untitled',
      titleMarks: mergeMarks(title.marks),
      // What to tell the person about this result.
      near: nearOf(q.terms, [title, path, ...bodies]),
      missing: [...q.terms.filter((t) => !pageMatched.has(t)), ...q.phrases.filter((p) => !pageMatched.has(`"${p}`))],
      matchedIn: [title.score && 'title', path.score && 'notebook', bodies.some((b) => b.score) && 'text'].filter(Boolean),
      hits: top.map((c) => {
        const sn = snippetOf(c.text, c.body.marks)
        return {
          cellId: c.cell.id,
          cellTitle: c.cell.title || '',
          snippet: sn.snippet,
          marks: sn.marks,
          titleMarks: mergeMarks(c.ct.marks),
          near: nearOf(q.terms, [c.ct, c.body]),
        }
      }),
    })
  }
  // Pages holding every word come first; if none do, the closest ones are shown.
  const full = results.filter((r) => r.coverage === 1)
  const list = full.length ? full : results.filter((r) => r.coverage >= 0.5)
  list.sort((a, b) => b.score - a.score)
  return list.slice(0, MAX_PAGES).map(({ coverage, ...r }) => ({ ...r, partial: coverage < 1 }))
}

/**
 * A corrected query when the top results only matched approximately
 * ("backpropogation" -> "backpropagation"), or null.
 */
export function suggestion(query, results) {
  const top = results[0]
  if (!top?.near?.length) return null
  let out = fold(query)
  for (const n of top.near) out = out.replace(n.term, fold(n.word))
  return out === fold(query) ? null : out
}

/** Paths (notebook and section names) and archived state for every page in a workspace tree. */
export function pageIndex(tree) {
  const out = new Map()
  const walk = (nodes, path, archived) => {
    for (const n of nodes || []) {
      const arch = archived || Boolean(n.archived)
      if (n.kind === 'page') out.set(n.id, { path, archived: arch })
      walk(n.children, n.kind === 'page' ? path : [...path, n.title], arch)
    }
  }
  walk(tree, [], false)
  return out
}
