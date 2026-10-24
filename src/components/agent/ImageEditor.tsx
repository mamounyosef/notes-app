import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { blobUrl, type ChatAttachment, type ImageEdit } from '../../agent/api'
import { FULL, applyEdit, renderEdit, blankEdit, cssFilter, drawTurned, editOf, flip, isBlank, loadImg, rotate, sameEdit, turnedSize, type Rect } from '../../agent/imageEdit'
import { askConfirm } from '../../lib/confirm'
import { useBlobUrl } from './Lightbox'
import { copyCanvas, copyImage } from './imageCopy'
import { ArrowLeft, ArrowRight, Check, Copy, CompareI, CropI, FitI, FlipHI, FlipVI, Redo, RotateI, RotateLeftI, SlidersI, Trash, Undo, ZoomIn, ZoomOut } from '../Icons'

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
  const [panel, setPanel] = useState<'crop' | 'light'>('crop')
  const [comparing, setComparing] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [box, setBox] = useState({ w: 800, h: 600 })
  const [action, setAction] = useState<'move' | 'resize' | 'draw' | 'pan' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

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
  /** A step of a drag: shown now, recorded once on release. */
  const live = (next: ImageEdit) => setDraft((d) => ({ ...d, edit: next }))
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
  })

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
    const move = (ev: PointerEvent) => setPan({ x: s.p.x + ev.clientX - s.x, y: s.p.y + ev.clientY - s.y })
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
    if (e.button !== 0 || comparing || panel !== 'crop') return
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
      const now = editRef.current
      // Record the whole drag as one undo step.
      setDraft((d) => (sameEdit(before, now) ? { ...d, edit: before } : { ...d, past: [...d.past, before].slice(-80), future: [] }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Slider props: a drag is one undo step, a key press is one too. */
  const slideFrom = useRef<ImageEdit | null>(null)
  const slider = (to: (v: number) => ImageEdit) => ({
    onPointerDown: () => (slideFrom.current = editRef.current),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => (slideFrom.current ? live : commit)(to(Number(e.target.value))),
    onPointerUp: () => {
      const before = slideFrom.current
      slideFrom.current = null
      if (before) setDraft((d) => (sameEdit(before, d.edit) ? d : { ...d, past: [...d.past, before].slice(-80), future: [] }))
    },
  })

  /* ---------- picking, finishing ---------- */

  const go = (k: number) => {
    if (!list.length) return
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
    <div className="lb ie" onContextMenu={(e) => e.preventDefault()}>
      <div className="lb-bar ie-bar">
        <span className="lb-name" title={att.name}>{att.name}</span>
        {list.length > 1 && <span className="lb-count">{i + 1} / {list.length}</span>}
        {outSize && (
          <span className="lb-count" title={sizeTitle}>
            {outSize.ow} x {outSize.oh}
            {(outSize.w !== outSize.ow || outSize.h !== outSize.oh) && <> → <b>{outSize.w} x {outSize.h}</b></>}
          </span>
        )}
        {zoom > 1 && panel === 'crop' && <span className="ie-note soft">Hold Space and drag to move around</span>}
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
          if (e.target !== e.currentTarget) return
          if (zoom > 1 || e.button === 1 || spaceDown) startPan(e)
        }}
        onDoubleClick={(e) => e.target === e.currentTarget && resetView()}
      >
        <div
          ref={frame}
          className={`ie-frame ${action ? 'busy' : ''}`}
          style={{ width: fw, height: fh, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, ['--inv' as any]: 1 / zoom }}
          onPointerDown={onFrameDown}
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
          {!img && !error && <div className="ie-loading"><span className="ie-spin" /></div>}
          {img && !comparing && panel === 'crop' && (
            <div className={`ie-crop ${action ? 'active' : ''} ${cropped ? 'cut' : ''}`} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}>
              <i className="ie-grid" />
              {HANDLES.map((h) => <span key={h} data-h={h} className={`ie-h ${h}`} />)}
            </div>
          )}
          {img && !comparing && panel === 'light' && cropped && (
            <div className="ie-crop ghost" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }} />
          )}
          {comparing && <span className="ie-tag">Original</span>}
        </div>
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
