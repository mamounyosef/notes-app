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
import { CodeI, Pen, AlignLeft, AlignCenter, AlignRight, FitI } from '../components/Icons'
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
/** A block asks its cell for at most this much width; wider content is scaled down to fit. */
const MAX_NATURAL_W = 1000
/** Never shrink content below this; past it the block scrolls sideways. */
const MIN_SCALE = 0.3

type Drag = 'e' | 'w' | 's' | 'se' | 'sw'

function HtmlEmbedView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [code, setCode] = useState('')
  /** Live size while dragging a handle (display pixels). */
  const [drag, setDrag] = useState<{ w: number | null; h: number | null } | null>(null)
  const [focused, setFocused] = useState(editor.isFocused)
  const [doc, setDoc] = useState<string | null>(null)
  /** What the content measures at its own size (reported by the block). */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  /** Room the block has across, measured here. */
  const [room, setRoom] = useState(0)
  const frameId = useMemo(() => `w${Math.random().toString(36).slice(2, 10)}`, [])
  const themeKey = useThemeKey()

  const kind = kindOf(node.attrs.kind)
  const htmlSrc = fromBase64(node.attrs.src || '')
  // Diagrams sit in the note like a figure; pasted pages keep their own frame.
  const figure = kind !== 'html' || !looksLikeHtmlDocument(htmlSrc)
  const storedW = (node.attrs.width as number | null) || null
  const storedH = (node.attrs.height as number | null) || null
  const textAlign = node.attrs.textAlign || 'left'
  const active = selected && (focused || drag != null)

  /* ---- sizes ----
   * natural.w: the content's own width. Up to MAX_NATURAL_W the block asks
   * for that much room (the cell widens to make it); past that, or when you
   * set a width, the content is scaled down to fit, like a picture.
   */
  const natW = natural && natural.w > 0 ? natural.w : 0
  // A width saved by the old Center button (the whole cell) on content narrower than that: fit the content instead.
  const staleW = storedW != null && natW > 0 && natW < storedW - 8 && room > 0 && storedW >= room - 4
  const boxW = drag?.w ?? (staleW ? null : storedW) ?? null
  const wantW = boxW ?? (natW ? Math.min(natW, MAX_NATURAL_W) : null)
  const avail = Math.max(120, boxW ?? (room || 600))
  const scale = natW > avail + 2 ? Math.max(MIN_SCALE, avail / natW) : 1
  const innerW = scale < 1 ? natW : null
  const contentH = natural?.h ?? (doc ? 120 : 80)
  const displayH = drag?.h ?? storedH ?? Math.ceil(contentH * scale)
  const frameH = Math.ceil(displayH / scale)

  let justifyContent = 'flex-start'
  if (textAlign === 'center') justifyContent = 'center'
  if (textAlign === 'right') justifyContent = 'flex-end'

  const setAlign = (align: 'left' | 'center' | 'right') => {
    // Only the alignment: the block keeps fitting its content, so it can move inside the cell.
    updateAttributes({ textAlign: align })
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

  /* ---- room across: the cell's text width ---- */
  useEffect(() => {
    const host = wrapRef.current?.parentElement
    if (!host) return
    const measure = () => setRoom(host.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  /* ---- build what the frame shows (diagrams are drawn here, then themed) ---- */
  useEffect(() => {
    let live = true
    setNatural(null)
    buildWidgetDoc(kind, htmlSrc, currentTheme(wrapRef.current))
      .then((d) => live && setDoc(d))
      .catch((e) => live && setDoc(`<pre style="color:#e06c75">${String(e?.message || e)}</pre>`))
    return () => {
      live = false
    }
  }, [kind, htmlSrc, themeKey])

  /* ---- the block reports its own size ---- */
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || d.__widget !== frameId || e.source !== iframeRef.current?.contentWindow) return
      if (d.type === 'size' && typeof d.h === 'number') {
        const h = Math.max(30, Math.min(6000, Math.ceil(d.h)))
        const w = Math.max(0, Math.min(6000, Math.ceil(d.w || 0)))
        // Only content wider than its frame has a width of its own; a page that
        // fills whatever room it gets stays flexible (0). It only ever grows, so
        // content that is always a little wider than its frame cannot creep.
        const fixed = typeof d.vw === 'number' && w > d.vw + 2
        // Content narrower than its frame (and not made to fill it) asks only for its own width.
        const cw = Math.max(0, Math.ceil(Number(d.cw) || 0))
        const narrow = !fixed && cw > 0 && typeof d.vw === 'number' && cw < d.vw - 8
        setNatural((cur) => {
          const nw = fixed && (!cur || w > cur.w + 8) ? w : narrow ? cw : cur?.w ?? 0
          return cur && Math.abs(cur.h - h) < 2 && nw === cur.w ? cur : { w: nw, h }
        })
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [frameId])

  /** Measure again from scratch (after "fit" or a theme change). */
  const remeasure = () => {
    setNatural(null)
    setTimeout(() => iframeRef.current?.contentWindow?.postMessage({ __measure: true }, '*'), 60)
  }

  /* ---- resizing: right/left edge = width (content scales), bottom = height, corners = both ---- */
  const startDrag = useCallback(
    (e: React.PointerEvent, dir: Drag) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startY = e.clientY
      // The cell may be zoomed: work in the block's own pixels.
      const rect = wrapRef.current!.getBoundingClientRect()
      const zoom = rect.width / (wrapRef.current!.offsetWidth || rect.width) || 1
      const startW = wrapRef.current!.offsetWidth
      const startH = displayH
      const keepRatio = (dir === 'se' || dir === 'sw') && !storedH
      const sizeAt = (cx: number, cy: number) => {
        const dx = (cx - startX) / zoom
        const dy = (cy - startY) / zoom
        let w: number | null = null
        let h: number | null = null
        if (dir === 'e' || dir === 'se') w = startW + dx
        if (dir === 'w' || dir === 'sw') w = startW - dx
        if (w != null) w = Math.round(Math.max(160, Math.min(room || 4000, w)))
        if (dir === 's' || dir === 'se' || dir === 'sw') h = Math.round(Math.max(40, startH + dy))
        // Corners of a block that fits its content: keep its shape, like a picture.
        if (keepRatio && w != null) h = null
        return { w, h }
      }
      setDrag({ w: null, h: null })
      const move = (me: PointerEvent) => setDrag(sizeAt(me.clientX, me.clientY))
      const up = (ue: PointerEvent) => {
        el.releasePointerCapture?.(ue.pointerId)
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        const { w, h } = sizeAt(ue.clientX, ue.clientY)
        const patch: Record<string, any> = {}
        if (w != null) patch.width = w
        if (h != null) patch.height = h
        setDrag(null)
        if (Object.keys(patch).length) updateAttributes(patch)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [displayH, room, storedH, updateAttributes],
  )

  /** Back to fitting the content: its own width (scaled if needed) and full height. */
  const fit = () => {
    updateAttributes({ width: null, height: null })
    remeasure()
  }

  /* ---- edit the source ---- */
  const startEdit = () => {
    setCode(htmlSrc)
    setEditing(true)
  }

  const commitEdit = () => {
    setEditing(false)
    if (code.trim()) updateAttributes({ src: toBase64(code) })
  }

  const sized = storedW != null || storedH != null
  const label = drag ? `${Math.round(drag.w ?? wrapRef.current?.offsetWidth ?? 0)} × ${Math.round(drag.h ?? displayH)}${scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}` : null

  return (
    <NodeViewWrapper className="html-embed-wrapper" style={{ display: 'flex', justifyContent, width: '100%' }} data-drag-handle>
      <div
        ref={wrapRef}
        className={`html-embed ${figure ? 'html-embed-figure' : ''} ${(boxW ?? wantW ?? Infinity) < 260 ? 'html-embed-narrow' : ''} ${active ? 'html-embed-selected' : ''} ${drag ? 'resizing' : ''}`}
        style={{
          width: boxW ? `${boxW}px` : wantW ? `${wantW}px` : '100%',
          // Content up to MAX_NATURAL_W asks for its room, so the cell widens to show it at full size.
          minWidth: !boxW && wantW ? `${wantW}px` : undefined,
          maxWidth: boxW || !wantW ? '100%' : undefined,
        }}
      >
        <div className="html-embed-bar" style={{ height: BAR_H }}>
          <CodeI size={14} />
          <span className="html-embed-label">{KIND_LABEL[kind]}</span>
          {scale < 1 && <span className="html-embed-scale" title="Shown smaller to fit; drag the right edge or widen the cell to enlarge">{Math.round(scale * 100)}%</span>}
          <div style={{ flex: 1 }} />
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
            {sized && (
              <button className="html-embed-btn wide" title="Fit to the content again (or double click a resize handle)" onClick={fit}>
                <FitI size={13} /> Fit
              </button>
            )}
            <button className="html-embed-btn" title="Edit source" onClick={startEdit}>
              <Pen size={13} />
            </button>
          </div>
        </div>

        {!editing && doc != null && (
          <div className="html-embed-viewport" style={{ height: displayH, overflowX: scale <= MIN_SCALE && natW * scale > avail ? 'auto' : 'hidden' }}>
            <iframe
              ref={iframeRef}
              name={frameId}
              className={`html-embed-frame ${figure ? 'themed' : ''}`}
              srcDoc={doc}
              sandbox="allow-scripts"
              title={KIND_LABEL[kind]}
              style={{
                height: frameH,
                width: innerW ? `${innerW}px` : '100%',
                transform: scale < 1 ? `scale(${scale})` : undefined,
                transformOrigin: '0 0',
                pointerEvents: drag ? 'none' : undefined,
              }}
            />
          </div>
        )}
        {!editing && doc == null && <div className="html-embed-loading" style={{ height: displayH }}>Drawing…</div>}

        {editing && (
          <div className="html-embed-editor" style={{ height: Math.max(220, displayH) }}>
            <textarea className="html-embed-code" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoFocus />
            <div className="html-embed-editor-actions">
              <button className="html-embed-save" onClick={commitEdit}>Save</button>
              <button className="html-embed-cancel" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}

        {!editing && (
          <>
            <div className="html-embed-edge e" title="Drag to resize (double click: fit)" onPointerDown={(e) => startDrag(e, 'e')} onDoubleClick={fit} />
            <div className="html-embed-edge w" title="Drag to resize (double click: fit)" onPointerDown={(e) => startDrag(e, 'w')} onDoubleClick={fit} />
            <div className="html-embed-edge s" title="Drag to change the height (double click: fit)" onPointerDown={(e) => startDrag(e, 's')} onDoubleClick={fit} />
            <div className="html-embed-grip se" title="Drag to resize (double click: fit)" onPointerDown={(e) => startDrag(e, 'se')} onDoubleClick={fit} />
            <div className="html-embed-grip sw" title="Drag to resize (double click: fit)" onPointerDown={(e) => startDrag(e, 'sw')} onDoubleClick={fit} />
          </>
        )}
        {label && <div className="html-embed-size">{label}</div>}
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
