import { marked } from 'marked'
import TurndownService from 'turndown'
import { toBase64 } from '../widgets/widget'

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
    if (m) {
      // On a line of its own it is a block of its own: inside a paragraph
      // ("formula:\n$$x$$\nwhere") it would leave empty paragraphs around it.
      const ownLine = (i === 0 || md[i - 1] === '\n') && /^[ \t]*(\n|$)/.test(rest.slice(m[0].length))
      if (ownLine) out += '\n\n'
      push(true, m[1])
      if (ownLine) out += '\n\n'
      i += m[0].length
      continue
    }

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

export function escapeAttr(s: string) {
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
    /^[ \t]*<svg\b/im,
  ].some((re) => re.test(text))
}

/** A raw <svg> drawing on its own lines (pasted from a chat). The editor has no svg node, so it would lose all but its text. */
const RAW_SVG = /^[ \t]*<svg\b[\s\S]*?<\/svg>[ \t]*$/gim
const SVG_PLACEHOLDER = (i: number) => `xx0svg${i}xx0`

export function markdownToHtml(md: string) {
  // Drawings first, so nothing inside them is read as Markdown or math: each becomes an HTML widget block.
  const svgs: string[] = []
  md = md.replace(RAW_SVG, (m) => `\n\n${SVG_PLACEHOLDER(svgs.push(m.trim()) - 1)}\n\n`)
  const { text, math } = extractMath(md)
  let html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string
  svgs.forEach((svg, idx) => {
    const block = `<div data-html-embed="" data-html-src="${toBase64(svg)}">HTML Widget</div>`
    html = html.replace(new RegExp(`(?:<p>\\s*)?${SVG_PLACEHOLDER(idx)}(?:\\s*</p>)?`), () => block)
  })
  math.forEach((m, idx) => {
    // A display formula alone in its paragraph replaces that paragraph.
    if (m.display) html = html.replace(new RegExp(`<p>\\s*${PLACEHOLDER(idx)}\\s*</p>`), PLACEHOLDER(idx))
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

// Tight lists ("- item" instead of "-   item" plus blank lines from the <p> inside).
// Rules added later win in Turndown, so task items are skipped here explicitly.
turndown.addRule('listItem', {
  filter: (node) => node.nodeName === 'LI' && (node as HTMLElement).getAttribute('data-type') !== 'taskItem',
  replacement: (content, node) => {
    const parent = node.parentNode as HTMLElement
    let prefix = '- '
    if (parent.nodeName === 'OL') {
      const start = Number(parent.getAttribute('start')) || 1
      prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `
    }
    const body = content.trim().replace(/\n\s*\n/g, '\n').replace(/\n/g, '\n' + ' '.repeat(prefix.length))
    return `${prefix}${body}\n`
  },
})
turndown.addRule('strike', {
  filter: ['s', 'del', 'strike'] as any,
  replacement: (content) => `~~${content}~~`,
})
// GFM tables: the first row becomes the header row.
turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content) => ` ${content.replace(/\s*\n+\s*/g, ' ').trim().replace(/\|/g, '\\|')} |`,
})
turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content, node) => {
    const row = `|${content}\n`
    const first = (node as HTMLElement).closest('table')?.querySelector('tr') === node
    if (!first) return row
    const cols = (node as HTMLElement).querySelectorAll('th, td').length
    return row + '|' + ' --- |'.repeat(cols) + '\n'
  },
})
turndown.addRule('table', {
  filter: 'table',
  replacement: (content) => `\n\n${content.replace(/\n+/g, '\n').trim()}\n\n`,
})
turndown.addRule('colgroup', {
  filter: ['colgroup', 'col'] as any,
  replacement: () => '',
})

export function htmlToMarkdown(html: string) {
  return turndown.turndown(html || '')
}
