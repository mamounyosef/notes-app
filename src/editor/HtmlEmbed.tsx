/**
 * HtmlEmbed: a TipTap block that shows an HTML widget or a diagram in a
 * sandboxed iframe (see src/widgets/widget.ts for the kinds and libraries).
 *
 * Storage: `<div data-html-embed data-kind="mermaid" data-html-src="base64">`.
 * The source is base64 so TipTap never has to escape thousands of angle
 * brackets. With no stored height the block grows to fit what it shows; the
 * measured height stays on this screen and is never saved, so two computers
 * that measure differently never fight over it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewProps } from '@tiptap/react'
import { CodeI, Pen, AlignLeft, AlignCenter, AlignRight } from '../components/Icons'
import { buildWidgetDoc, currentTheme, fromBase64, KIND_LABEL, kindOf, looksLikeHtmlDocument, toBase64, type WidgetKind } from '../widgets/widget'

export { looksLikeHtmlDocument }

/** Changes whenever the app theme changes, so blocks redraw in the new colors. */
function useThemeKey() {
  const read = () => document.documentElement.getAttribute('data-theme') || ''
  const [key, setKey] = useState(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setKey(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    return () => mo.disconnect()
  }, [])
  return key
}

/* ------------------------------------------------------------------ *
 *  React NodeView
 * ------------------------------------------------------------------ */

const BAR_H = 26

