/**
 * Cell content as the agent reads and writes it: Markdown with LaTeX, plus
 * inline HTML for what Markdown has no syntax for (text color, highlight
 * color, font size, underline, alignment), so nothing is lost either way.
 */
import TurndownService from 'turndown'
import { markdownToHtml, extractMath, escapeAttr } from '../editor/markdown'
import { FENCE_OF, KIND_OF_FENCE, fromBase64, kindOf, toBase64 } from '../widgets/widget'

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })

td.addRule('math', {
  filter: (node) => node.nodeType === 1 && (node as HTMLElement).hasAttribute('data-latex'),
  replacement: (_c, node) => {
    const el = node as HTMLElement
    const tex = el.getAttribute('data-latex') || ''
    return el.tagName === 'DIV' ? `\n\n$$${tex}$$\n\n` : `$${tex}$`
  },
})
// Styled spans and colored highlights stay as HTML so their color survives.
td.addRule('styled', {
  filter: (node) => node.nodeName === 'SPAN' && Boolean((node as HTMLElement).getAttribute('style')),
  replacement: (content, node) => `<span style="${escapeAttr((node as HTMLElement).getAttribute('style') || '')}">${content}</span>`,
})
td.addRule('mark', {
  filter: ['mark'],
  replacement: (content, node) => {
    const c = (node as HTMLElement).getAttribute('data-color')
    return c ? `<mark data-color="${escapeAttr(c)}">${content}</mark>` : `==${content}==`
  },
})
td.addRule('underline', {
  filter: ['u'],
  replacement: (content) => `<u>${content}</u>`,
})
td.addRule('strike', {
  filter: ['s', 'del', 'strike'] as any,
  replacement: (content) => `~~${content}~~`,
})
td.addRule('checkbox', {
  filter: (node) => node.nodeName === 'LI' && (node as HTMLElement).getAttribute('data-type') === 'taskItem',
  replacement: (content, node) =>
    `- [${(node as HTMLElement).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.trim()}\n`,
})
td.addRule('listItem', {
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
td.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content) => ` ${content.replace(/\s*\n+\s*/g, ' ').trim().replace(/\|/g, '\\|')} |`,
})
td.addRule('tableRow', {
  filter: 'tr',
  replacement: (content, node) => {
    const row = `|${content}\n`
    const first = (node as HTMLElement).closest('table')?.querySelector('tr') === node
    if (!first) return row
    const cols = (node as HTMLElement).querySelectorAll('th, td').length
    return row + '|' + ' --- |'.repeat(cols) + '\n'
  },
})
td.addRule('table', {
  filter: 'table',
  replacement: (content) => `\n\n${content.replace(/\n+/g, '\n').trim()}\n\n`,
})
td.addRule('colgroup', { filter: ['colgroup', 'col'] as any, replacement: () => '' })
td.addRule('aligned', {
  filter: (node) =>
    ['P', 'H1', 'H2', 'H3', 'H4'].includes(node.nodeName) &&
    /text-align:\s*(center|right|justify)/.test((node as HTMLElement).getAttribute('style') || ''),
  replacement: (content, node) => {
    const el = node as HTMLElement
    const tag = el.nodeName.toLowerCase()
    return `\n\n<${tag} style="${escapeAttr(el.getAttribute('style') || '')}">${content}</${tag}>\n\n`
  },
})
td.addRule('image', {
  filter: 'img',
  replacement: (_c, node) => {
    const el = node as HTMLElement
    const src = el.getAttribute('src') || ''
    const w = el.getAttribute('width')
    return `![${el.getAttribute('alt') || 'image'}](${src}${w ? ` "width=${w}"` : ''})`
  },
})
td.addRule('columns', {
  filter: (node) => node.nodeType === 1 && (node as HTMLElement).getAttribute('data-type') === 'columns',
  replacement: (content, node) =>
    `\n\n[columns${(node as HTMLElement).getAttribute('data-divider') === 'true' ? ' divider' : ''}]\n${content}\n[/columns]\n\n`,
})
td.addRule('widget', {
  filter: (node) => node.nodeType === 1 && (node as HTMLElement).hasAttribute('data-html-embed'),
  replacement: (_c, node) => {
    const el = node as HTMLElement
    const kind = kindOf(el.getAttribute('data-kind'))
    const opts = [
      el.getAttribute('data-width') && `width=${el.getAttribute('data-width')}`,
      el.getAttribute('data-height') && `height=${el.getAttribute('data-height')}`,
      el.getAttribute('data-align') && `align=${el.getAttribute('data-align')}`,
    ].filter(Boolean)
    const body = fromBase64(el.getAttribute('data-html-src') || '')
    const fence = body.includes('```') ? '~~~~' : '```'
    return `\n\n${fence}${FENCE_OF[kind]}${opts.length ? ' ' + opts.join(' ') : ''}\n${body}\n${fence}\n\n`
  },
})
td.addRule('column', {
  filter: (node) => node.nodeType === 1 && (node as HTMLElement).getAttribute('data-type') === 'column',
  replacement: (content) => `\n[column]\n${content.trim()}\n[/column]\n`,
})

