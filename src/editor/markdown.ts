import { marked } from 'marked'
import TurndownService from 'turndown'

/**
 * Markdown coming from an LLM chat carries LaTeX in four shapes:
 *   $x$   $$x$$   \( x \)   \[ x \]   plus \begin{...} environments.
 * The Markdown parser would eat the backslashes, so math is pulled out
 * first (skipping code, where a dollar sign is just a dollar sign),
 * parsed as placeholders, then put back as math nodes.
 */

interface Extracted {
  text: string
  math: { display: boolean; latex: string }[]
}

const PLACEHOLDER = (i: number) => `xx0math${i}xx0`

export function extractMath(md: string): Extracted {
  const math: Extracted['math'] = []
  let out = ''
  let i = 0

  const push = (display: boolean, latex: string) => {
    math.push({ display, latex: latex.trim() })
    out += PLACEHOLDER(math.length - 1)
  }

  while (i < md.length) {
    // Fenced code block: copy through untouched.
    const fence = /^(```|~~~)/.exec(md.slice(i))
    if ((i === 0 || md[i - 1] === '\n') && fence) {
      const end = md.indexOf(`\n${fence[1]}`, i + 3)
      const stop = end === -1 ? md.length : end + 1 + fence[1].length
      out += md.slice(i, stop)
      i = stop
      continue
    }
    // Inline code span.
    if (md[i] === '`') {
      const close = md.indexOf('`', i + 1)
      const stop = close === -1 ? md.length : close + 1
      out += md.slice(i, stop)
      i = stop
      continue
    }
    const rest = md.slice(i)

    let m = /^\$\$([\s\S]+?)\$\$/.exec(rest)
    if (m) { push(true, m[1]); i += m[0].length; continue }

    m = /^\\\[([\s\S]+?)\\\]/.exec(rest)
    if (m) { push(true, m[1]); i += m[0].length; continue }

    m = /^\\begin\{([a-z*]+)\}([\s\S]+?)\\end\{\1\}/.exec(rest)
    if (m) { push(true, m[0]); i += m[0].length; continue }

    m = /^\\\(([\s\S]+?)\\\)/.exec(rest)
    if (m) { push(false, m[1]); i += m[0].length; continue }

    // Inline $...$: no space just inside the delimiters and no digit right
    // after the closing one, so prices like "$5 and $7" stay plain text.
    m = /^\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$(?![\d$])/.exec(rest)
    if (m) { push(false, m[1]); i += m[0].length; continue }

    out += md[i]
    i++
  }

  return { text: out, math }
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Heuristic: does this plain text look like Markdown worth converting? */
export function looksLikeMarkdown(text: string) {
  if (!text || text.length < 2) return false
  return [
    /^#{1,6}\s+\S/m,
    /^\s*[-*+]\s+\S/m,
    /^\s*\d+\.\s+\S/m,
    /^\s*>\s+\S/m,
    /```/,
    /\*\*[^*\n]+\*\*/,
    /\[[^\]]+\]\([^)]+\)/,
    /^\|.+\|\s*$/m,
    /\$\$?[^$\n]+\$\$?/,
    /\\\(|\\\[|\\begin\{/,
    /^---$/m,
  ].some((re) => re.test(text))
}

export function markdownToHtml(md: string) {
  const { text, math } = extractMath(md)
  let html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string
  math.forEach((m, idx) => {
    const tag = m.display
      ? `<div data-latex="${escapeAttr(m.latex)}"></div>`
      : `<span data-latex="${escapeAttr(m.latex)}"></span>`
    html = html.split(PLACEHOLDER(idx)).join(tag)
  })
  return html
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.addRule('math', {
  filter: (node) => node.nodeType === 1 && (node as HTMLElement).hasAttribute('data-latex'),
  replacement: (_c, node) => {
    const el = node as HTMLElement
    const tex = el.getAttribute('data-latex') || ''
    return el.tagName === 'DIV' ? `\n\n$$${tex}$$\n\n` : `$${tex}$`
  },
})
turndown.addRule('highlight', {
  filter: ['mark'],
  replacement: (content) => `==${content}==`,
})
turndown.addRule('checkbox', {
  filter: (node) => node.nodeName === 'LI' && (node as HTMLElement).getAttribute('data-type') === 'taskItem',
  replacement: (content, node) =>
    `- [${(node as HTMLElement).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.trim()}\n`,
})

export function htmlToMarkdown(html: string) {
  return turndown.turndown(html || '')
}
