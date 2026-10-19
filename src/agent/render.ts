/** Agent replies to safe HTML: Markdown, LaTeX via KaTeX, sanitized. */
import { marked } from 'marked'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { extractMath } from '../editor/markdown'

const cache = new Map<string, string>()

export function renderMarkdown(md: string): string {
  const hit = cache.get(md)
  if (hit) return hit
  const { text, math } = extractMath(md || '')
  let html = marked.parse(text.replace(/==([^=\n]+)==/g, '<mark>$1</mark>'), { async: false, gfm: true, breaks: true }) as string
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