/** A cell's HTML as the agent reads it. */
const unattr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export function htmlToAgent(html: string): string {
  if (!html) return ''
  try {
    // Math nodes are empty elements that Turndown would drop, and it would
    // escape the backslashes of LaTeX: swap them for tokens and put them back.
    const math: string[] = []
    const prepared = html.replace(/<(span|div)\b[^>]*\bdata-latex="([^"]*)"[^>]*>[\s\S]*?<\/\1>/g, (_m, tag: string, tex: string) => {
      math.push(tag === 'div' ? `\n\n$$${unattr(tex)}$$\n\n` : `$${unattr(tex)}$`)
      return tag === 'div' ? `<p>MATHTOKEN${math.length - 1}X</p>` : `MATHTOKEN${math.length - 1}X`
    })
    let md = td.turndown(prepared)
    md = md.replace(/MATHTOKEN(\d+)X/g, (_m, i: string) => math[Number(i)])
    return md.replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
}

/** Plain text of a cell, for short previews. */
export function htmlToText(html: string): string {
  const d = document.createElement('div')
  d.innerHTML = html || ''
  return (d.textContent || '').replace(/\s+/g, ' ').trim()
}

const looksHtml = (s: string) => /^\s*<(p|h[1-6]|ul|ol|div|table|blockquote|pre|span|img)\b/i.test(s)

/**
 * What the agent writes, turned into cell HTML. Markdown is the normal form;
 * a full HTML fragment is taken as is.
 */
/**
 * Models sometimes double escape newlines in tool arguments, so a table
 * arrives as one line with a literal backslash n. Turn those back into line
 * breaks, leaving LaTeX like \nabla or \neq alone.
 */
function unescapeNewlines(s: string) {
  if (!s.includes('\\n')) return s
  const real = (s.match(/\n/g) || []).length
  const fake = (s.match(/\\n(?![a-z])/g) || []).length
  if (fake <= real) return s
  return s.replace(/\\n(?![a-z])/g, '\n').replace(/\\t(?![a-z])/g, '\t')
}

/**
 * Diagrams and widgets: ```mermaid, ```wavedrom, ```chart and ```widget fences
 * become HTML blocks. Optional settings after the name: width=600 height=300
 * align=center (height left out = fit the content).
 */
