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
import { createPortal } from 'react-dom'
import { CodeI, Pen, AlignLeft, AlignCenter, AlignRight, FitI, ExternalI, MoreI, GlobeI, Download, ImageI, Copy } from '../components/Icons'
import { useStore } from '../store'
import { buildWidgetDoc, currentTheme, fromBase64, KIND_LABEL, kindOf, looksLikeHtmlDocument, sniffKind, toBase64, type WidgetKind } from '../widgets/widget'

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
 *  Outside the app: open in a browser, save, copy
 * ------------------------------------------------------------------ */

const desk = () => (window as any).notes as any

/** A name for the page and its file: its own title or first heading, else the note page's title. */
function widgetName(src: string, kind: WidgetKind, pageTitle: string): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  const own = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] || /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(src)?.[1] || ''
  const t = strip(own).slice(0, 70)
  if (t) return t
  const page = (pageTitle || '').trim()
  return page ? `${page} - ${KIND_LABEL[kind]}` : KIND_LABEL[kind]
}

interface MenuItem {
  label: string
  hint?: string
  icon: React.ReactNode
  onClick: () => void
}

/** A small menu under the bar's "more" button; drawn over everything, closes on any click outside or Esc. */
function WidgetMenu({ anchor, items, onClose }: { anchor: DOMRect; items: (MenuItem | null)[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as globalThis.Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true), 0)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  const W = 236
  const left = Math.max(8, Math.min(window.innerWidth - W - 8, anchor.right - W))
  const top = Math.min(anchor.bottom + 4, window.innerHeight - 8 - items.length * 32)
  return createPortal(
    <div ref={ref} className="html-embed-menu" style={{ left, top, width: W }} onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it ? (
          <button
            key={i}
            className="html-embed-menu-item"
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            <span className="html-embed-menu-icon">{it.icon}</span>
            <span className="html-embed-menu-label">{it.label}</span>
            {it.hint && <span className="html-embed-menu-hint">{it.hint}</span>}
          </button>
        ) : (
          <div key={i} className="html-embed-menu-sep" />
        ),
      )}
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ *
 *  React NodeView
 * ------------------------------------------------------------------ */

