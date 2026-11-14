/**
 * Shows a cell's content without an editor: far lighter than one TipTap
 * editor per cell, which matters on a slow phone. Math is drawn with KaTeX,
 * pictures load lazily (and appear once they arrive from the cloud), check
 * boxes can be ticked right here, links open, embeds become a tap-to-open card.
 */
import React, { memo, useLayoutEffect, useRef } from 'react'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { migrateLegacyHtml, stripMathDelimiters } from './htmlUtil'
import { vault } from '../sync/backend'

const mathCache = new Map<string, string>()
function mathHtml(latex: string, display: boolean): string {
  const key = (display ? 'D' : 'I') + latex
  let out = mathCache.get(key)
  if (out === undefined) {
    const t = stripMathDelimiters(latex)
    try {
      out = t ? katex.renderToString(t, { displayMode: display, throwOnError: false, output: 'html' }) : '<span class="math-empty">[LaTeX]</span>'
    } catch {
      out = t
    }
    if (mathCache.size > 800) mathCache.clear()
    mathCache.set(key, out)
  }
  return out
}

const cleanCache = new Map<string, string>()
function clean(html: string): string {
  let out = cleanCache.get(html)
  if (out === undefined) {
    out = DOMPurify.sanitize(migrateLegacyHtml(html || ''), {
      ADD_ATTR: ['target', 'data-latex', 'data-type', 'data-checked', 'data-html-src', 'data-kind', 'data-scale', 'data-width', 'data-divider', 'data-edit', 'checked'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style'],
    })
    if (cleanCache.size > 400) cleanCache.clear()
    cleanCache.set(html, out)
  }
  return out
}

/** Pictures waiting for their file: redrawn when it arrives. */
const waiting = new Map<string, Set<HTMLImageElement>>()
vault.on((ev) => {
  if (ev.type !== 'asset') return
  const imgs = waiting.get(ev.name)
  if (!imgs) return
  waiting.delete(ev.name)
  for (const img of imgs) {
    if (!img.isConnected) continue
    img.classList.remove('missing')
    const src = img.getAttribute('src') || ''
    img.src = src.split('?')[0] + '?v=' + Date.now()
  }
})

function enhance(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-latex]').forEach((el) => {
    const display = el.tagName === 'DIV'
    el.classList.add(display ? 'math-block' : 'math-inline')
    const scale = el.getAttribute('data-scale')
    if (scale) el.style.setProperty('--math-scale', scale)
    el.innerHTML = `<${display ? 'div' : 'span'} class="math-render">${mathHtml(el.getAttribute('data-latex') || '', display)}</${display ? 'div' : 'span'}>`
  })
  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    img.loading = 'lazy'
    img.decoding = 'async'
    img.draggable = false
    img.addEventListener(
      'error',
      () => {
        img.classList.add('missing')
        const m = /\/([A-Za-z0-9._-]+?)(\?.*)?$/.exec(img.getAttribute('src') || '')
        if (!m) return
        const set = waiting.get(m[1]) || new Set()
        set.add(img)
        waiting.set(m[1], set)
      },
      { once: true },
    )
  })
  root.querySelectorAll<HTMLElement>('div[data-html-embed], div[data-html-src]').forEach((el) => {
    const kind = el.getAttribute('data-kind') || 'html'
    const card = document.createElement('div')
    card.className = 'm-embed-card'
    card.dataset.embed = '1'
    card.innerHTML = `<b>${kind === 'html' ? 'Interactive block' : kind[0].toUpperCase() + kind.slice(1)}</b><span>Shown on the computer. Open the page there to use it.</span>`
    el.replaceWith(card)
  })
  root.querySelectorAll<HTMLInputElement>('ul[data-type="taskList"] input[type="checkbox"]').forEach((cb) => {
    const li = cb.closest('li')
    cb.checked = li?.getAttribute('data-checked') === 'true'
  })
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  })
}

interface Props {
  html: string
  className?: string
  style?: React.CSSProperties
  /** A check box at this position (n-th task item in the cell) was tapped. */
  onToggleTask?(index: number): void
  /** A link to another note was tapped. */
  onNoteLink?(href: string): void
}

function StaticHtmlInner({ html, className, style, onToggleTask, onNoteLink }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onToggleTask, onNoteLink })
  handlers.current = { onToggleTask, onNoteLink }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = clean(html)
    enhance(el)
  }, [html])

  return (
    <div className="rich">
    <div
      ref={ref}
      className={`m-static ProseMirror ${className || ''}`}
      style={style}
      onClick={(e) => {
        const t = e.target as HTMLElement
        const cb = t.closest('input[type="checkbox"]') as HTMLInputElement | null
        if (cb && ref.current) {
          e.stopPropagation()
          e.preventDefault()
          const all = [...ref.current.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]')]
          handlers.current.onToggleTask?.(all.indexOf(cb))
          return
        }
        const a = t.closest('a[href]') as HTMLAnchorElement | null
        if (a) {
          e.stopPropagation()
          e.preventDefault()
          const href = a.getAttribute('href') || ''
          if (/^note:/i.test(href)) handlers.current.onNoteLink?.(href)
          else if (/^(https?|mailto):/i.test(href)) window.open(href, '_blank')
        }
      }}
    />
    </div>
  )
}

export const StaticHtml = memo(StaticHtmlInner, (a, b) => a.html === b.html && a.className === b.className && a.style === b.style)

/** Flips the n-th check box of a cell's HTML. */
export function toggleTaskInHtml(html: string, index: number): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const items = [...doc.querySelectorAll('ul[data-type="taskList"] > li')]
  const li = items[index]
  if (!li) return html
  const on = li.getAttribute('data-checked') !== 'true'
  li.setAttribute('data-checked', String(on))
  const input = li.querySelector('input[type="checkbox"]')
  if (input) {
    if (on) input.setAttribute('checked', 'checked')
    else input.removeAttribute('checked')
  }
  return doc.body.innerHTML
}