const WIDGET_FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(mermaid|wavedrom|chartjs|chart|html-widget|widget|kmap|karnaugh)\b([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm

function widgetBlock(lang: string, opts: string, body: string) {
  const kind = KIND_OF_FENCE[lang] || 'html'
  const attr = (k: string) => new RegExp(`\\b${k}\\s*=\\s*["']?([\\w.%-]+)`, 'i').exec(opts)?.[1]
  const width = parseInt(attr('width') || '', 10)
  const height = parseInt(attr('height') || '', 10)
  const align = attr('align')
  return (
    `<div data-html-embed=""${kind !== 'html' ? ` data-kind="${kind}"` : ''}` +
    `${width > 0 ? ` data-width="${width}"` : ''}${height > 0 ? ` data-height="${height}"` : ''}` +
    `${align && /^(center|right)$/.test(align) ? ` data-align="${align}"` : ''}` +
    ` data-html-src="${toBase64(body.replace(/\s+$/, ''))}">HTML Widget</div>`
  )
}

export function agentToHtml(text: string): string {
  const raw = unescapeNewlines(String(text ?? '').replace(/\r\n/g, '\n'))
  if (!raw.trim()) return ''
  if (!WIDGET_FENCE.test(raw)) return contentToHtml(raw)
  WIDGET_FENCE.lastIndex = 0
  const blocks: string[] = []
  const src = raw.replace(WIDGET_FENCE, (_m, _ind, _fence, lang: string, opts: string, body: string) => {
    blocks.push(widgetBlock(lang.toLowerCase(), opts, body))
    return `\n\nxxwidget${blocks.length - 1}xx\n\n`
  })
  return contentToHtml(src).replace(/(?:<p>\s*)?xxwidget(\d+)xx(?:\s*<\/p>)?/g, (_m, i: string) => blocks[Number(i)])
}

function contentToHtml(src: string): string {
  // Side by side columns: [columns][column]...[/column][column]...[/column][/columns];
  // [columns divider] draws the thick vertical line between them.
  if (/\[columns(\s+divider)?\]/.test(src)) {
    return src
      .split(/(\[columns(?:\s+divider)?\][\s\S]*?\[\/columns\])/)
      .map((part) => {
        const m = /^\[columns(\s+divider)?\]([\s\S]*)\[\/columns\]$/.exec(part)
        if (!m) return part.trim() ? contentToHtml(part) : ''
        const cols = [...m[2].matchAll(/\[column\]([\s\S]*?)\[\/column\]/g)].map(
          (c) => `<div data-type="column">${contentToHtml(c[1]) || '<p></p>'}</div>`,
        )
        return cols.length ? `<div data-type="columns"${m[1] ? ' data-divider="true"' : ''}>${cols.join('')}</div>` : ''
      })
      .join('')
  }
  if (looksHtml(src) && !/\n\s*[-*#>]|\$\$/.test(src)) return src
  // Highlights written as ==text== become <mark>.
  const { text: noMath, math } = extractMath(src)
  let prepared = noMath.replace(/==([^=\n]+)==/g, '<mark data-color="rgba(229,192,123,0.35)" style="background-color: rgba(229,192,123,0.35); color: inherit">$1</mark>')
  // Put the math back so markdownToHtml handles it the usual way.
  math.forEach((m, i) => {
    prepared = prepared.split(`xx0math${i}xx0`).join(m.display ? `$$${m.latex}$$` : `$${m.latex}$`)
  })
  // Display math alone in a paragraph would leave empty lines around it.
  return softenMarks(markdownToHtml(prepared))
    .replace(/<p>\s*(<div data-latex="[^"]*"><\/div>)\s*<\/p>/g, '$1')
    .replace(/(?:<br>\s*)?(<div data-latex="[^"]*"><\/div>)\s*<\/p>/g, '</p>$1')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/>\s*\n\s*</g, '><')
}

/** Solid highlight colors become translucent, so the text on them stays readable in every theme. */
export function softenMarks(html: string): string {
  return html.replace(/<mark data-color="#([0-9a-f]{6})"(?: style="[^"]*")?>/gi, (_m, hex: string) => {
    const n = parseInt(hex, 16)
    const c = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.35)`
    return `<mark data-color="${c}" style="background-color: ${c}; color: inherit">`
  })
}

/** Inline content (no wrapping paragraph), for replacements inside a line. */
export function agentInlineToHtml(text: string): string {
  const html = agentToHtml(text).trim()
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html)
  return m && !m[1].includes('<p>') ? m[1] : html
}
