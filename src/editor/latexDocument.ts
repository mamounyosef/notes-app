/**
 * Converts a pasted LaTeX document (\documentclass ... \begin{document} ...)
 * into editor HTML: text styling, centered blocks, rules, sections, lists,
 * tables and math (kept as KaTeX nodes through data-latex).
 * Layout-only commands (margins, spacing, page style) are ignored.
 */
import { escapeAttr } from './markdown'

const SEP = '\u0001' // paragraph / block boundary inside inline output
const CEN = '\u0002' // "this paragraph is centered" marker

interface Style {
  bold: boolean
  italic: boolean
  underline: boolean
  code: boolean
  size: string | null
}
const plain = (): Style => ({ bold: false, italic: false, underline: false, code: false, size: null })

const SIZES: Record<string, string | null> = {
  tiny: '8px',
  scriptsize: '10px',
  footnotesize: '11px',
  small: '13px',
  normalsize: null,
  large: '18px',
  Large: '22px',
  LARGE: '26px',
  huge: '30px',
  Huge: '34px',
}

const KNOWN_ENVS = new Set([
  'document', 'center', 'flushleft', 'flushright', 'abstract', 'figure', 'table', 'multicols', 'minipage',
  'tabular', 'tabularx', 'tabular*', 'longtable', 'itemize', 'enumerate', 'description', 'quote', 'quotation',
  'verbatim', 'lstlisting', 'equation', 'equation*', 'displaymath', 'align', 'align*', 'gather', 'gather*',
  'multline', 'multline*', 'flalign', 'flalign*',
])

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const blockMath = (tex: string) => (tex.trim() ? `<div data-latex="${escapeAttr(tex.trim())}"></div>` : '')
const inlineMath = (tex: string) => (tex.trim() ? `<span data-latex="${escapeAttr(tex.trim())}"></span>` : '')

/** Index just after the balanced {...} group that starts at src[i]. */
function consumeGroup(src: string, i: number): number {
  let depth = 0
  for (let k = i; k < src.length; k++) {
    const c = src[k]
    if (c === '\\') k++
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return k + 1
  }
  return src.length
}

class InlineParser {
  pos = 0
  constructor(private src: string) {}

  parse(style: Style): string {
    return this.until(style, false)
  }

  private wrap(text: string, style: Style): string {
    let h = esc(text)
    if (style.code) h = `<code>${h}</code>`
    if (style.bold) h = `<strong>${h}</strong>`
    if (style.italic) h = `<em>${h}</em>`
    if (style.underline) h = `<u>${h}</u>`
    if (style.size) h = `<span style="font-size:${style.size}">${h}</span>`
    return h
  }

  private until(style: Style, inGroup: boolean): string {
    const s = this.src
    let out = ''
    let buf = ''
    const flush = () => {
      if (buf) {
        out += this.wrap(buf, style)
        buf = ''
      }
    }
    const ws = /\s+/y
    while (this.pos < s.length) {
      const c = s[this.pos]
      if (c === '}') {
        this.pos++
        if (inGroup) break
        continue
      }
      if (c === '{') {
        flush()
        this.pos++
        out += this.until({ ...style }, true)
        continue
      }
      if (c === '$') {
        flush()
        out += this.math()
        continue
      }
      if (c === '\\') {
        flush()
        out += this.command(style)
        continue
      }
      if (c === '~') {
        buf += ' '
        this.pos++
        continue
      }
      if (/\s/.test(c)) {
        ws.lastIndex = this.pos
        const m = ws.exec(s)!
        this.pos += m[0].length
        if (/\n[ \t\r]*\n/.test(m[0])) {
          flush()
          out += SEP
        } else buf += ' '
        continue
      }
      if (s.startsWith('---', this.pos)) {
        buf += '—'
        this.pos += 3
        continue
      }
      if (s.startsWith('--', this.pos)) {
        buf += '–'
        this.pos += 2
        continue
      }
      if (s.startsWith('``', this.pos)) {
        buf += '“'
        this.pos += 2
        continue
      }
      if (s.startsWith("''", this.pos)) {
        buf += '”'
        this.pos += 2
        continue
      }
      buf += c
      this.pos++
    }
    flush()
    return out
  }

  private math(): string {
    const s = this.src
    if (s.startsWith('$$', this.pos)) {
      const end = s.indexOf('$$', this.pos + 2)
      if (end !== -1) {
        const tex = s.slice(this.pos + 2, end)
        this.pos = end + 2
        return SEP + blockMath(tex) + SEP
      }
    }
    let i = this.pos + 1
    while (i < s.length && s[i] !== '$') {
      if (s[i] === '\\') i++
      i++
    }
    if (i >= s.length) {
      this.pos++
      return '$'
    }
    const tex = s.slice(this.pos + 1, i)
    this.pos = i + 1
    return inlineMath(tex)
  }

