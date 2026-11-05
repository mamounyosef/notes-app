/**
 * Cell content as the agent reads and writes it: Markdown with LaTeX, plus
 * inline HTML for what Markdown has no syntax for (text color, highlight
 * color, font size, underline, alignment), so nothing is lost either way.
 */
import TurndownService from 'turndown'
import { markdownToHtml, extractMath, escapeAttr } from '../editor/markdown'
import { FENCE_OF, KIND_OF_FENCE, fromBase64, kindOf, sniffKind, toBase64 } from '../widgets/widget'
import { BIG_SOURCE, keptStub } from './sourceEdit'

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', hr: '---' })

// The thick divider has no Markdown form: kept as its tag, so a rewrite of the cell keeps it thick.
td.addRule('thickRule', {
  filter: (node) => node.nodeName === 'HR' && (node as HTMLElement).classList.contains('thick-hr'),
  replacement: () => '\n\n<hr class="thick-hr">\n\n',
})

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
    const kind = sniffKind(kindOf(el.getAttribute('data-kind')), fromBase64(el.getAttribute('data-html-src') || ''))
    const opts = [
      el.getAttribute('data-width') && `width=${el.getAttribute('data-width')}`,
      el.getAttribute('data-height') && `height=${el.getAttribute('data-height')}`,
      el.getAttribute('data-align') && `align=${el.getAttribute('data-align')}`,
    ].filter(Boolean)
    const full = fromBase64(el.getAttribute('data-html-src') || '')
    // A big source stays out of every read, so one drawing cannot fill the model's context.
    const body = full.length > BIG_SOURCE ? keptStub([...el.ownerDocument.querySelectorAll('[data-html-embed]')].indexOf(el) + 1, full.length) : full
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
    const prepared = html.replace(/<(span|div)\b[^>]*\bdata-latex="([^"]*)"[^>]*>[\s\S]*?<\/\1>/g, (m: string, tag: string, tex: string) => {
      // A formula drawn bigger or smaller says so right after it: $$x$${scale=1.5}
      const s = parseFloat(/\sdata-scale="([^"]*)"/.exec(m)?.[1] || '')
      const size = s > 0 && s !== 1 ? `{scale=${s}}` : ''
      math.push(tag === 'div' ? `\n\n$$${unattr(tex)}$$${size}\n\n` : `$${unattr(tex)}$${size}`)
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
 * Diagrams and widgets: ```mermaid, ```wavedrom, ```chart, ```kmap, ```graphviz, ```tikz and ```widget fences
 * become HTML blocks. Optional settings after the name: width=600 height=300
 * align=center (height left out = fit the content).
 */
const WIDGET_FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(mermaid|wavedrom|chartjs|chart|html-widget|widget|kmap|karnaugh|graphviz|dot|tikz)\b([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm

function widgetBlock(lang: string, opts: string, body: string) {
  const kind = sniffKind(KIND_OF_FENCE[lang] || 'html', body)
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

/**
 * Models sometimes write a widget as bare HTML with its <style> / <script> and no
 * ```widget fence. The editor has no place for those tags, so the drawing would fall
 * apart into loose lines of text: the run of HTML lines around them becomes a widget.
 */
export function fenceBareWidgets(raw: string): string {
  if (!/<(?:style|script)\b/i.test(raw)) return raw
  return raw
    .split(/(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$)/m)
    .map((part, i) => (i % 3 ? part : fencePart(part)))
    .filter((_p, i) => i % 3 !== 2)
    .join('')
}

function fencePart(part: string): string {
  if (!/<(?:style|script)\b/i.test(part)) return part
  const lines = part.split('\n')
  const start = lines.findIndex((l) => /^[ \t]*<(?:div|section|article|main|figure|center|svg|style|script)\b/i.test(l))
  if (start < 0) return part
  let end = -1
  for (let i = lines.length - 1; i >= start; i--) {
    if (/<\/(?:script|style)>\s*$/i.test(lines[i])) { end = i; break }
  }
  if (end < 0) return part
  // Plain HTML lines right after the script (a closing </div>) belong to the drawing too.
  while (end + 1 < lines.length && /^[ \t]*<\/?[a-z][^\n]*>\s*$/i.test(lines[end + 1])) end++
  const body = lines.slice(start, end + 1).join('\n')
  if (!/<(?:style|script)\b/i.test(body)) return part
  return [...lines.slice(0, start), '```widget', body, '```', ...lines.slice(end + 1)].join('\n')
}

