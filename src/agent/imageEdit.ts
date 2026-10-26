/**
 * Non destructive edits for image attachments: turn, mirror, crop and light
 * fixes. The edited pixels are what the model gets; the original stays in the
 * blob store so an image can be opened again and changed or reset.
 */
import { blobUrl, chatApi, toBase64, type ChatAttachment, type ImageEdit, type Mark } from './api'

export type Rect = { x: number; y: number; w: number; h: number }

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
const MAX_SIDE = 2400

/** The edit an untouched image has. */
export function blankEdit(att: ChatAttachment): ImageEdit {
  return { orig: { sha: att.sha, mime: att.mime, size: att.size }, rot: 0, flipH: false, flipV: false, crop: FULL, bright: 100, contrast: 100, gray: false }
}

/** The edit already on an attachment, or a blank one. */
export function editOf(att: ChatAttachment): ImageEdit {
  return att.edit ? { ...blankEdit(att), ...att.edit, orig: att.edit.orig } : blankEdit(att)
}

export function isBlank(e: ImageEdit) {
  const c = e.crop
  return e.rot === 0 && !e.flipH && !e.flipV && c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.999 && c.h >= 0.999 && e.bright === 100 && e.contrast === 100 && !e.gray && !e.marks?.length
}

export function sameEdit(a: ImageEdit, b: ImageEdit) {
  const near = (p: number, q: number) => Math.abs(p - q) < 0.0005
  return (
    (a.marks === b.marks || (!a.marks?.length && !b.marks?.length)) &&
    a.rot === b.rot && a.flipH === b.flipH && a.flipV === b.flipV && a.bright === b.bright && a.contrast === b.contrast && a.gray === b.gray &&
    near(a.crop.x, b.crop.x) && near(a.crop.y, b.crop.y) && near(a.crop.w, b.crop.w) && near(a.crop.h, b.crop.h)
  )
}

/* ---------- turning and mirroring, as seen on screen ---------- */

/** Turn a quarter clockwise (dir 1) or counterclockwise (dir -1); the crop turns with the picture. */
export function rotate(e: ImageEdit, dir: 1 | -1): ImageEdit {
  const c = e.crop
  const crop = dir === 1 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }
  return { ...e, rot: (((e.rot + dir * 90) % 360) + 360) % 360, crop }
}

/**
 * Mirror left to right (axis 'h') or top to bottom ('v') as the picture
 * looks now. Mirrors are stored before the turn, so on a sideways picture a
 * mirror across the screen is the other mirror of the original.
 */
export function flip(e: ImageEdit, axis: 'h' | 'v'): ImageEdit {
  const c = e.crop
  const sideways = e.rot % 180 !== 0
  const flipOrigH = (axis === 'h') !== sideways
  return {
    ...e,
    flipH: flipOrigH ? !e.flipH : e.flipH,
    flipV: flipOrigH ? e.flipV : !e.flipV,
    crop: axis === 'h' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h },
  }
}

/** Size of the picture after turning, before cropping. */
export function turnedSize(w: number, h: number, rot: number) {
  return rot % 180 ? { w: h, h: w } : { w, h }
}

export function cssFilter(e: Pick<ImageEdit, 'bright' | 'contrast' | 'gray'>) {
  const parts: string[] = []
  if (e.bright !== 100) parts.push(`brightness(${e.bright}%)`)
  if (e.contrast !== 100) parts.push(`contrast(${e.contrast}%)`)
  if (e.gray) parts.push('grayscale(1)')
  return parts.join(' ') || 'none'
}

/**
 * Draws the turned and mirrored picture (no crop) onto a canvas, scaled so
 * its long side is at most `maxSide`. Used for the editor's preview.
 */
