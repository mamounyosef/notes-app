/**
 * HtmlEmbed – a TipTap block node that renders a full HTML document inside
 * a sandboxed iframe.  The user pastes raw HTML source code and it appears
 * as a live, interactive widget inside the note.
 *
 * Storage: the HTML source is kept as a **base64** string in a
 * `data-html-src` attribute on a `<div data-html-embed>` element, so
 * TipTap's serialiser never needs to escape thousands of angle brackets.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewProps } from '@tiptap/react'
import { CodeI, Grip, Pen, X, AlignLeft, AlignCenter, AlignRight } from '../components/Icons'

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */

function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
}

function fromBase64(b64: string): string {
  try {
    return decodeURIComponent(escape(atob(b64)))
  } catch {
    return ''
  }
}

/** Quick sniff: does the plain-text look like a self-contained HTML page? */
export function looksLikeHtmlDocument(text: string): boolean {
  const t = text.trimStart().substring(0, 300).toLowerCase()
  return (
    t.startsWith('<!doctype html') ||
    t.startsWith('<html') ||
    (t.includes('<head') && t.includes('<body'))
  )
}

/* ------------------------------------------------------------------ *
 *  React NodeView
 * ------------------------------------------------------------------ */

function HtmlEmbedView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [code, setCode] = useState('')
  const [resizing, setResizing] = useState(false)
  const [currentWidth, setCurrentWidth] = useState<number | null>(null)
  const [currentHeight, setCurrentHeight] = useState<number | null>(null)
  const [focused, setFocused] = useState(editor.isFocused)

  const htmlSrc = fromBase64(node.attrs.src || '')
  const width = resizing && currentWidth != null ? currentWidth : (node.attrs.width || null)
  const height = resizing && currentHeight != null ? currentHeight : (node.attrs.height || 400)
  const active = selected && (focused || resizing)
  const textAlign = node.attrs.textAlign || 'left'

  let justifyContent = 'flex-start'
  if (textAlign === 'center') justifyContent = 'center'
  if (textAlign === 'right') justifyContent = 'flex-end'

  const setAlign = (align: 'left' | 'center' | 'right') => {
    const patch: Record<string, any> = { textAlign: align }
    if (!node.attrs.width && wrapRef.current) {
      patch.width = wrapRef.current.offsetWidth
    }
    updateAttributes(patch)
  }

  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    editor.on('focus', onFocus)
    editor.on('blur', onBlur)
    return () => {
      editor.off('focus', onFocus)
      editor.off('blur', onBlur)
    }
  }, [editor])

  /* ---- auto-size: measure iframe content after load ---- */
  const onIframeLoad = useCallback(() => {
    if (!iframeRef.current) return
    try {
      const doc = iframeRef.current.contentDocument
      if (!doc?.body) return

      const contentH = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) + 24
      const contentW = Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth)

      const patch: Record<string, any> = {}

      // Auto-height: always fit the content
      if (contentH > 60) {
        patch.height = contentH
      }

      // Auto-width: if the content needs more horizontal space, expand
      if (contentW > 100 && (!node.attrs.width || contentW > node.attrs.width)) {
        patch.width = contentW
      }

      if (Object.keys(patch).length > 0) {
        updateAttributes(patch)
      }
    } catch { /* cross-origin, ignore */ }
  }, [node.attrs.height, node.attrs.width, updateAttributes])

  /* ---- corner resize (like ResizableImage) ---- */
  const onCornerPointerDown = useCallback((e: React.PointerEvent, corner: 'tl' | 'tr' | 'bl' | 'br') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)

    const startX = e.clientX
    const startY = e.clientY
    const startW = wrapRef.current?.offsetWidth || node.attrs.width || 500
    const startH = node.attrs.height || 400

    const isLeft = corner[1] === 'l'
    const isTop = corner[0] === 't'

    const onMove = (me: PointerEvent) => {
      me.preventDefault()
      const dx = me.clientX - startX
      const dy = me.clientY - startY
      const newW = Math.max(200, startW + (isLeft ? -dx : dx))
      const newH = Math.max(80, startH + (isTop ? -dy : dy))
      setCurrentWidth(newW)
      setCurrentHeight(newH)
    }

    const onUp = (ue: PointerEvent) => {
      setResizing(false)
      const dx = ue.clientX - startX
      const dy = ue.clientY - startY
      const finalW = Math.max(200, startW + (isLeft ? -dx : dx))
      const finalH = Math.max(80, startH + (isTop ? -dy : dy))
      updateAttributes({ width: finalW, height: finalH })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [node.attrs.width, node.attrs.height, updateAttributes])

  /* ---- edge resize (bottom + right) ---- */
  const onEdgePointerDown = useCallback((e: React.PointerEvent, dir: 's' | 'e' | 'se') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)

    const startX = e.clientX
    const startY = e.clientY
    const startW = wrapRef.current?.offsetWidth || node.attrs.width || 500
    const startH = node.attrs.height || 400

    const onMove = (me: PointerEvent) => {
      me.preventDefault()
      if (dir === 's' || dir === 'se') {
        setCurrentHeight(Math.max(80, startH + me.clientY - startY))
      }
      if (dir === 'e' || dir === 'se') {
        setCurrentWidth(Math.max(200, startW + me.clientX - startX))
      }
    }

    const onUp = (ue: PointerEvent) => {
      setResizing(false)
      const patch: Record<string, any> = {}
      if (dir === 's' || dir === 'se') {
        patch.height = Math.max(80, startH + ue.clientY - startY)
      }
      if (dir === 'e' || dir === 'se') {
        patch.width = Math.max(200, startW + ue.clientX - startX)
      }
      updateAttributes(patch)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [node.attrs.width, node.attrs.height, updateAttributes])

  /* ---- edit raw source ---- */
  const startEdit = () => {
    setCode(htmlSrc)
    setEditing(true)
  }

  const commitEdit = () => {
    setEditing(false)
    if (code.trim()) {
      updateAttributes({ src: toBase64(code) })
    }
  }

  const cancelEdit = () => {
    setEditing(false)
  }

  return (
    <NodeViewWrapper
      className="html-embed-wrapper"
      style={{
        display: 'flex',
        justifyContent,
        width: '100%',
      }}
      data-drag-handle
    >
      <div
        ref={wrapRef}
        className={`html-embed ${active ? 'html-embed-selected' : ''}`}
        style={{
          width: width ? `${width}px` : '100%',
          height,
          maxWidth: 'none',
        }}
      >
        {/* label bar */}
        <div className="html-embed-bar">
          <CodeI size={14} />
          <span className="html-embed-label">HTML Widget</span>
          <div style={{ flex: 1 }} />
          {active && (
            <div className="html-embed-actions" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className={`html-embed-btn ${textAlign === 'left' ? 'active' : ''}`}
                title="Align left"
                onClick={() => setAlign('left')}
              >
                <AlignLeft size={13} />
              </button>
              <button
                className={`html-embed-btn ${textAlign === 'center' ? 'active' : ''}`}
                title="Center"
                onClick={() => setAlign('center')}
              >
                <AlignCenter size={13} />
              </button>
              <button
                className={`html-embed-btn ${textAlign === 'right' ? 'active' : ''}`}
                title="Align right"
                onClick={() => setAlign('right')}
              >
                <AlignRight size={13} />
              </button>
              <div className="html-embed-divider" />
              <button
                className="html-embed-btn"
                title="Edit HTML source"
                onClick={startEdit}
              >
                <Pen size={13} />
              </button>
            </div>
          )}
        </div>

        {/* iframe */}
        {!editing && (
          <iframe
            ref={iframeRef}
            className="html-embed-frame"
            srcDoc={htmlSrc}
            sandbox="allow-scripts"
            onLoad={onIframeLoad}
            title="HTML embed"
          />
        )}

        {/* code editor */}
        {editing && (
          <div className="html-embed-editor">
            <textarea
              className="html-embed-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              autoFocus
            />
            <div className="html-embed-editor-actions">
              <button className="html-embed-save" onClick={commitEdit}>Save</button>
              <button className="html-embed-cancel" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        )}

        {/* resize handles – visible when selected */}
        {active && !editing && (
          <>
            {/* corner handles */}
            {(['tl', 'tr', 'bl', 'br'] as const).map(corner => {
              const isTop = corner[0] === 't'
              const isLeft = corner[1] === 'l'
              return (
                <div
                  key={corner}
                  className="html-embed-corner"
                  onPointerDown={(e) => onCornerPointerDown(e, corner)}
                  style={{
                    top: isTop ? -6 : undefined,
                    bottom: !isTop ? -6 : undefined,
                    left: isLeft ? -6 : undefined,
                    right: !isLeft ? -6 : undefined,
                    cursor: (isTop === isLeft) ? 'nwse-resize' : 'nesw-resize',
                  }}
                  title="Drag to resize"
                />
              )
            })}
            {/* edge handles */}
            <div
              className="html-embed-edge-s"
              onPointerDown={(e) => onEdgePointerDown(e, 's')}
            />
            <div
              className="html-embed-edge-e"
              onPointerDown={(e) => onEdgePointerDown(e, 'e')}
            />
          </>
        )}
      </div>
    </NodeViewWrapper>
  )
}

