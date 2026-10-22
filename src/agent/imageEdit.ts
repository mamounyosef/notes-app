/**
 * Non destructive edits for image attachments: turn, mirror, crop and light
 * fixes. The edited pixels are what the model gets; the original stays in the
 * blob store so an image can be opened again and changed or reset.
 */
import { blobUrl, chatApi, toBase64, type ChatAttachment, type ImageEdit } from './api'

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
  return e.rot === 0 && !e.flipH && !e.flipV && c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.999 && c.h >= 0.999 && e.bright === 100 && e.contrast === 100 && !e.gray
}

export function sameEdit(a: ImageEdit, b: ImageEdit) {
  const near = (p: number, q: number) => Math.abs(p - q) < 0.0005
  return (
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
  return c
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
  return out.join(', ')
}