export function drawTurned(img: HTMLImageElement, e: Pick<ImageEdit, 'rot' | 'flipH' | 'flipV'>, canvas: HTMLCanvasElement, maxSide: number) {
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  const t = turnedSize(iw, ih, e.rot)
  const k = Math.min(1, maxSide / Math.max(t.w, t.h))
  canvas.width = Math.max(1, Math.round(t.w * k))
  canvas.height = Math.max(1, Math.round(t.h * k))
  const g = canvas.getContext('2d')!
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, canvas.width, canvas.height)
  g.translate(canvas.width / 2, canvas.height / 2)
  g.rotate((e.rot * Math.PI) / 180)
  g.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1)
  g.drawImage(img, (-iw * k) / 2, (-ih * k) / 2, iw * k, ih * k)
}

export async function loadImg(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = url
  await img.decode()
  return img
}

/** Bakes an edit into new pixels and returns the attachment that carries them. */
export async function applyEdit(att: ChatAttachment, e: ImageEdit): Promise<ChatAttachment> {
  const { orig } = e
  if (isBlank(e)) {
    const { edit: _drop, ...rest } = att
    return { ...rest, sha: orig.sha, mime: orig.mime, size: orig.size }
  }
  const mime = orig.mime === 'image/png' ? 'image/png' : 'image/jpeg'
  const c = await renderEdit(e, mime)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the picture.'))), mime, 0.92))
  const buf = await blob.arrayBuffer()
  const sha = await chatApi.saveBlob(toBase64(buf))
  return { ...att, sha, mime, size: buf.byteLength, edit: e }
}

/** The edited picture drawn on a canvas (white behind it for JPEG). */
export async function renderEdit(e: ImageEdit, mime = 'image/png'): Promise<HTMLCanvasElement> {
  const url = await blobUrl(e.orig.sha, e.orig.mime)
  if (!url) throw new Error('The original picture is not on this computer.')
  const img = await loadImg(url)
  const t = turnedSize(img.naturalWidth, img.naturalHeight, e.rot)
  const cw = e.crop.w * t.w
  const ch = e.crop.h * t.h
  const k = Math.min(1, MAX_SIDE / Math.max(cw, ch))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(cw * k))
  c.height = Math.max(1, Math.round(ch * k))
  const g = c.getContext('2d')!
  if (mime === 'image/jpeg') {
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
  }
  g.filter = cssFilter(e)
  g.imageSmoothingQuality = 'high'
  g.scale(k, k)
  g.translate(-e.crop.x * t.w, -e.crop.y * t.h)
  g.translate(t.w / 2, t.h / 2)
  g.rotate((e.rot * Math.PI) / 180)
  g.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1)
  g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
  if (e.marks?.length) {
    // On a layer of their own: the eraser takes out drawing only, and the light fixes leave the ink alone.
    const layer = document.createElement('canvas')
    layer.width = c.width
    layer.height = c.height
    const lg = layer.getContext('2d')!
    lg.scale(k, k)
    lg.translate(-e.crop.x * t.w + t.w / 2, -e.crop.y * t.h + t.h / 2)
    orient(lg, e, img.naturalWidth, img.naturalHeight)
    drawMarks(lg, e.marks, img.naturalWidth, img.naturalHeight)
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.filter = 'none'
    g.drawImage(layer, 0, 0)
  }
  return c
}

/* ---------- drawing ---------- */

export const MARK_FONT = "'Segoe UI', system-ui, sans-serif"

/** From the turned picture's middle to the original's top left corner, in original pixels. */
export function orient(g: CanvasRenderingContext2D, e: Pick<ImageEdit, 'rot' | 'flipH' | 'flipV'>, iw: number, ih: number) {
  g.rotate((e.rot * Math.PI) / 180)
  g.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1)
  g.translate(-iw / 2, -ih / 2)
}

