/**
 * Markdown coming from an LLM chat carries LaTeX in four shapes:
 *   $x$   $$x$$   \( x \)   \[ x \]   plus \begin{...} environments.
 * The Markdown parser would eat the backslashes, so math is pulled out
 * first (skipping code, where a dollar sign is just a dollar sign),
 * parsed as placeholders, then put back as math nodes.
 * Pure (no DOM, no imports) so it can be unit tested in Node.
 */

export interface Extracted {
  text: string
  math: { display: boolean; latex: string }[]
}

export const PLACEHOLDER = (i: number) => `xx0math${i}xx0`

// Sticky patterns, tried at the current position only. None crosses a blank
// line: a stray "$$" must not swallow the paragraphs after it.
const NO_BLANK = '(?:(?!\\n[ \\t]*\\n)[\\s\\S])+?'
const FENCE_OPEN = /[ \t]*(`{3,}|~{3,})/y
const DISPLAY_DOLLAR = new RegExp(`\\$\\$(${NO_BLANK})\\$\\$`, 'y')
const DISPLAY_BRACKET = new RegExp(`\\\\\\[(${NO_BLANK})\\\\\\]`, 'y')
const ENVIRONMENT = /\\begin\{([a-zA-Z*]+)\}([\s\S]+?)\\end\{\1\}/y
const INLINE_PAREN = new RegExp(`\\\\\\((${NO_BLANK})\\\\\\)`, 'y')
// Inline $...$: no space just inside the delimiters and no digit right
// after the closing one, so prices like "$5 and $7" stay plain text.
const INLINE_DOLLAR = /\$([^\s$][^$\n]*?[^\s$\\]|[^\s$\\])\$(?![\d$])/y

const at = (re: RegExp, s: string, i: number) => {
  re.lastIndex = i
  return re.exec(s)
}

export function extractMath(md: string): Extracted {
  const math: Extracted['math'] = []
  let out = ''
  let i = 0

  const push = (display: boolean, latex: string) => {
    math.push({ display, latex: latex.trim() })
    out += PLACEHOLDER(math.length - 1)
  }

  while (i < md.length) {
    const lineStart = i === 0 || md[i - 1] === '\n'

    // Fenced code block (indented too, as inside a list item): copied through
    // untouched up to a closing fence of the same kind, or the end of the text.
    const fence = lineStart ? at(FENCE_OPEN, md, i) : null
    if (fence) {
      const run = fence[1]
      const close = new RegExp(`^[ \\t]*${run[0] === '`' ? '`' : '~'}{${run.length},}[ \\t]*$`, 'm')
      const lineEnd = md.indexOf('\n', i)
      const from = lineEnd === -1 ? md.length : lineEnd + 1
      const m = close.exec(md.slice(from))
      const stop = m ? from + m.index + m[0].length : md.length
      out += md.slice(i, stop)
      i = stop
      continue
    }

    // Inline code span: closed by a run of exactly as many backticks. An
    // unclosed run is a literal backtick, not "the rest is code".
    if (md[i] === '`') {
      let n = 1
      while (md[i + n] === '`') n++
      const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, 'g')
      close.lastIndex = i + n
      const m = close.exec(md)
      const stop = m ? m.index + n : i + n
      out += md.slice(i, stop)
      i = stop
      continue
    }

    // An escaped dollar is a literal dollar sign.
    if (md[i] === '\\' && md[i + 1] === '$') {
      out += '\\$'
      i += 2
      continue
    }

    let m = at(DISPLAY_DOLLAR, md, i)
    if (m) {
      // On a line of its own it is a block of its own: inside a paragraph
      // ("formula:\n$$x$$\nwhere") it would leave empty paragraphs around it.
      const after = md.slice(i + m[0].length, md.indexOf('\n', i + m[0].length) >>> 0)
      const ownLine = lineStart && !after.trim()
      if (ownLine) out += '\n\n'
      push(true, m[1])
      if (ownLine) out += '\n\n'
      i += m[0].length
      continue
    }

    m = at(DISPLAY_BRACKET, md, i)
    if (m) { push(true, m[1]); i += m[0].length; continue }

    m = at(ENVIRONMENT, md, i)
    if (m) { push(true, m[0]); i += m[0].length; continue }

    m = at(INLINE_PAREN, md, i)
    if (m) { push(false, m[1]); i += m[0].length; continue }

    m = at(INLINE_DOLLAR, md, i)
    if (m) { push(false, m[1]); i += m[0].length; continue }

    out += md[i]
    i++
  }

  return { text: out, math }
}
