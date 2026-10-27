import { marked } from 'marked'
import TurndownService from 'turndown'
import { toBase64 } from '../widgets/widget'
import { extractMath, PLACEHOLDER } from './mathExtract'
import { markdownSignals } from './pasteClassify'

export { extractMath }

export function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Heuristic: does this plain text look like Markdown worth converting? */
export function looksLikeMarkdown(text: string) {
  return markdownSignals(text) > 0
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