/** A point on the turned picture (fractions) as fractions of the original. */
export function toOrig(e: Pick<ImageEdit, 'rot' | 'flipH' | 'flipV'>, iw: number, ih: number, u: number, v: number): [number, number] {
  const t = turnedSize(iw, ih, e.rot)
  const dx = (u - 0.5) * t.w
  const dy = (v - 0.5) * t.h
  const a = (e.rot * Math.PI) / 180
  const cos = Math.round(Math.cos(a))
  const sin = Math.round(Math.sin(a))
  const x = (dx * cos + dy * sin) * (e.flipH ? -1 : 1)
  const y = (-dx * sin + dy * cos) * (e.flipV ? -1 : 1)
  return [x / iw + 0.5, y / ih + 0.5]
}

/** A point of the original (fractions) on the turned picture (fractions). */
export function fromOrig(e: Pick<ImageEdit, 'rot' | 'flipH' | 'flipV'>, iw: number, ih: number, x: number, y: number) {
  const t = turnedSize(iw, ih, e.rot)
  const px = (x - 0.5) * iw * (e.flipH ? -1 : 1)
  const py = (y - 0.5) * ih * (e.flipV ? -1 : 1)
  const a = (e.rot * Math.PI) / 180
  const cos = Math.round(Math.cos(a))
  const sin = Math.round(Math.sin(a))
  return { u: (px * cos - py * sin) / t.w + 0.5, v: (px * sin + py * cos) / t.h + 0.5 }
}

/** Black or white, whichever reads better on `c`. */
export function inkOn(c: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c)
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.62 ? '#111' : '#fff'
}

/** Runs `draw` at (x, y) with the turn and mirrors undone, so text reads the right way up. */
function upright(g: CanvasRenderingContext2D, x: number, y: number, draw: () => void) {
  const m = g.getTransform()
  const pt = m.transformPoint({ x, y })
  const k = Math.hypot(m.a, m.b)
  g.save()
  g.setTransform(k, 0, 0, k, pt.x, pt.y)
  draw()
  g.restore()
}

/**
 * Draws marks onto `g`, whose transform maps original picture pixels. Pen
 * strokes are smoothed through the midpoints and thicken with pen pressure.
 */