/* ------------------------------------------------------------------ *
 *  TipTap Node definition
 * ------------------------------------------------------------------ */

export const HtmlEmbed = Node.create({
  name: 'htmlEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      /** Base64-encoded HTML source. */
      src: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-html-src') || '',
        renderHTML: (a) => ({ 'data-html-src': a.src }),
      },
      /** Rendered width in pixels (null = 100% of cell). */
      width: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-width')
          return v ? parseInt(v, 10) : null
        },
        renderHTML: (a) => (a.width ? { 'data-width': String(a.width) } : {}),
      },
      /** Rendered height in pixels. */
      height: {
        default: 400,
        parseHTML: (el) => {
          const v = el.getAttribute('data-height')
          return v ? parseInt(v, 10) : 400
        },
        renderHTML: (a) => ({ 'data-height': String(a.height) }),
      },
      /** Alignment: 'left' | 'center' | 'right' */
      textAlign: {
        default: 'left',
        parseHTML: (el) => el.getAttribute('data-align') || el.style.textAlign || 'left',
        renderHTML: (a) => (a.textAlign && a.textAlign !== 'left' ? { 'data-align': a.textAlign, style: `text-align: ${a.textAlign}` } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-html-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-html-embed': '' }),
      'HTML Widget',
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(HtmlEmbedView)
  },

  addCommands() {
    return {
      insertHtmlEmbed:
        (html: string) =>
        ({ commands }: any) =>
          commands.insertContent({
            type: this.name,
            attrs: { src: toBase64(html) },
          }),
    } as any
  },
})
