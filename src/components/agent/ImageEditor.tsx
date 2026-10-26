import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { blobUrl, type ChatAttachment, type ImageEdit, type Mark } from '../../agent/api'
import { FULL, MARK_FONT, applyEdit, renderEdit, blankEdit, cssFilter, drawMarks, drawTurned, editOf, flip, fromOrig, inkOn, isBlank, loadImg, orient, rotate, sameEdit, toOrig, turnedSize, type Rect } from '../../agent/imageEdit'
import { askConfirm } from '../../lib/confirm'
import { useBlobUrl } from './Lightbox'
import { copyCanvas, copyImage } from './imageCopy'
import { DrawBar, TOOLS, brushPx, loadDrawPrefs, saveDrawPrefs, stepPx, textPx, type DrawPrefs } from './ImageDraw'
import { ArrowLeft, ArrowRight, Check, Copy, CompareI, CropI, DrawI, FitI, FlipHI, FlipVI, Redo, RotateI, RotateLeftI, SlidersI, Trash, Undo, ZoomIn, ZoomOut } from '../Icons'

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const ASPECTS: { label: string; title: string; r: number | 'orig' | null }[] = [
  { label: 'Free', title: 'Any shape', r: null },
  { label: 'Original', title: 'Same shape as the picture', r: 'orig' },
  { label: '1:1', title: 'Square', r: 1 },
  { label: '4:3', title: 'Landscape 4:3', r: 4 / 3 },
  { label: '3:4', title: 'Portrait 3:4', r: 3 / 4 },
  { label: '16:9', title: 'Wide 16:9', r: 16 / 9 },
]

/** Light presets; "Text" lifts faded marker and pencil off a whiteboard or page photo. */
const LOOKS: { label: string; title: string; v: Pick<ImageEdit, 'bright' | 'contrast' | 'gray'> }[] = [
  { label: 'Original', title: 'No light changes', v: { bright: 100, contrast: 100, gray: false } },
  { label: 'Text', title: 'Crisper writing on whiteboards and paper', v: { bright: 112, contrast: 145, gray: false } },
  { label: 'Scan', title: 'Black and white, like a scanned page', v: { bright: 118, contrast: 175, gray: true } },
  { label: 'Brighter', title: 'Lift a dark photo', v: { bright: 135, contrast: 105, gray: false } },
]

const MIN_SIDE = 0.03
const ZMAX = 8
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

const r5 = (n: number) => Math.round(n * 1e5) / 1e5

/** Text being typed on the picture; `base` is the drawing without it, `before` the edit to go back to. */
interface Typing {
  at: [number, number]
  text: string
  c: string
  s: number
  fill: boolean
  before: ImageEdit
  base: Mark[]
  /** The text mark being changed, if any. */
  was?: Mark
}

let measureG: CanvasRenderingContext2D | null = null
/** Widest line of `text` at `px` in the drawing font. */
function textWidth(text: string, px: number) {
  measureG ??= document.createElement('canvas').getContext('2d')!
  measureG.font = `600 ${px}px ${MARK_FONT}`
  return Math.max(...text.split('\n').map((l) => measureG!.measureText(l).width))
}

interface Draft {
  edit: ImageEdit
  /** What the attachment carried when the editor opened, to tell what changed. */
  start: ImageEdit
  past: ImageEdit[]
  future: ImageEdit[]
}

/**
 * Resizes `s` by dragging `h` to (u, v), all in fractions of the picture.
 * `kr` keeps the shape: height = width * kr (null for any shape).
 */
function resize(s: Rect, h: Handle, u: number, v: number, kr: number | null): Rect {
  u = clamp(u, 0, 1)
  v = clamp(v, 0, 1)
  const L = s.x
  const R = s.x + s.w
  const T = s.y
  const B = s.y + s.h
  const ew = h.includes('e')
  const ww = h.includes('w')
  const sn = h.includes('s')
  const nn = h.includes('n')
  if (kr && (ew || ww) && (sn || nn)) {
    // Corner with a fixed shape: follow whichever side the pointer pulls further.
    const ax = ew ? L : R
    const ay = sn ? T : B
    const maxW = ew ? 1 - ax : ax
    const maxH = sn ? 1 - ay : ay
    let w = Math.max(Math.abs(u - ax), Math.abs(v - ay) / kr)
    w = Math.max(MIN_SIDE, Math.min(w, maxW, maxH / kr))
    const hh = w * kr
    return { x: ew ? ax : ax - w, y: sn ? ay : ay - hh, w, h: hh }
  }
  if (kr && (ew || ww)) {
    const ax = ew ? L : R
    const cy = T + s.h / 2
    let w = Math.max(MIN_SIDE, ew ? u - ax : ax - u)
    w = Math.min(w, ew ? 1 - ax : ax, (2 * Math.min(cy, 1 - cy)) / kr)
    const hh = w * kr
    return { x: ew ? ax : ax - w, y: cy - hh / 2, w, h: hh }
  }
  if (kr && (sn || nn)) {
    const ay = sn ? T : B
    const cx = L + s.w / 2
    let hh = Math.max(MIN_SIDE, sn ? v - ay : ay - v)
    hh = Math.min(hh, sn ? 1 - ay : ay, 2 * Math.min(cx, 1 - cx) * kr)
    const w = hh / kr
    return { x: cx - w / 2, y: sn ? ay : ay - hh, w, h: hh }
  }
  let x0 = L
  let x1 = R
  let y0 = T
  let y1 = B
  if (ew) x1 = Math.max(u, L + MIN_SIDE)
  if (ww) x0 = Math.min(u, R - MIN_SIDE)
  if (sn) y1 = Math.max(v, T + MIN_SIDE)
  if (nn) y0 = Math.min(v, B - MIN_SIDE)
  return { x: x0, y: y0, w: Math.min(1, x1) - Math.max(0, x0), h: Math.min(1, y1) - Math.max(0, y0) }
}