export function drawMarks(g: CanvasRenderingContext2D, marks: Mark[], iw: number, ih: number) {
  const L = Math.max(iw, ih)
  for (const m of marks) {
    g.save()
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.strokeStyle = m.c
    g.fillStyle = m.c
    if ('p' in m) {
      const p = m.p
      const n = p.length / 3
      const W = m.w * L
      const X = (i: number) => p[i * 3] * iw
      const Y = (i: number) => p[i * 3 + 1] * ih
      if (m.t === 'erase') g.globalCompositeOperation = 'destination-out'
      if (m.t === 'hl') g.globalAlpha = 0.4
      if (n === 1) {
        g.beginPath()
        g.arc(X(0), Y(0), (W * (m.t === 'pen' ? p[2] : 1)) / 2, 0, Math.PI * 2)
        g.fill()
      } else if (m.t !== 'pen') {
        // One path, so a see-through marker has no darker overlaps along itself.
        g.lineWidth = W
        g.beginPath()
        g.moveTo(X(0), Y(0))
        for (let i = 1; i < n - 1; i++) g.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2)
        g.lineTo(X(n - 1), Y(n - 1))
        g.stroke()
      } else {
        let px = X(0)
        let py = Y(0)
        for (let i = 1; i < n; i++) {
          const last = i === n - 1
          const mx = last ? X(i) : (X(i) + X(i + 1)) / 2
          const my = last ? Y(i) : (Y(i) + Y(i + 1)) / 2
          g.lineWidth = Math.max(0.5, W * (p[(i - 1) * 3 + 2] + p[i * 3 + 2]) * 0.5)
          g.beginPath()
          g.moveTo(px, py)
          g.quadraticCurveTo(X(i), Y(i), mx, my)
          g.stroke()
          px = mx
          py = my
        }
      }
    } else if ('at' in m) {
      const S = m.s * L
      upright(g, m.at[0] * iw, m.at[1] * ih, () => {
        g.textBaseline = 'middle'
        if (m.t === 'step') {
          const r = S * 0.8
          g.beginPath()
          g.arc(0, 0, r, 0, Math.PI * 2)
          g.shadowColor = 'rgba(0,0,0,0.35)'
          g.shadowBlur = S * 0.25
          g.fill()
          g.shadowColor = 'transparent'
          g.lineWidth = Math.max(1, S * 0.1)
          g.strokeStyle = inkOn(m.c) === '#fff' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.55)'
          g.stroke()
          g.fillStyle = inkOn(m.c)
          g.textAlign = 'center'
          g.font = `700 ${S * (m.n > 9 ? 0.8 : 1)}px ${MARK_FONT}`
          g.fillText(String(m.n), 0, S * 0.04)
          return
        }
        g.font = `600 ${S}px ${MARK_FONT}`
        const lines = m.text.split('\n')
        const lh = S * 1.25
        if (m.fill) {
          const w = Math.max(...lines.map((l) => g.measureText(l).width))
          const pad = S * 0.35
          g.beginPath()
          g.roundRect(-pad, -pad * 0.7, w + pad * 2, lines.length * lh + pad * 1.4, S * 0.3)
          g.fill()
          g.fillStyle = inkOn(m.c)
        } else {
          // A soft outline keeps text readable on any background.
          g.strokeStyle = inkOn(m.c) === '#fff' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)'
          g.lineWidth = S * 0.14
          lines.forEach((l, i) => g.strokeText(l, 0, lh * i + lh / 2))
        }
        lines.forEach((l, i) => g.fillText(l, 0, lh * i + lh / 2))
      })
    } else {
      const W = m.w * L
      const ax = m.a[0] * iw
      const ay = m.a[1] * ih
      const bx = m.b[0] * iw
      const by = m.b[1] * ih
      g.lineWidth = W
      if (m.t === 'arrow') {
        const len = Math.hypot(bx - ax, by - ay) || 1
        const head = Math.min(len * 0.6, W * 3.2 + L * 0.008)
        const ux = (bx - ax) / len
        const uy = (by - ay) / len
        g.beginPath()
        g.moveTo(ax, ay)
        g.lineTo(bx - ux * head * 0.6, by - uy * head * 0.6)
        g.stroke()
        // The head: a filled wedge with rounded corners.
        const side = (sp: number) => [bx - head * (ux * Math.cos(sp) - uy * Math.sin(sp)), by - head * (uy * Math.cos(sp) + ux * Math.sin(sp))] as const
        g.beginPath()
        g.moveTo(bx, by)
        g.lineTo(...side(0.48))
        g.lineTo(...side(-0.48))
        g.closePath()
        g.lineWidth = W * 0.6
        g.fill()
        g.stroke()
      } else if (m.t === 'line') {
        g.beginPath()
        g.moveTo(ax, ay)
        g.lineTo(bx, by)
        g.stroke()
      } else {
        g.beginPath()
        if (m.t === 'rect') g.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
        else g.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2)
        if (m.fill) {
          g.globalAlpha = 0.28
          g.fill()
          g.globalAlpha = 1
        }
        g.stroke()
      }
    }
    g.restore()
  }
}

/** A quick turn or mirror straight from the thumbnail. */
export function quickEdit(att: ChatAttachment, op: 'cw' | 'ccw' | 'h' | 'v') {
  const e = editOf(att)
  const next = op === 'cw' ? rotate(e, 1) : op === 'ccw' ? rotate(e, -1) : flip(e, op)
  return applyEdit(att, next)
}

/** "rotated, cropped" and so on, for tooltips. */
export function describeEdit(e?: ImageEdit) {
  if (!e || isBlank(e)) return ''
  const out: string[] = []
  if (e.rot) out.push(`turned ${e.rot}°`)
  if (e.flipH || e.flipV) out.push('mirrored')
  if (e.crop.w < 0.999 || e.crop.h < 0.999) out.push('cropped')
  if (e.bright !== 100 || e.contrast !== 100 || e.gray) out.push('adjusted')
  if (e.marks?.length) out.push('drawn on')
  return out.join(', ')
}