function HtmlEmbedView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [code, setCode] = useState('')
  const [resizing, setResizing] = useState(false)
  const [currentWidth, setCurrentWidth] = useState<number | null>(null)
  const [currentHeight, setCurrentHeight] = useState<number | null>(null)
  const [focused, setFocused] = useState(editor.isFocused)
  const [doc, setDoc] = useState<string | null>(null)
  const [autoH, setAutoH] = useState<number | null>(null)
  const frameId = useMemo(() => `w${Math.random().toString(36).slice(2, 10)}`, [])
  const themeKey = useThemeKey()

  const kind = kindOf(node.attrs.kind)
  const htmlSrc = fromBase64(node.attrs.src || '')
  // Diagrams sit in the note like a figure; pasted pages keep their own frame.
  const figure = kind !== 'html' || !looksLikeHtmlDocument(htmlSrc)
  const stored = node.attrs.height as number | null
  const width = resizing && currentWidth != null ? currentWidth : (node.attrs.width || null)
  const frameH = resizing && currentHeight != null ? currentHeight : (stored || autoH || (doc ? 120 : 80))
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

  /* ---- build what the frame shows (diagrams are drawn here, then themed) ---- */
  useEffect(() => {
    let live = true
    buildWidgetDoc(kind, htmlSrc, currentTheme(wrapRef.current))
      .then((d) => live && setDoc(d))
      .catch((e) => live && setDoc(`<pre style="color:#e06c75">${String(e?.message || e)}</pre>`))
    return () => {
      live = false
    }
  }, [kind, htmlSrc, themeKey])

  /* ---- the block reports its own height ---- */
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || d.__widget !== frameId || e.source !== iframeRef.current?.contentWindow) return
      if (d.type === 'size' && typeof d.h === 'number') setAutoH(Math.max(40, Math.min(4000, Math.ceil(d.h))))
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [frameId])

  /* ---- corner resize (like ResizableImage) ---- */
  const onCornerPointerDown = useCallback((e: React.PointerEvent, corner: 'tl' | 'tr' | 'bl' | 'br') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)

    const startX = e.clientX
    const startY = e.clientY
    const startW = wrapRef.current?.offsetWidth || node.attrs.width || 500
    const startH = iframeRef.current?.offsetHeight || frameH

    const isLeft = corner[1] === 'l'
    const isTop = corner[0] === 't'

    const onMove = (me: PointerEvent) => {
      me.preventDefault()
      const dx = me.clientX - startX
      const dy = me.clientY - startY
      setCurrentWidth(Math.max(200, startW + (isLeft ? -dx : dx)))
      setCurrentHeight(Math.max(60, startH + (isTop ? -dy : dy)))
    }

    const onUp = (ue: PointerEvent) => {
      setResizing(false)
      const dx = ue.clientX - startX
      const dy = ue.clientY - startY
      updateAttributes({ width: Math.max(200, startW + (isLeft ? -dx : dx)), height: Math.max(60, startH + (isTop ? -dy : dy)) })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [node.attrs.width, frameH, updateAttributes])

  /* ---- edge resize (bottom + right) ---- */
  const onEdgePointerDown = useCallback((e: React.PointerEvent, dir: 's' | 'e' | 'se') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)

    const startX = e.clientX
    const startY = e.clientY
    const startW = wrapRef.current?.offsetWidth || node.attrs.width || 500
    const startH = iframeRef.current?.offsetHeight || frameH

    const onMove = (me: PointerEvent) => {
      me.preventDefault()
      if (dir === 's' || dir === 'se') setCurrentHeight(Math.max(60, startH + me.clientY - startY))
      if (dir === 'e' || dir === 'se') setCurrentWidth(Math.max(200, startW + me.clientX - startX))
    }

    const onUp = (ue: PointerEvent) => {
      setResizing(false)
      const patch: Record<string, any> = {}
      if (dir === 's' || dir === 'se') patch.height = Math.max(60, startH + ue.clientY - startY)
      if (dir === 'e' || dir === 'se') patch.width = Math.max(200, startW + ue.clientX - startX)
      updateAttributes(patch)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [node.attrs.width, frameH, updateAttributes])

  /* ---- edit the source ---- */
  const startEdit = () => {
    setCode(htmlSrc)
    setEditing(true)
  }

  const commitEdit = () => {
    setEditing(false)
    if (code.trim()) updateAttributes({ src: toBase64(code) })
  }

  return (
    <NodeViewWrapper className="html-embed-wrapper" style={{ display: 'flex', justifyContent, width: '100%' }} data-drag-handle>
      <div
        ref={wrapRef}
        className={`html-embed ${figure ? 'html-embed-figure' : ''} ${active ? 'html-embed-selected' : ''}`}
        style={{ width: width ? `${width}px` : '100%', maxWidth: '100%' }}
      >
        <div className="html-embed-bar" style={{ height: BAR_H }}>
          <CodeI size={14} />
          <span className="html-embed-label">{KIND_LABEL[kind]}</span>
          <div style={{ flex: 1 }} />
          {(active || figure) && (
            <div className="html-embed-actions" onMouseDown={(e) => e.stopPropagation()}>
              <button className={`html-embed-btn ${textAlign === 'left' ? 'active' : ''}`} title="Align left" onClick={() => setAlign('left')}>
                <AlignLeft size={13} />
              </button>
              <button className={`html-embed-btn ${textAlign === 'center' ? 'active' : ''}`} title="Center" onClick={() => setAlign('center')}>
                <AlignCenter size={13} />
              </button>
              <button className={`html-embed-btn ${textAlign === 'right' ? 'active' : ''}`} title="Align right" onClick={() => setAlign('right')}>
                <AlignRight size={13} />
              </button>
              <div className="html-embed-divider" />
              {stored != null && (
                <button className="html-embed-btn" title="Fit height to content" onClick={() => updateAttributes({ height: null })}>
                  ↕
                </button>
              )}
              <button className="html-embed-btn" title="Edit source" onClick={startEdit}>
                <Pen size={13} />
              </button>
            </div>
          )}
        </div>

        {!editing && doc != null && (
          <iframe
            ref={iframeRef}
            name={frameId}
            className={`html-embed-frame ${figure ? 'themed' : ''}`}
            srcDoc={doc}
            sandbox="allow-scripts"
            title={KIND_LABEL[kind]}
            style={{ height: frameH }}
          />
        )}
        {!editing && doc == null && <div className="html-embed-loading" style={{ height: frameH }}>Drawing…</div>}

        {editing && (
          <div className="html-embed-editor" style={{ height: Math.max(220, frameH) }}>
            <textarea className="html-embed-code" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoFocus />
            <div className="html-embed-editor-actions">
              <button className="html-embed-save" onClick={commitEdit}>Save</button>
              <button className="html-embed-cancel" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}

        {active && !editing && (
          <>
            {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => {
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
                    cursor: isTop === isLeft ? 'nwse-resize' : 'nesw-resize',
                  }}
                  title="Drag to resize"
                />
              )
            })}
            <div className="html-embed-edge-s" onPointerDown={(e) => onEdgePointerDown(e, 's')} />
            <div className="html-embed-edge-e" onPointerDown={(e) => onEdgePointerDown(e, 'e')} />
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
      /** Base64 source: HTML, Mermaid text, WaveDrom JSON or a Chart.js config. */
      src: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-html-src') || '',
        renderHTML: (a) => ({ 'data-html-src': a.src }),
      },
      /** What the source is (see WidgetKind). */
      kind: {
        default: 'html',
        parseHTML: (el) => kindOf(el.getAttribute('data-kind')),
        renderHTML: (a) => (a.kind && a.kind !== 'html' ? { 'data-kind': a.kind } : {}),
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
      /** Height of the content area in pixels, set by resizing; null fits the content. */
      height: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-height')
          return v ? parseInt(v, 10) : null
        },
        renderHTML: (a) => (a.height ? { 'data-height': String(a.height) } : {}),
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
    return ['div', mergeAttributes(HTMLAttributes, { 'data-html-embed': '' }), 'HTML Widget']
  },

  addNodeView() {
    return ReactNodeViewRenderer(HtmlEmbedView)
  },

  addCommands() {
    return {
      insertHtmlEmbed:
        (html: string, kind: WidgetKind = 'html') =>
        ({ commands }: any) =>
          commands.insertContent({
            type: this.name,
            attrs: { src: toBase64(html), kind },
          }),
    } as any
  },
})