/** The biggest box of shape `kr` inside `c`, around its middle. */
function fitShape(c: Rect, kr: number): Rect {
  let w = c.w
  let h = w * kr
  if (h > c.h) {
    h = c.h
    w = h / kr
  }
  return { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h }
}

/**
 * Dims the picture outside the kept part: four plain boxes inside the picture.
 * (A huge box-shadow did this before: it repainted far past the picture on every drag step.)
 */
function Shade({ c }: { c: Rect }) {
  const pc = (n: number) => `${n * 100}%`
  return (
    <>
      <i className="ie-shade" style={{ left: 0, top: 0, width: '100%', height: pc(c.y) }} />
      <i className="ie-shade" style={{ left: 0, top: pc(c.y + c.h), width: '100%', bottom: 0 }} />
      <i className="ie-shade" style={{ left: 0, top: pc(c.y), width: pc(c.x), height: pc(c.h) }} />
      <i className="ie-shade" style={{ left: pc(c.x + c.w), top: pc(c.y), right: 0, height: pc(c.h) }} />
    </>
  )
}

function StripThumb({ att, active, edited, onClick }: { att: ChatAttachment; active: boolean; edited: boolean; onClick(): void }) {
  const url = useBlobUrl(att.sha, att.mime)
  return (
    <button className={`lb-strip-item ${active ? 'on' : ''}`} onClick={onClick} title={att.name}>
      {url && <img src={url} alt="" draggable={false} />}
      {edited && <i className="ie-dot" />}
    </button>
  )
}

/**
 * Full screen editor for the pictures about to be sent: turn, mirror, crop,
 * fix the light, zoom in to check, compare with the original. Nothing
 * changes until Done; Cancel leaves every picture as it was.
 */