  private skipSpaces() {
    const re = /[ \t]*(?:\r?\n(?![ \t]*\r?\n))?[ \t]*/y
    re.lastIndex = this.pos
    this.pos += re.exec(this.src)![0].length
  }

  private skipOptional() {
    const m = /\s*\[[^\]]*\]/y
    m.lastIndex = this.pos
    const r = m.exec(this.src)
    if (r) this.pos += r[0].length
  }

  private skipArgs(n: number) {
    for (let k = 0; k < n; k++) {
      this.skipOptional()
      this.skipSpaces()
      if (this.src[this.pos] === '{') this.pos = consumeGroup(this.src, this.pos)
    }
  }

  private rawArg(): string {
    this.skipSpaces()
    if (this.src[this.pos] !== '{') return ''
    const end = consumeGroup(this.src, this.pos)
    const raw = this.src.slice(this.pos + 1, end - 1)
    this.pos = end
    return raw
  }

  private arg(style: Style): string {
    this.skipSpaces()
    if (this.src[this.pos] === '{') {
      this.pos++
      return this.until({ ...style }, true)
    }
    if (this.pos < this.src.length) return this.wrap(this.src[this.pos++], style)
    return ''
  }

  private heading(level: number): string {
    this.skipOptional()
    const inner = this.arg(plain()).replace(/[\u0001\u0002]/g, ' ').trim()
    return SEP + `<h${level}>${inner}</h${level}>` + SEP
  }

  private command(style: Style): string {
    const s = this.src
    this.pos++ // the backslash
    const c = s[this.pos]
    if (c === undefined) return ''
    if (!/[a-zA-Z]/.test(c)) {
      this.pos++
      switch (c) {
        case '\\':
          this.skipOptional()
          return '<br>'
        case '[': {
          const end = s.indexOf('\\]', this.pos)
          if (end === -1) return ''
          const tex = s.slice(this.pos, end)
          this.pos = end + 2
          return SEP + blockMath(tex) + SEP
        }
        case '(': {
          const end = s.indexOf('\\)', this.pos)
          if (end === -1) return ''
          const tex = s.slice(this.pos, end)
          this.pos = end + 2
          return inlineMath(tex)
        }
        case '%':
        case '&':
        case '#':
        case '_':
        case '$':
        case '{':
        case '}':
          return this.wrap(c, style)
        case ',':
        case ';':
        case ':':
        case ' ':
          return ' '
        default:
          return ''
      }
    }

    const m = /[a-zA-Z]+/y
    m.lastIndex = this.pos
    const name = m.exec(s)![0]
    this.pos += name.length
    if (s[this.pos] === '*') this.pos++
    this.skipSpaces()

    if (name in SIZES) {
      style.size = SIZES[name]
      return ''
    }
    switch (name) {
      case 'textbf':
        return this.arg({ ...style, bold: true })
      case 'textit':
      case 'emph':
      case 'textsl':
        return this.arg({ ...style, italic: true })
      case 'texttt':
        return this.arg({ ...style, code: true })
      case 'underline':
        return this.arg({ ...style, underline: true })
      case 'textmd':
        return this.arg({ ...style, bold: false })
      case 'textrm':
      case 'textsf':
      case 'textsc':
      case 'textnormal':
      case 'textup':
      case 'text':
      case 'mbox':
        return this.arg({ ...style })
      case 'bfseries':
      case 'bf':
        style.bold = true
        return ''
      case 'mdseries':
        style.bold = false
        return ''
      case 'itshape':
      case 'it':
      case 'em':
      case 'slshape':
        style.italic = true
        return ''
      case 'upshape':
      case 'rmfamily':
      case 'sffamily':
        style.italic = false
        return ''
      case 'normalfont':
        style.italic = false
        style.bold = false
        style.size = null
        return ''
      case 'ttfamily':
        style.code = true
        return ''
      case 'centering':
        return CEN
      case 'newline':
        return '<br>'
      case 'par':
        return SEP
      case 'hrule':
      case 'hline':
      case 'toprule':
      case 'midrule':
      case 'bottomrule':
        return SEP + '<hr>' + SEP
      case 'enspace':
      case 'quad':
      case 'qquad':
        return '  '
      case 'hspace':
      case 'vspace':
      case 'vskip':
      case 'hskip':
      case 'pagestyle':
      case 'thispagestyle':
      case 'usepackage':
      case 'documentclass':
      case 'pagenumbering':
      case 'label':
      case 'cite':
        this.skipArgs(1)
        return ''
      case 'setlength':
      case 'renewcommand':
      case 'newcommand':
      case 'setcounter':
      case 'addtolength':
        this.skipArgs(2)
        return ''
      case 'section':
      case 'title':
        return this.heading(1)
      case 'subsection':
        return this.heading(2)
      case 'subsubsection':
        return this.heading(3)
      case 'href': {
        const url = this.rawArg()
        const text = this.arg(style)
        return `<a href="${escapeAttr(url)}">${text}</a>`
      }
      case 'url': {
        const url = this.rawArg()
        return `<a href="${escapeAttr(url)}">${esc(url)}</a>`
      }
      case 'textbackslash':
        return this.wrap('\\', style)
      case 'ldots':
      case 'dots':
      case 'textellipsis':
        return this.wrap('…', style)
      default:
        return ''
    }
  }
}

