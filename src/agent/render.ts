/** Agent replies to safe HTML: Markdown, LaTeX via KaTeX, sanitized. */
import { marked } from 'marked'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { extractMath } from '../editor/markdown'

const cache = new Map<string, string>()

const ID = '[A-Za-z0-9_-]{4,40}'
const escAttr = (s: string) => s.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)
const ref = (label: string, page: string, cell?: string) =>
  `<a class="note-ref" href="#" data-page="${escAttr(page)}"${cell ? ` data-cell="${escAttr(cell)}"` : ''}>${label}</a>`

/**
 * Links to notes: [label](note:PAGE#CELL) or [label](note:PAGE) become chips that
 * open that page and show that cell. A bare note:PAGE#CELL gets a generic label.
 */
export function noteLinks(md: string): string {
  return md
    .replace(new RegExp(String.raw`\[([^\]\n]+)\]\(<?note:(${ID})(?:#(${ID}))?>?\)`, 'g'), (_m, label, page, cell) => ref(label, page, cell))
    .replace(new RegExp(String.raw`(^|[\s(])<?note:(${ID})(?:#(${ID}))?>?(?=[\s).,;:]|$)`, 'gm'), (_m, pre, page, cell) => `${pre}${ref('note', page, cell)}`)
}

export function renderMarkdown(md: string): string {
  const hit = cache.get(md)
  if (hit) return hit
  const { text, math } = extractMath(md || '')
  let html = marked.parse(noteLinks(text).replace(/==([^=\n]+)==/g, '<mark>$1</mark>'), { async: false, gfm: true, breaks: true }) as string
  math.forEach((m, i) => {
    let out: string
    try {
      out = katex.renderToString(m.latex, { displayMode: m.display, throwOnError: false, output: 'html' })
    } catch {
      out = `<code>${m.latex.replace(/</g, '&lt;')}</code>`
    }
    html = html.split(`xx0math${i}xx0`).join(out)
  })
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'object', 'embed'],
  })
  if (cache.size > 400) cache.clear()
  cache.set(md, clean)
  return clean
}