const BAR_H = 26
/** A block asks its cell for at most this much width; wider content is scaled down to fit. */
const MAX_NATURAL_W = 1000
/** Never shrink content below this; past it the block scrolls sideways. */
const MIN_SCALE = 0.3
/** A figure with room to spare grows up to this much, so a fresh diagram is not small in a wide cell. */
const FIGURE_GROW = 1.4
/** How far a figure can be enlarged by dragging its edge. */
const FIGURE_MAX = 3

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

  const htmlSrc = fromBase64(node.attrs.src || '')
  const kind = sniffKind(kindOf(node.attrs.kind), htmlSrc)
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
  const avail = Math.max(120, boxW ?? (room || 600))
  // Static figures zoom themselves inside the frame so small text stays sharp,
  // which also lets them grow; live pages and charts are scaled from outside,
  // as their own pointer and canvas code expects, and only ever shrink.
  const selfZoom = kind !== 'html' && kind !== 'chart'
  const fitScale = natW > avail + 2 ? Math.max(MIN_SCALE, avail / natW) : 1
  const scale = !selfZoom || !natW
    ? fitScale
    : boxW != null
      ? Math.min(FIGURE_MAX, Math.max(MIN_SCALE, boxW / natW))
      : fitScale === 1 && room > 0
        ? Math.max(1, Math.min(FIGURE_GROW, (room - 4) / natW))
        : fitScale
  const wantW = boxW ?? (natW ? (scale > 1 ? Math.floor(natW * scale) : Math.min(natW, MAX_NATURAL_W)) : null)
  const innerW = scale !== 1 ? natW : null
  const contentH = natural?.h ?? (doc ? 120 : 80)
  const displayH = drag?.h ?? storedH ?? Math.ceil(contentH * scale)
  const frameH = selfZoom ? displayH : Math.ceil(displayH / scale)
  /* ---- sharp at any page zoom ----
   * The page is zoomed with a CSS transform, which would scale the frame's
   * finished picture (blurry or jagged). Instead the frame is laid out at its
   * size on screen, undone by the opposite transform, and its content zooms
   * itself to match, so text and lines are drawn at the pixels they show at.
   * Charts draw on a canvas at their own size, so they keep the old way.
   */
  const pageZoom = useStore((s) => s.zoom)
  const [onCanvas, setOnCanvas] = useState(false)
  useEffect(() => setOnCanvas(!!wrapRef.current?.closest('.canvas')), [])
  const cz = onCanvas && pageZoom > 0 ? pageZoom : 1
  const crisp = kind !== 'chart'
  const innerZoom = crisp ? scale * cz : selfZoom ? scale : null

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

  useEffect(() => {
    if (innerZoom != null) iframeRef.current?.contentWindow?.postMessage({ __zoom: innerZoom }, '*')
  }, [innerZoom, doc])

  /* ---- right drag / right click inside the block act on the page, as on any cell ---- */
  useEffect(() => {
    let start: { x: number; y: number; buttons: number } | null = null
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      const f = iframeRef.current
      if (!d || d.__widget !== frameId || !f || e.source !== f.contentWindow) return
      if (d.type !== 'pan' && d.type !== 'menu') return
      const r = f.getBoundingClientRect()
      const x = r.left + (Number(d.fx) || 0) * r.width
      const y = r.top + (Number(d.fy) || 0) * r.height
      const ptr = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }
      if (d.type === 'menu') {
        f.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 0, clientX: x, clientY: y }))
      } else if (d.phase === 'down') {
        const button = d.button === 1 ? 1 : 2
        start = { x, y, buttons: button === 1 ? 4 : 2 }
        f.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, button, buttons: start.buttons, clientX: x, clientY: y }))
      } else if (start && d.phase === 'move') {
        window.dispatchEvent(new PointerEvent('pointermove', { ...ptr, button: -1, buttons: start.buttons, clientX: start.x + (Number(d.dx) || 0), clientY: start.y + (Number(d.dy) || 0) }))
      } else if (start && d.phase === 'up') {
        window.dispatchEvent(new PointerEvent('pointerup', { ...ptr, button: start.buttons === 4 ? 1 : 2, buttons: 0, clientX: start.x, clientY: start.y }))
        start = null
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

  /* ---- outside the app ---- */
  const pageTitle = useStore((s) => (s as any).page?.title as string | undefined) || ''
  const canDesk = Boolean(desk()?.widget)
  const [menu, setMenu] = useState<DOMRect | null>(null)
  /**
   * A figure's bar floats in its own layer just above the block (below it at the top of the window),
   * so it never covers the widget's own buttons and no cell can clip it.
   */
  const [hover, setHover] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const hoverOn = () => {
    clearTimeout(hoverTimer.current)
    setHover(true)
  }
  const hoverOff = () => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHover(false), 220)
  }
  const [barPos, setBarPos] = useState<{ top: number; right: number } | null>(null)
  const placeBar = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const h = BAR_H + 2
    const top = Math.round(r.top - h >= 0 ? r.top - h : r.bottom)
    const right = Math.round(Math.max(0, window.innerWidth - r.right))
    setBarPos((p) => (p && p.top === top && p.right === right ? p : { top, right }))
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; file?: string; bad?: boolean } | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout>>()
  const say = (text: string, file?: string, bad?: boolean) => {
    setNote({ text, file, bad })
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), file ? 6000 : 2800)
  }
  useEffect(() => () => clearTimeout(noteTimer.current), [])
  const name = () => widgetName(htmlSrc, kind, pageTitle)
  const theme = () => currentTheme(wrapRef.current)
  /** The block as a page of its own, in the app's current colors. */
  const pageDoc = () => buildWidgetDoc(kind, htmlSrc, theme(), { opaque: figure, standalone: { title: name() } })
  const run = async (what: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await what()
    } catch (e: any) {
      say(String(e?.message || e), undefined, true)
    } finally {
      setBusy(false)
    }
  }

  const openIn = (browser: 'chrome' | 'default') =>
    run(async () => {
      const r = await desk().widget.open(await pageDoc(), name(), browser)
      if (!r.ok) return say(r.error || 'Could not open it', undefined, true)
      say(r.browser === 'chrome' ? 'Opened in Chrome' : r.browser?.includes('not found') ? 'Chrome not found: opened in your default browser' : 'Opened in your browser')
    })

  const saved = (file: string | null) => {
    if (file) say(`Saved ${file.split(/[\\/]/).pop()}`, file)
  }

  const savePage = () => run(async () => saved(await desk().widget.save(name(), 'html', await pageDoc(), false)))

  /** A picture of the block at its own width (up to 3000px tall). */
  const picture = async () => {
    const width = Math.round(Math.max(320, Math.min(1600, natW || wrapRef.current?.offsetWidth || 760)))
    const html = await buildWidgetDoc(kind, htmlSrc, theme(), { opaque: true })
    const shot = await desk().agent.renderWidget({ html, width })
    if (!shot?.ok || !shot.png) throw new Error(shot?.error || 'Could not draw the picture')
    return shot.png as string
  }
  const savePng = () => run(async () => saved(await desk().widget.save(name(), 'png', await picture(), true)))
  const copyPng = () =>
    run(async () => {
      const bytes = Uint8Array.from(atob(await picture()), (c) => c.charCodeAt(0))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
      say('Picture copied')
    })

  /** Diagrams are SVG already: save that, sharp at any size. */
  const isDiagram = kind !== 'html' && kind !== 'chart'
  const saveSvg = () =>
    run(async () => {
      const doc = new DOMParser().parseFromString(await buildWidgetDoc(kind, htmlSrc, theme(), { opaque: true }), 'text/html')
      const svg = doc.querySelector('.w-diagram svg')
      if (!svg) throw new Error('No drawing to save')
      if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      saved(await desk().widget.save(name(), 'svg', `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`, false))
    })

  const copySource = () =>
    run(async () => {
      await navigator.clipboard.writeText(htmlSrc)
      say('Source copied')
    })

  const menuItems: (MenuItem | null)[] = [
    { label: 'Open in Chrome', hint: 'Click title', icon: <ExternalI size={14} />, onClick: () => openIn('chrome') },
    { label: 'Open in default browser', hint: 'Ctrl+click', icon: <GlobeI size={14} />, onClick: () => openIn('default') },
    null,
    { label: 'Save as web page (.html)…', icon: <Download size={14} />, onClick: savePage },
    { label: 'Save as picture (.png)…', icon: <ImageI size={14} />, onClick: savePng },
    isDiagram ? { label: 'Save as vector (.svg)…', icon: <ImageI size={14} />, onClick: saveSvg } : null,
    null,
    { label: 'Copy as picture', icon: <Copy size={14} />, onClick: copyPng },
    { label: 'Copy source', icon: <CodeI size={14} />, onClick: copySource },
  ].filter((it, i, a) => it || (a[i - 1] && i < a.length - 1)) as (MenuItem | null)[]

  const floatBar = figure && !editing && (hover || active || Boolean(menu || busy || note))
  useEffect(() => {
    if (!floatBar) return
    placeBar()
    // Follow the block while the page scrolls, zooms or resizes.
    let raf = 0
    const tick = () => {
      placeBar()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [floatBar, placeBar])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const sized = storedW != null || storedH != null
  const label = drag ? `${Math.round(drag.w ?? wrapRef.current?.offsetWidth ?? 0)} × ${Math.round(drag.h ?? displayH)}${scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}` : null

  return (
    <NodeViewWrapper className="html-embed-wrapper" style={{ display: 'flex', justifyContent, width: '100%' }} data-drag-handle>
      <div
        ref={wrapRef}
        className={`html-embed ${figure ? 'html-embed-figure' : ''} ${(boxW ?? wantW ?? Infinity) < 260 ? 'html-embed-narrow' : ''} ${active ? 'html-embed-selected' : ''} ${menu || busy || note ? 'html-embed-hold' : ''} ${drag ? 'resizing' : ''}`}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
        style={{
          width: boxW ? `${boxW}px` : wantW ? `${wantW}px` : '100%',
          // Content up to MAX_NATURAL_W asks for its room, so the cell widens to show it at full size.
          minWidth: !boxW && wantW ? `${wantW}px` : undefined,
          maxWidth: boxW || !wantW ? '100%' : undefined,
        }}
      >
        {(figure ? (b: React.ReactElement) =>
          floatBar && barPos
            ? createPortal(
                <div className="html-embed-float" style={{ top: barPos.top, right: barPos.right }} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
                  {b}
                </div>,
                document.body,
              )
            : null
          : (b: React.ReactElement) => b)(
        <div className="html-embed-bar" style={{ height: BAR_H }}>
          <CodeI size={14} />
          {canDesk ? (
            <button
              className="html-embed-label html-embed-open"
              title="Open in Chrome (Ctrl+click: default browser)"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => openIn(e.ctrlKey || e.metaKey ? 'default' : 'chrome')}
            >
              {KIND_LABEL[kind]}
              <ExternalI size={11} />
            </button>
          ) : (
            <span className="html-embed-label">{KIND_LABEL[kind]}</span>
          )}
          {scale < 1 && <span className="html-embed-scale" title="Shown smaller to fit; drag the right edge or widen the cell to enlarge">{Math.round(scale * 100)}%</span>}
          {busy && <span className="html-embed-note">Working…</span>}
          {!busy && note && (
            <span className={`html-embed-note ${note.bad ? 'bad' : 'good'}`} title={note.file || note.text}>
              {note.text}
              {note.file && (
                <button className="html-embed-note-link" onMouseDown={(e) => e.stopPropagation()} onClick={() => desk().exporter.reveal(note.file)}>
                  Show in folder
                </button>
              )}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <div className="html-embed-actions" onMouseDown={(e) => e.stopPropagation()}>
            {canDesk && (
              <>
                <button className="html-embed-btn" title="Open in Chrome" onClick={() => openIn('chrome')}>
                  <ExternalI size={13} />
                </button>
                <button className="html-embed-btn" title="Save as web page (.html)" onClick={savePage}>
                  <Download size={13} />
                </button>
                <button
                  className={`html-embed-btn ${menu ? 'active' : ''}`}
                  title="More: open, save, copy"
                  onClick={(e) => setMenu(menu ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
                >
                  <MoreI size={13} />
                </button>
                <div className="html-embed-divider" />
              </>
            )}
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
        </div>,
        )}

        {!editing && doc != null && (
          <div className="html-embed-viewport" style={{ height: displayH, overflowX: scale <= MIN_SCALE && natW * scale > avail ? 'auto' : 'hidden' }}>
            <iframe
              ref={iframeRef}
              name={frameId}
              className={`html-embed-frame ${figure ? 'themed' : ''}`}
              srcDoc={doc}
              sandbox="allow-scripts"
              title={KIND_LABEL[kind]}
              onLoad={() => innerZoom != null && iframeRef.current?.contentWindow?.postMessage({ __zoom: innerZoom }, '*')}
              style={{
                height: crisp ? displayH * cz : frameH,
                width: crisp
                  ? innerW ? `${innerW * scale * cz}px` : `${100 * cz}%`
                  : innerW ? `${selfZoom ? innerW * scale : innerW}px` : '100%',
                transform: crisp ? (cz !== 1 ? `scale(${1 / cz})` : undefined) : scale < 1 && !selfZoom ? `scale(${scale})` : undefined,
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
        {menu && <WidgetMenu anchor={menu} items={menuItems} onClose={closeMenu} />}
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