export function ImageEditor({
  items,
  index,
  onApply,
  onRemove,
  onClose,
  save = applyEdit,
  sizeTitle = 'Size the assistant will get',
}: {
  items: ChatAttachment[]
  index: number
  onApply(changes: { from: string; to: ChatAttachment }[]): void
  onRemove?(sha: string): void
  onClose(): void
  /** Bakes an edit into a picture; chat pictures go to the blob store by default. */
  save?(att: ChatAttachment, e: ImageEdit): Promise<ChatAttachment>
  sizeTitle?: string
}) {
  const [list, setList] = useState(items)
  const [i, setI] = useState(Math.min(index, items.length - 1))
  const att = list[i]
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [missing, setMissing] = useState(false)
  const [aspect, setAspect] = useState<number | 'orig' | null>(null)
  const [panel, setPanel] = useState<'crop' | 'light' | 'draw'>('crop')
  const [comparing, setComparing] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [box, setBox] = useState({ w: 800, h: 600 })
  const [action, setAction] = useState<'move' | 'resize' | 'draw' | 'pan' | 'ink' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const emptyDown = useRef<{ x: number; y: number } | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [prefs, setPrefs] = useState(loadDrawPrefs)
  const setDraw = (p: Partial<DrawPrefs>) =>
    setPrefs((o) => {
      const n = { ...o, ...p }
      saveDrawPrefs(n)
      return n
    })
  const [typing, setTyping] = useState<Typing | null>(null)
  const typingRef = useRef(typing)
  typingRef.current = typing
  /** The drawing as shown: `inkBase` holds the finished marks, `ink` adds the one being drawn. */
  const ink = useRef<HTMLCanvasElement>(null)
  const inkBase = useRef<HTMLCanvasElement | null>(null)
  const liveMark = useRef<Mark | null>(null)
  const brush = useRef<HTMLElement>(null)

  const draft: Draft = drafts[att.sha] || { edit: editOf(att), start: editOf(att), past: [], future: [] }
  const edit = draft.edit
  const editRef = useRef(edit)
  editRef.current = edit
  const dirty = (d: Draft) => !sameEdit(d.edit, d.start)
  const anyDirty = Object.values(drafts).some(dirty)

  const setDraft = useCallback(
    (fn: (d: Draft) => Draft) => setDrafts((all) => ({ ...all, [att.sha]: fn(all[att.sha] || { edit: editOf(att), start: editOf(att), past: [], future: [] }) })),
    [att],
  )
  /** A change you can undo. */
  const commit = (next: ImageEdit) => setDraft((d) => (sameEdit(d.edit, next) ? d : { ...d, edit: next, past: [...d.past, d.edit].slice(-80), future: [] }))
  /** A step of a drag: shown at the next frame (one render per frame, however fast the mouse), recorded once on release. */
  const pending = useRef<ImageEdit | null>(null)
  const raf = useRef(0)
  const live = (next: ImageEdit) => {
    editRef.current = next
    pending.current = next
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const n = pending.current
      pending.current = null
      if (n) setDraft((d) => ({ ...d, edit: n }))
    })
  }
  /** Lands a drag's last step now, before it is recorded. */
  const flushLive = () => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = 0
    const n = pending.current
    pending.current = null
    if (n) setDraft((d) => ({ ...d, edit: n }))
  }
  const undo = () => setDraft((d) => (d.past.length ? { ...d, edit: d.past[d.past.length - 1], past: d.past.slice(0, -1), future: [d.edit, ...d.future] } : d))
  const redo = () => setDraft((d) => (d.future.length ? { ...d, edit: d.future[0], past: [...d.past, d.edit], future: d.future.slice(1) } : d))

  /* ---------- the original picture ---------- */

  useEffect(() => {
    let alive = true
    setImg(null)
    setMissing(false)
    const e = editOf(att)
    ;(async () => {
      let url = await blobUrl(e.orig.sha, e.orig.mime)
      if (!url && att.edit) {
        // Original gone (another computer, say): edit the picture as it is now.
        url = await blobUrl(att.sha, att.mime)
        if (alive) {
          setMissing(true)
          const fresh = blankEdit(att)
          setDrafts((all) => (all[att.sha] ? all : { ...all, [att.sha]: { edit: fresh, start: fresh, past: [], future: [] } }))
        }
      }
      if (!url) throw new Error('This picture could not be loaded.')
      const im = await loadImg(url)
      if (alive) setImg(im)
    })().catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [att.sha])

  const shown = comparing ? blankEdit(att) : edit
  const turned = img ? turnedSize(img.naturalWidth, img.naturalHeight, shown.rot) : { w: 4, h: 3 }

  useLayoutEffect(() => {
    if (img && canvas.current) drawTurned(img, shown, canvas.current, 2600)
  }, [img, shown.rot, shown.flipH, shown.flipV])

  /* ---------- layout ---------- */

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const pad = 48
  const fitK = Math.min((box.w - pad * 2) / turned.w, (box.h - pad * 2) / turned.h)
  const fw = Math.max(40, turned.w * fitK)
  const fh = Math.max(40, turned.h * fitK)

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan
  const zoomTo = (next: number, cx?: number, cy?: number) => {
    const z2 = clamp(next, 1, ZMAX)
    const r = stage.current!.getBoundingClientRect()
    const px = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2)
    const py = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2)
    const k = z2 / zoomRef.current
    const p = panRef.current
    const np = z2 <= 1 ? { x: 0, y: 0 } : { x: px - (px - p.x) * k, y: py - (py - p.y) * k }
    zoomRef.current = z2
    panRef.current = np
    setZoom(z2)
    setPan(np)
  }

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // Once: it reads zoom and pan through refs.
  }, [])

  /* ---------- the drawing layer ---------- */

  // Sharp at the zoom you look at: more pixels when zoomed in (in steps, so a wheel spin is not a repaint per notch).
  const inkLong = Math.min(4096, Math.round(Math.max(fw, fh) * (window.devicePixelRatio || 1) * clamp(Math.ceil(zoom), 1, 3)))

  /** Maps original picture pixels onto a drawing canvas of the turned picture. */
  const inkSetup = (g: CanvasRenderingContext2D, cv: HTMLCanvasElement, e: ImageEdit) => {
    const t = turnedSize(img!.naturalWidth, img!.naturalHeight, e.rot)
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.translate(cv.width / 2, cv.height / 2)
    g.scale(cv.width / t.w, cv.height / t.h)
    orient(g, e, img!.naturalWidth, img!.naturalHeight)
  }

  const paintInk = () => {
    const cv = ink.current
    const base = inkBase.current
    if (!cv || !base || !img) return
    const g = cv.getContext('2d')!
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cv.width, cv.height)
    g.drawImage(base, 0, 0)
    const m = liveMark.current
    if (m) {
      inkSetup(g, cv, editRef.current)
      drawMarks(g, [m], img.naturalWidth, img.naturalHeight)
    }
  }
  const inkRaf = useRef(0)
  const paintSoon = () => {
    if (!inkRaf.current) inkRaf.current = requestAnimationFrame(() => ((inkRaf.current = 0), paintInk()))
  }

  useLayoutEffect(() => {
    const cv = ink.current
    if (!img || !cv) return
    const t = turnedSize(img.naturalWidth, img.naturalHeight, edit.rot)
    const k = inkLong / Math.max(t.w, t.h)
    const W = Math.max(1, Math.round(t.w * k))
    const H = Math.max(1, Math.round(t.h * k))
    if (cv.width !== W || cv.height !== H) {
      cv.width = W
      cv.height = H
    }
    const base = (inkBase.current ??= document.createElement('canvas'))
    base.width = W
    base.height = H
    if (edit.marks?.length) {
      const g = base.getContext('2d')!
      inkSetup(g, base, edit)
      drawMarks(g, edit.marks, img.naturalWidth, img.naturalHeight)
    }
    paintInk()
  }, [img, edit.marks, edit.rot, edit.flipH, edit.flipV, inkLong])

  /* ---------- crop shape ---------- */

  /** Height per width in fractions of the picture, for the chosen shape. */
  const krOf = (a: typeof aspect, t = turned) => (a === null ? null : (t.w / t.h) / (a === 'orig' ? t.w / t.h : a))
  const kr = krOf(aspect)
  const pickAspect = (a: typeof aspect) => {
    setAspect(a)
    const k = krOf(a)
    if (k) commit({ ...edit, crop: fitShape(edit.crop, k) })
  }

  /* ---------- pointer work on the picture ---------- */

  const toUV = (cx: number, cy: number) => {
    const r = frame.current!.getBoundingClientRect()
    return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height }
  }

  const startPan = (e: React.PointerEvent) => {
    const s = { x: e.clientX, y: e.clientY, p: pan }
    setAction('pan')
    // One pan step per frame.
    let f = 0
    let last = { x: 0, y: 0 }
    const move = (ev: PointerEvent) => {
      last = { x: s.p.x + ev.clientX - s.x, y: s.p.y + ev.clientY - s.y }
      panRef.current = last
      if (!f) f = requestAnimationFrame(() => ((f = 0), setPan(last)))
    }
    const up = () => {
      setAction(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onFrameDown = (e: React.PointerEvent) => {
    if (e.button === 1 || spaceDown) {
      e.preventDefault()
      return startPan(e)
    }
    // A tablet pen's eraser end comes as button 5.
    const penEraser = e.pointerType === 'pen' && e.button === 5
    if ((e.button !== 0 && !penEraser) || comparing) return
    if (panel === 'draw') return startInk(e, penEraser)
    if (panel !== 'crop') return
    e.preventDefault()
    e.stopPropagation()
    const before = editRef.current
    const s = before.crop
    const p0 = toUV(e.clientX, e.clientY)
    const handle = (e.target as HTMLElement).dataset.h as Handle | undefined
    const inside = (e.target as HTMLElement).closest('.ie-crop')
    const mode = handle ? 'resize' : inside ? 'move' : 'draw'
    setAction(mode)
    let movedFar = false
    const move = (ev: PointerEvent) => {
      const p = toUV(ev.clientX, ev.clientY)
      if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) movedFar = true
      let crop: Rect
      if (mode === 'resize') crop = resize(s, handle!, p.u, p.v, kr)
      else if (mode === 'move') crop = { ...s, x: clamp(s.x + p.u - p0.u, 0, 1 - s.w), y: clamp(s.y + p.v - p0.v, 0, 1 - s.h) }
      else {
        if (!movedFar) return
        const start = { x: clamp(p0.u, 0, 1), y: clamp(p0.v, 0, 1), w: 0, h: 0 }
        const h = `${p.v < p0.v ? 'n' : 's'}${p.u < p0.u ? 'w' : 'e'}` as Handle
        crop = resize(start, h, p.u, p.v, kr)
      }
      live({ ...editRef.current, crop })
    }
    const up = () => {
      setAction(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      flushLive()
      const now = editRef.current
      // Record the whole drag as one undo step.
      setDraft((d) => (sameEdit(before, now) ? { ...d, edit: before } : { ...d, past: [...d.past, before].slice(-80), future: [] }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /* ---------- drawing ---------- */

  /** Lays the text being typed onto the picture as one undo step (or drops it when empty). */
  const commitText = () => {
    const t = typingRef.current
    if (!t) return
    typingRef.current = null
    setTyping(null)
    const text = t.text.replace(/\s+$/, '')
    const was = t.was
    if ((was && was.t === 'text' && was.text === text) || (!was && !text.trim())) return cancelText(t)
    const marks: Mark[] = text.trim() ? [...t.base, { t: 'text', c: t.c, s: t.s, at: t.at, text, ...(t.fill ? { fill: true } : {}) }] : t.base
    // Seen at once by whatever runs next in this event (a new stroke builds on it).
    const next = { ...editRef.current, marks }
    editRef.current = next
    setDraft((d) => ({ ...d, edit: next, past: [...d.past, t.before].slice(-80), future: [] }))
  }
  const cancelText = (t = typingRef.current) => {
    if (!t) return
    typingRef.current = null
    setTyping(null)
    editRef.current = t.before
    setDraft((d) => ({ ...d, edit: t.before }))
  }

  /** Index of the text mark under a screen point, or -1. */
  const textAt = (cx: number, cy: number) => {
    const marks = editRef.current.marks || []
    if (!img) return -1
    const r = frame.current!.getBoundingClientRect()
    const iw = img.naturalWidth
    const ih = img.naturalHeight
    const scale = r.width / turned.w
    for (let k = marks.length - 1; k >= 0; k--) {
      const m = marks[k]
      if (m.t !== 'text') continue
      const S = m.s * Math.max(iw, ih) * scale
      const { u, v } = fromOrig(editRef.current, iw, ih, m.at[0], m.at[1])
      const x = r.left + u * r.width
      const y = r.top + v * r.height
      const pad = S * 0.4
      if (cx >= x - pad && cx <= x + textWidth(m.text, S) + pad && cy >= y - pad && cy <= y + m.text.split('\n').length * S * 1.25 + pad) return k
    }
    return -1
  }

  const moveBrush = (cx: number, cy: number) => {
    const el = brush.current
    const st = stage.current
    if (!el || !st) return
    const r = st.getBoundingClientRect()
    el.style.transform = `translate(${cx - r.left}px, ${cy - r.top}px)`
  }

  const startInk = (e: React.PointerEvent, penEraser: boolean) => {
    if (!img) return
    e.preventDefault()
    e.stopPropagation()
    commitText()
    const iw = img.naturalWidth
    const ih = img.naturalHeight
    const L = Math.max(iw, ih)
    const ed = editRef.current
    const marks = ed.marks || []
    const at = (cx: number, cy: number): [number, number] => {
      const { u, v } = toUV(cx, cy)
      const [x, y] = toOrig(ed, iw, ih, u, v)
      return [r5(x), r5(y)]
    }
    // Screen pixels per original pixel, zoom included: sizes are picked on screen.
    const scale = frame.current!.getBoundingClientRect().width / turned.w
    const tool = penEraser ? 'erase' : prefs.tool
    const c = prefs.color

    if (tool === 'text') {
      const k = textAt(e.clientX, e.clientY)
      if (k >= 0) {
        const was = marks[k] as Extract<Mark, { t: 'text' }>
        const base = marks.filter((_, j) => j !== k)
        // Hidden while it is retyped; not an undo step of its own.
        editRef.current = { ...ed, marks: base }
        setDraft((d) => ({ ...d, edit: { ...d.edit, marks: base } }))
        setTyping({ at: was.at, text: was.text, c: was.c, s: was.s, fill: Boolean(was.fill), before: ed, base, was })
      } else {
        setTyping({ at: at(e.clientX, e.clientY), text: '', c, s: r5(textPx(prefs.size) / scale / L), fill: prefs.fill, before: ed, base: marks })
      }
      return
    }
    if (tool === 'step') {
      const n = marks.reduce((top, m) => (m.t === 'step' ? Math.max(top, m.n) : top), 0) + 1
      commit({ ...ed, marks: [...marks, { t: 'step', c, s: r5(stepPx(prefs.size) / scale / L), at: at(e.clientX, e.clientY), n }] })
      return
    }

    const w = r5(brushPx(tool, prefs.size) / scale / L)
    const s0 = { x: e.clientX, y: e.clientY }
    const free = tool === 'pen' || tool === 'hl' || tool === 'erase'
    const pen = e.pointerType === 'pen'
    // Light touch draws thin, a firm press thick; mouse and touch draw even.
    const press = (ev: PointerEvent) => (pen ? 0.2 + 1.3 * Math.pow(clamp(ev.pressure || 0.5, 0.05, 1), 0.85) : 1)
    let pr = press(e.nativeEvent)
    let last = s0
    let moved = false
    const mark: Mark = free
      ? { t: tool, c, w, p: [...at(s0.x, s0.y), Math.round(pr * 100) / 100] }
      : { t: tool, c, w, a: at(s0.x, s0.y), b: at(s0.x, s0.y), ...(prefs.fill && (tool === 'rect' || tool === 'ellipse') ? { fill: true } : {}) }
    liveMark.current = mark
    setAction('ink')
    paintSoon()

    const move = (ev: PointerEvent) => {
      moveBrush(ev.clientX, ev.clientY)
      if ('p' in mark) {
        // Every sample the pointer took since the last event, for smooth fast strokes.
        const all = ev.getCoalescedEvents?.() || []
        for (const q of all.length ? all : [ev]) {
          if (Math.hypot(q.clientX - last.x, q.clientY - last.y) < 1.2) continue
          last = { x: q.clientX, y: q.clientY }
          pr = pen ? pr * 0.55 + press(q) * 0.45 : 1
          mark.p.push(...at(q.clientX, q.clientY), Math.round(pr * 100) / 100)
        }
      } else if ('a' in mark) {
        let x = ev.clientX
        let y = ev.clientY
        const dx = x - s0.x
        const dy = y - s0.y
        if (Math.hypot(dx, dy) > 3) moved = true
        if (ev.shiftKey) {
          if (mark.t === 'line' || mark.t === 'arrow') {
            const step = Math.PI / 12
            const ang = Math.round(Math.atan2(dy, dx) / step) * step
            const len = Math.hypot(dx, dy)
            x = s0.x + Math.cos(ang) * len
            y = s0.y + Math.sin(ang) * len
          } else {
            const d = Math.max(Math.abs(dx), Math.abs(dy))
            x = s0.x + Math.sign(dx || 1) * d
            y = s0.y + Math.sign(dy || 1) * d
          }
        }
        const fromMid = ev.altKey && (mark.t === 'rect' || mark.t === 'ellipse')
        mark.a = fromMid ? at(2 * s0.x - x, 2 * s0.y - y) : at(s0.x, s0.y)
        mark.b = at(x, y)
      }
      paintSoon()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setAction(null)
      liveMark.current = null
      const now = editRef.current
      if (free || moved) commit({ ...now, marks: [...(now.marks || []), mark] })
      else paintInk()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const clearInk = () => {
    commitText()
    commit({ ...editRef.current, marks: [] })
  }

  /** Slider props: a drag is one undo step, a key press is one too. */
  const slideFrom = useRef<ImageEdit | null>(null)
  const slider = (to: (v: number) => ImageEdit) => ({
    onPointerDown: () => (slideFrom.current = editRef.current),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => (slideFrom.current ? live : commit)(to(Number(e.target.value))),
    onPointerUp: () => {
      flushLive()
      const before = slideFrom.current
      slideFrom.current = null
      if (before) setDraft((d) => (sameEdit(before, d.edit) ? d : { ...d, past: [...d.past, before].slice(-80), future: [] }))
    },
  })

  /* ---------- picking, finishing ---------- */

  const go = (k: number) => {
    if (!list.length) return
    commitText()
    setI(((k % list.length) + list.length) % list.length)
    setComparing(false)
    resetView()
  }

  const finish = async () => {
    if (saving) return
    const changed = list.filter((a) => drafts[a.sha] && dirty(drafts[a.sha]))
    if (!changed.length) return onClose()
    setSaving(true)
    setError(null)
    try {
      const out: { from: string; to: ChatAttachment }[] = []
      for (const a of changed) out.push({ from: a.sha, to: await save(a, drafts[a.sha].edit) })
      onApply(out)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const cancel = async () => {
    if (anyDirty && !(await askConfirm('Throw away your changes to these pictures?', 'Discard'))) return
    onClose()
  }

  const remove = () => {
    if (!onRemove) return
    onRemove(att.sha)
    const rest = list.filter((a) => a.sha !== att.sha)
    if (!rest.length) return onClose()
    setList(rest)
    setI(Math.min(i, rest.length - 1))
    resetView()
  }

  const resetAll = () => {
    commit({ ...blankEdit(att), orig: edit.orig })
    setAspect(null)
  }

  /** Copies the picture as it will be sent. */
  const copyEdited = () => renderEdit(comparing ? blankEdit(att) : edit).then(copyCanvas, () => copyImage(att))

  /* ---------- keys ---------- */

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range') return
      if (t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key
      if (k === 'Escape') cancel()
      else if (k === 'Enter') finish()
      else if (mod && (k === 'z' || k === 'Z')) e.shiftKey ? redo() : undo()
      else if (mod && (k === 'y' || k === 'Y')) redo()
      else if (mod && (k === 'c' || k === 'C')) copyEdited()
      else if (mod) return
      else if (k === 'r' || k === 'R') commit(rotate(edit, e.shiftKey ? -1 : 1))
      else if (k === 'h' || k === 'H') commit(flip(edit, 'h'))
      else if (k === 'v' || k === 'V') commit(flip(edit, 'v'))
      else if (k === 'c' || k === 'C') setPanel('crop')
      else if (k === 'l' || k === 'L') setPanel('light')
      else if (k === 'd' || k === 'D') setPanel('draw')
      else if (panel === 'draw' && /^[1-9]$/.test(k)) setDraw({ tool: TOOLS[Number(k) - 1].t })
      else if (panel === 'draw' && k === '[') setDraw({ size: Math.max(1, prefs.size - Math.max(1, Math.round(prefs.size * 0.2))) })
      else if (panel === 'draw' && k === ']') setDraw({ size: Math.min(40, prefs.size + Math.max(1, Math.round(prefs.size * 0.2))) })
      else if (k === '\\') setComparing(true)
      else if (k === ' ') setSpaceDown(true)
      else if (k === '0') resetView()
      else if (k === '+' || k === '=') zoomTo(zoom * 1.25)
      else if (k === '-') zoomTo(zoom / 1.25)
      else if (k === 'ArrowRight' && list.length > 1 && t.tagName !== 'INPUT') go(i + 1)
      else if (k === 'ArrowLeft' && list.length > 1 && t.tagName !== 'INPUT') go(i - 1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    const upKey = (e: KeyboardEvent) => {
      if (e.key === '\\') setComparing(false)
      if (e.key === ' ') setSpaceDown(false)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', upKey, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', upKey, true)
    }
  })

  /* ---------- numbers for the header ---------- */

  const outSize = useMemo(() => {
    if (!img) return null
    const t = turnedSize(img.naturalWidth, img.naturalHeight, edit.rot)
    const w = edit.crop.w * t.w
    const h = edit.crop.h * t.h
    const k = Math.min(1, 2400 / Math.max(w, h))
    return { w: Math.round(w * k), h: Math.round(h * k), ow: img.naturalWidth, oh: img.naturalHeight }
  }, [img, edit])

  const c = shown.crop
  const cropped = !comparing && (c.w < 0.999 || c.h < 0.999)
  const editedHere = (a: ChatAttachment) => {
    const d = drafts[a.sha]
    return d ? !isBlank(d.edit) : Boolean(a.edit && !isBlank(a.edit))
  }

  return createPortal(
    <div
      className="lb ie"
      onContextMenu={(e) => e.preventDefault()}
      // A plain click on empty space anywhere (below the picture, beside the tool bars) closes, like the Close button.
      onPointerDown={(e) => {
        const t = e.target as HTMLElement
        if (e.button === 0 && (t === e.currentTarget || t.classList.contains('lb-dock'))) emptyDown.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerUp={(e) => {
        const t = e.target as HTMLElement
        const d = emptyDown.current
        if (d && (t === e.currentTarget || t.classList.contains('lb-dock')) && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) {
          emptyDown.current = null
          finish()
        }
      }}
    >
      <div className="lb-bar ie-bar">
        <span className="lb-name" title={att.name}>{att.name}</span>
        {list.length > 1 && <span className="lb-count">{i + 1} / {list.length}</span>}
        {outSize && (
          <span className="lb-count" title={sizeTitle}>
            {outSize.ow} x {outSize.oh}
            {(outSize.w !== outSize.ow || outSize.h !== outSize.oh) && <> → <b>{outSize.w} x {outSize.h}</b></>}
          </span>
        )}
        {zoom > 1 && panel !== 'light' && <span className="ie-note soft">Hold Space and drag to move around</span>}
        {panel === 'draw' && zoom <= 1 && <span className="ie-note soft">{TOOLS.find((t) => t.t === prefs.tool)?.tip}</span>}
        {missing && <span className="ie-note">Original not on this computer: editing the picture as sent</span>}
        <div className="spacer" />
        {error && <span className="ie-err">{error}</span>}
        {onRemove && (
          <button className="lb-btn ie-remove" onClick={remove} title="Don't send this picture">
            <Trash size={16} /><span>Remove</span>
          </button>
        )}
        <button className="lb-btn ie-cancel" onClick={cancel} title="Close without changes (Esc)">Cancel</button>
        <button className="ie-done" onClick={finish} disabled={saving} title="Keep these changes (Enter)">
          {saving ? <span className="ie-spin" /> : <Check size={15} />}
          {saving ? 'Saving' : anyDirty ? 'Done' : 'Close'}
        </button>
      </div>

      <div
        ref={stage}
        className={`lb-stage ie-stage ${list.length > 1 ? 'with-strip' : ''} ${action ? `doing-${action}` : ''} ${spaceDown ? 'space' : ''}`}
        onPointerDown={(e) => {
          emptyDown.current = null
          if (e.target !== e.currentTarget) return
          if (zoom > 1 || e.button === 1 || spaceDown) startPan(e)
          else if (e.button === 0) emptyDown.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerUp={(e) => {
          // A plain click on the empty space around the picture closes, like the Close button.
          const d = emptyDown.current
          emptyDown.current = null
          if (d && e.target === e.currentTarget && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) finish()
        }}
        onDoubleClick={(e) => e.target === e.currentTarget && resetView()}
      >
        <div
          ref={frame}
          className={`ie-frame ${action ? 'busy' : ''} ${panel === 'draw' && !comparing ? `inking ink-${prefs.tool}` : ''}`}
          style={{ width: fw, height: fh, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, ['--inv' as any]: 1 / zoom }}
          onPointerDown={onFrameDown}
          onPointerMove={(e) => panel === 'draw' && moveBrush(e.clientX, e.clientY)}
          onDoubleClick={(e) => {
            if (panel !== 'crop' || comparing) return
            e.stopPropagation()
            // Double click: crop off, or zoom in when there is no crop.
            if (cropped) commit({ ...edit, crop: FULL })
            else if (zoom > 1) resetView()
            else zoomTo(2.5, e.clientX, e.clientY)
          }}
        >
          <canvas ref={canvas} className="ie-canvas" style={{ filter: comparing ? 'none' : cssFilter(edit) }} />
          <canvas ref={ink} className="ie-ink" style={{ visibility: comparing ? 'hidden' : undefined }} />
          {typing && img && (() => {
            const { u, v } = fromOrig(edit, img.naturalWidth, img.naturalHeight, typing.at[0], typing.at[1])
            const px = typing.s * Math.max(img.naturalWidth, img.naturalHeight) * (fw / turned.w)
            const pad = px * 0.35
            return (
              <textarea
                className={`ie-type ${typing.fill ? 'fill' : ''}`}
                autoFocus
                spellCheck={false}
                placeholder="Type"
                value={typing.text}
                rows={typing.text.split('\n').length}
                style={{
                  left: `${u * 100}%`,
                  top: `${v * 100}%`,
                  fontSize: px,
                  fontFamily: MARK_FONT,
                  width: textWidth(typing.text || 'Type', px) + px,
                  color: typing.fill ? inkOn(typing.c) : typing.c,
                  background: typing.fill ? typing.c : 'transparent',
                  padding: typing.fill ? `${pad * 0.7}px ${pad}px` : 0,
                  margin: typing.fill ? `${-pad * 0.7}px 0 0 ${-pad}px` : 0,
                  borderRadius: px * 0.3,
                  ['--halo' as any]: inkOn(typing.c) === '#fff' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)',
                }}
                onChange={(e) => setTyping({ ...typing, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    commitText()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelText()
                  }
                }}
                onBlur={() => commitText()}
                // Changing a text: carry on at its end.
                onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                onPointerDown={(e) => e.stopPropagation()}
              />
            )
          })()}
          {!img && !error && <div className="ie-loading"><span className="ie-spin" /></div>}
          {img && !comparing && (cropped || (action && panel === 'crop')) && <Shade c={c} />}
          {img && !comparing && panel === 'crop' && (
            <div className={`ie-crop ${action ? 'active' : ''} ${cropped ? 'cut' : ''}`} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}>
              <i className="ie-grid" />
              {HANDLES.map((h) => <span key={h} data-h={h} className={`ie-h ${h}`} />)}
            </div>
          )}
          {comparing && <span className="ie-tag">Original</span>}
        </div>
        {panel === 'draw' && !comparing && (prefs.tool === 'pen' || prefs.tool === 'hl' || prefs.tool === 'erase') && (
          <i
            ref={brush}
            className={`ie-brush ${prefs.tool}`}
            style={{ ['--d' as any]: `${Math.max(4, brushPx(prefs.tool, prefs.size))}px`, ['--c' as any]: prefs.color }}
          />
        )}
      </div>

      {list.length > 1 && (
        <>
          <button className="lb-nav left" onClick={() => go(i - 1)} title="Previous picture (Left)"><ArrowLeft size={20} /></button>
          <button className="lb-nav right" onClick={() => go(i + 1)} title="Next picture (Right)"><ArrowRight size={20} /></button>
        </>
      )}

      <div className="lb-dock ie-dock">
        {panel === 'crop' ? (
          <div className="ie-row">
            <span className="ie-label">Shape</span>
            {ASPECTS.map((a) => (
              <button key={a.label} className={`ie-pill ${aspect === a.r ? 'on' : ''}`} title={a.title} onClick={() => pickAspect(a.r)}>
                {a.label}
              </button>
            ))}
            {cropped && <button className="ie-pill ghost" onClick={() => commit({ ...edit, crop: FULL })} title="Keep the whole picture">Uncrop</button>}
          </div>
        ) : panel === 'draw' ? (
          <DrawBar prefs={prefs} set={setDraw} hasMarks={Boolean(edit.marks?.length)} onClear={clearInk} />
        ) : (
          <div className="ie-row">
            {LOOKS.map((l) => {
              const on = edit.bright === l.v.bright && edit.contrast === l.v.contrast && edit.gray === l.v.gray
              return (
                <button key={l.label} className={`ie-pill ${on ? 'on' : ''}`} title={l.title} onClick={() => commit({ ...edit, ...l.v })}>
                  {l.label}
                </button>
              )
            })}
            <span className="lb-sep" />
            <label className="ie-slide" title="Brightness (double click to reset)" onDoubleClick={() => commit({ ...edit, bright: 100 })}>
              <span>Light</span>
              <input type="range" min={40} max={200} value={edit.bright} {...slider((v) => ({ ...edit, bright: v }))} />
              <em>{edit.bright}%</em>
            </label>
            <label className="ie-slide" title="Contrast (double click to reset)" onDoubleClick={() => commit({ ...edit, contrast: 100 })}>
              <span>Contrast</span>
              <input type="range" min={40} max={250} value={edit.contrast} {...slider((v) => ({ ...edit, contrast: v }))} />
              <em>{edit.contrast}%</em>
            </label>
            <button className={`ie-pill ${edit.gray ? 'on' : ''}`} onClick={() => commit({ ...edit, gray: !edit.gray })} title="Black and white">B&W</button>
          </div>
        )}

        <div className="lb-tools">
          <button className={`lb-btn ie-mode ${panel === 'crop' ? 'on' : ''}`} onClick={() => setPanel('crop')} title="Crop (C)"><CropI size={16} /><span>Crop</span></button>
          <button className={`lb-btn ie-mode ${panel === 'light' ? 'on' : ''}`} onClick={() => setPanel('light')} title="Light and contrast (L)"><SlidersI size={16} /><span>Adjust</span></button>
          <button className={`lb-btn ie-mode ${panel === 'draw' ? 'on' : ''}`} onClick={() => setPanel('draw')} title="Draw, mark up and write on the picture (D)"><DrawI size={16} /><span>Draw</span></button>
          <span className="lb-sep" />
          <button className="lb-btn" onClick={() => commit(rotate(edit, -1))} title="Turn left (Shift+R)"><RotateLeftI size={16} /></button>
          <button className="lb-btn" onClick={() => commit(rotate(edit, 1))} title="Turn right (R)"><RotateI size={16} /></button>
          <button className="lb-btn" onClick={() => commit(flip(edit, 'h'))} title="Mirror left to right (H)"><FlipHI size={16} /></button>
          <button className="lb-btn" onClick={() => commit(flip(edit, 'v'))} title="Mirror top to bottom (V)"><FlipVI size={16} /></button>
          <span className="lb-sep" />
          <button className="lb-btn" onClick={() => zoomTo(zoom / 1.25)} title="Zoom out (-)"><ZoomOut size={16} /></button>
          <button className={`lb-btn pct ${zoom === 1 ? 'on' : ''}`} onClick={resetView} title="Fit to screen (0)"><FitI size={15} /><span>{Math.round(zoom * 100)}%</span></button>
          <button className="lb-btn" onClick={() => zoomTo(zoom * 1.25)} title="Zoom in (+)"><ZoomIn size={16} /></button>
          <span className="lb-sep" />
          <button
            className={`lb-btn ${comparing ? 'on' : ''}`}
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
            title="Hold to see the original (hold \)"
          >
            <CompareI size={16} />
          </button>
          <button className="lb-btn" onClick={copyEdited} title="Copy the picture as edited (Ctrl+C)"><Copy size={16} /></button>
          <button className="lb-btn" disabled={!draft.past.length} onClick={undo} title="Undo (Ctrl+Z)"><Undo size={16} /></button>
          <button className="lb-btn" disabled={!draft.future.length} onClick={redo} title="Redo (Ctrl+Y)"><Redo size={16} /></button>
          <button className="lb-btn txt" disabled={isBlank(edit)} onClick={resetAll} title="Back to the original picture">Reset</button>
        </div>

        {list.length > 1 && (
          <div className="lb-strip">
            {list.map((a, k) => (
              <StripThumb key={a.sha} att={a} active={k === i} edited={editedHere(a)} onClick={() => go(k)} />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