/** Splits inline output on boundaries and wraps each piece as a paragraph. */
function pieces(html: string, forceCenter: boolean): string {
  return html
    .split(SEP)
    .map((raw) => {
      const centered = forceCenter || raw.includes(CEN)
      const h = raw
        .replace(/\u0002/g, '')
        .trim()
        .replace(/^(?:<br>\s*)+|(?:\s*<br>)+$/g, '')
        .trim()
      if (!h) return ''
      if (/^<(h[1-6]|hr|div)\b/.test(h)) {
        return centered ? h.replace(/^<(h[1-6])>/, '<$1 style="text-align:center">') : h
      }
      return centered ? `<p style="text-align:center">${h}</p>` : `<p>${h}</p>`
    })
    .join('')
}

const inlineHtml = (src: string, style: Style, center: boolean) => pieces(new InlineParser(src).parse(style), center)

interface Col {
  math: boolean
  bold: boolean
}

function parseColSpec(spec: string): Col[] {
  const cols: Col[] = []
  let pre = ''
  let i = 0
  while (i < spec.length) {
    const c = spec[i]
    if (c === '>' || c === '<' || c === '@' || c === '!') {
      i++
      if (spec[i] === '{') {
        const end = consumeGroup(spec, i)
        if (c === '>') pre += spec.slice(i + 1, end - 1)
        i = end
      }
      continue
    }
    if (/[lcrXpmb]/.test(c)) {
      i++
      if ((c === 'p' || c === 'm' || c === 'b') && spec[i] === '{') i = consumeGroup(spec, i)
      cols.push({ math: pre.includes('$'), bold: /\\bfseries|\\bf(?![a-z])/.test(pre) })
      pre = ''
      continue
    }
    i++
  }
  return cols
}

/** Rows split on \\ and cells on &, outside braces and math. */
function splitTable(body: string): string[][] {
  const clean = body
    .replace(/\\(?:hline|toprule|midrule|bottomrule)(?![a-zA-Z])/g, '')
    .replace(/\\cmidrule(?:\([^)]*\))?\{[^}]*\}/g, '')
  const rows: string[][] = []
  let cells: string[] = []
  let cur = ''
  let depth = 0
  let inMath = false
  for (let k = 0; k < clean.length; k++) {
    const c = clean[k]
    if (c === '\\') {
      const n = clean[k + 1]
      if (n === '\\' && depth === 0 && !inMath) {
        cells.push(cur)
        rows.push(cells)
        cells = []
        cur = ''
        k++
        const opt = /^\s*\[[^\]]*\]/.exec(clean.slice(k + 1))
        if (opt) k += opt[0].length
        continue
      }
      cur += c + (n ?? '')
      k++
      continue
    }
    if (c === '$') inMath = !inMath
    else if (!inMath) {
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '&' && depth === 0) {
        cells.push(cur)
        cur = ''
        continue
      }
    }
    cur += c
  }
  if (cur.trim() || cells.length) {
    cells.push(cur)
    rows.push(cells)
  }
  return rows.filter((r) => r.some((cell) => cell.trim()))
}

function cellHtml(raw: string, col: Col | undefined): string {
  const t = raw.trim()
  if (!t) return '<p></p>'
  if (col?.math) return `<p>${inlineMath(t)}</p>`
  const single = /^\$([^$]+)\$$/.exec(t)
  if (single && /\\displaystyle/.test(single[1])) return blockMath(single[1].replace(/\\displaystyle\s*/g, ''))
  return pieces(new InlineParser(t).parse({ ...plain(), bold: !!col?.bold }), false) || '<p></p>'
}