export function agentToHtml(text: string): string {
  const raw = fenceBareWidgets(unescapeNewlines(String(text ?? '').replace(/\r\n/g, '\n')))
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
  if (looksHtml(src) && !/\n\s*[-*#>]|\$\$/.test(src)) return inlineMarkdownInHtml(src)
  // Highlights written as ==text== become <mark>.
  const { text: noMath, math } = extractMath(src)
  let prepared = noMath.replace(/==([^=\n]+)==/g, '<mark data-color="rgba(229,192,123,0.35)" style="background-color: rgba(229,192,123,0.35); color: inherit">$1</mark>')
  // A styled line written as HTML (<p style="text-align: center">**Title**</p>) is passed through
  // untouched by Markdown, so its **bold** would show as stars: turn that emphasis into tags here.
  // Code blocks are left exactly as written.
  prepared = prepared
    .split(/(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$)/m)
    .map((part, i) => (i % 3 ? part : part.replace(/^[ \t]{0,3}<(p|h[1-6]|div|blockquote|span|li|td|th|strong|em)\b[^\n]*$/gim, (line) => inlineMarkdownInHtml(line))))
    .filter((_p, i) => i % 3 !== 2)
    .join('')
  // Put the math back so markdownToHtml handles it the usual way.
  math.forEach((m, i) => {
    // $$x$${scale=1.5} keeps a formula's size: carried through as a marker at the start of its LaTeX.
    prepared = prepared.replace(new RegExp(`xx0math${i}xx0(?:\\{\\s*(?:scale|size)\\s*=\\s*([\\d.]+)\\s*x?\\s*\\})?`, 'g'), (_t, s?: string) => {
      const scale = parseFloat(s || '')
      const tex = scale > 0 && scale !== 1 ? `${SCALE_MARK}${Math.min(4, Math.max(0.5, scale))}${SCALE_MARK}${m.latex}` : m.latex
      return m.display ? `$$${tex}$$` : `$${tex}$`
    })
  })
  // Display math alone in a paragraph would leave empty lines around it.
  return softenMarks(markdownToHtml(prepared))
    .replace(/<p>\s*(<div data-latex="[^"]*"><\/div>)\s*<\/p>/g, '$1')
    .replace(/(?:<br>\s*)?(<div data-latex="[^"]*"><\/div>)\s*<\/p>/g, '</p>$1')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/>\s*\n\s*</g, '><')
    .replace(new RegExp(`<(div|span) data-latex="${SCALE_MARK}([\\d.]+)${SCALE_MARK}`, 'g'), '<$1 data-scale="$2" style="--math-scale: $2" data-latex="')
}

const SCALE_MARK = 'zzmathscalezz'

/**
 * Models mix the two forms: <span style="color:...">**word**</span>. Markdown
 * emphasis left in the text of an HTML fragment becomes real tags; tags, code
 * and pre blocks are left alone.
 */
function inlineMarkdownInHtml(html: string): string {
  return html
    .split(/(<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>|<[^>]*>)/i)
    .map((part, i) =>
      i % 2
        ? part
        : part
            // Read back from a cell, emphasis written inside a styled tag shows escaped (\*\*word\*\*), and the model copies it.
            .replace(/\\\*\\\*(?=\S)((?:[^*\n\\]|\\(?!\*))*?\S)\\\*\\\*/g, '**$1**')
            .replace(/\\([*_~])/g, '$1')
            .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^\w_])__(?=\S)([^_\n]*?\S)__(?![\w_])/g, '$1<strong>$2</strong>')
            .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')
            .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<s>$1</s>'),
    )
    .join('')
}

/** Solid highlight colors become translucent, so the text on them stays readable in every theme. */
export function softenMarks(html: string): string {
  return html.replace(/<mark data-color="#([0-9a-f]{6})"(?: style="[^"]*")?>/gi, (_m, hex: string) => {
    const c = softColor(`#${hex}`)
    return `<mark data-color="${c}" style="background-color: ${c}; color: inherit">`
  })
}

/** "#e5c07b" → "rgba(229,192,123,0.35)"; anything else as given. */
export function softColor(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.35)`
}

/** Inline content (no wrapping paragraph), for replacements inside a line. */
export function agentInlineToHtml(text: string): string {
  const html = agentToHtml(text).trim()
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html)
  return m && !m[1].includes('<p>') ? m[1] : html
}