function tableHtml(name: string, inner: string): string {
  const need = name === 'tabularx' || name === 'tabular*' ? 2 : 1
  const args: string[] = []
  let i = 0
  for (let k = 0; k < need; k++) {
    while (/\s/.test(inner[i] ?? '')) i++
    if (inner[i] === '[') i = inner.indexOf(']', i) + 1 || inner.length
    while (/\s/.test(inner[i] ?? '')) i++
    if (inner[i] === '{') {
      const end = consumeGroup(inner, i)
      args.push(inner.slice(i + 1, end - 1))
      i = end
    }
  }
  const cols = parseColSpec(args[args.length - 1] ?? '')
  const rows = splitTable(inner.slice(i))
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const body = rows
    .map(
      (r) =>
        `<tr>${Array.from({ length: width }, (_, k) => `<td>${cellHtml(r[k] ?? '', cols[k])}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<table><tbody>${body}</tbody></table>`
}

function splitItems(inner: string): string[] {
  const parts: string[] = []
  const re = /\\(begin|end)\{[a-zA-Z*]+\}|\\item(?![a-zA-Z])/g
  let depth = 0
  let last = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(inner))) {
    if (m[1] === 'begin') depth++
    else if (m[1] === 'end') depth--
    else if (depth === 0) {
      if (last >= 0) parts.push(inner.slice(last, m.index))
      last = m.index + m[0].length
    }
  }
  if (last >= 0) parts.push(inner.slice(last))
  return parts
}

function findEnd(src: string, name: string, from: number): { start: number; stop: number } | null {
  const re = new RegExp(`\\\\(begin|end)\\{${escapeRegExp(name)}\\}`, 'g')
  re.lastIndex = from
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    depth += m[1] === 'begin' ? 1 : -1
    if (depth === 0) return { start: m.index, stop: m.index + m[0].length }
  }
  return null
}

function environment(name: string, inner: string, center: boolean): string {
  switch (name) {
    case 'center':
      return blocks(inner, true)
    case 'multicols':
    case 'minipage': {
      const t = inner.trimStart()
      return blocks(t.startsWith('{') ? t.slice(consumeGroup(t, 0)) : t, center)
    }
    case 'tabular':
    case 'tabularx':
    case 'tabular*':
    case 'longtable':
      return tableHtml(name, inner)
    case 'itemize':
    case 'enumerate':
    case 'description': {
      const tag = name === 'enumerate' ? 'ol' : 'ul'
      const items = splitItems(inner)
        .map((it) => `<li>${blocks(it.replace(/^\s*\[[^\]]*\]/, ''), center) || '<p></p>'}</li>`)
        .join('')
      return items ? `<${tag}>${items}</${tag}>` : ''
    }
    case 'quote':
    case 'quotation':
      return `<blockquote>${blocks(inner, center)}</blockquote>`
    case 'verbatim':
    case 'lstlisting':
      return `<pre><code>${esc(inner.replace(/^\n/, ''))}</code></pre>`
    case 'equation':
    case 'equation*':
    case 'displaymath':
      return blockMath(inner)
    case 'align':
    case 'align*':
    case 'gather':
    case 'gather*':
    case 'multline':
    case 'multline*':
    case 'flalign':
    case 'flalign*':
      return blockMath(`\\begin{${name}}${inner}\\end{${name}}`)
    default:
      // document, flushleft, flushright, abstract, figure, table
      return blocks(inner, center)
  }
}

/** Walks top-level environments; everything between them is inline text. */
function blocks(src: string, center: boolean): string {
  let out = ''
  let i = 0
  const re = /\\begin\{([a-zA-Z]+\*?)\}/g
  while (i < src.length) {
    let m: RegExpExecArray | null
    re.lastIndex = i
    do m = re.exec(src)
    while (m && !KNOWN_ENVS.has(m[1]))
    const end = m ? findEnd(src, m[1], re.lastIndex) : null
    if (!m || !end) {
      out += inlineHtml(src.slice(i), plain(), center)
      break
    }
    out += inlineHtml(src.slice(i, m.index), plain(), center)
    out += environment(m[1], src.slice(re.lastIndex, end.start), center)
    i = end.stop
  }
  return out
}

export function looksLikeLatexDocument(text: string): boolean {
  return /\\documentclass|\\begin\{document\}|\\begin\{(?:tabularx?|itemize|enumerate|center)\}|\\section\*?\{/.test(text)
}

export function latexDocumentToHtml(text: string): string {
  let src = text.replace(/\r\n/g, '\n').replace(/(^|[^\\])%.*(?:\n[ \t]*)?/g, '$1')
  const open = '\\begin{document}'
  const b = src.indexOf(open)
  if (b >= 0) {
    const e = src.lastIndexOf('\\end{document}')
    src = src.slice(b + open.length, e > b ? e : undefined)
  }
  return blocks(src, false) || `<p>${esc(text)}</p>`
}
