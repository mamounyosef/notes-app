/**
 * Copying and saving chat pictures: right click menus, Ctrl+C on the
 * picture under the mouse, and a short "Copied" note so it is clear it worked.
 */
import { blobUrl } from '../../agent/api'
import { loadImg } from '../../agent/imageEdit'
import { copyImageToClipboard } from '../../editor/ResizableImage'

export interface ImageRef {
  sha: string
  mime: string
  name: string
}

/** A small note near the bottom of the window that fades away. */
export function flash(text: string, bad = false) {
  document.querySelectorAll('.img-flash').forEach((el) => el.remove())
  const el = document.createElement('div')
  el.className = `img-flash ${bad ? 'bad' : ''}`
  el.textContent = text
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 1700)
}

export async function copyCanvas(c: HTMLCanvasElement) {
  try {
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
    if (!blob) throw new Error('no pixels')
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
    flash('Image copied')
  } catch {
    flash('Could not copy the image', true)
  }
}

export async function copyImage(img: ImageRef) {
  const url = await blobUrl(img.sha, img.mime)
  const ok = url ? await copyImageToClipboard(await loadImg(url)) : false
  flash(ok ? 'Image copied' : 'Could not copy the image', !ok)
}

export async function saveImage(img: ImageRef) {
  const url = await blobUrl(img.sha, img.mime)
  if (!url) return flash('The image is not on this computer', true)
  const a = document.createElement('a')
  a.href = url
  const ext = img.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  a.download = /\.[a-z0-9]{2,5}$/i.test(img.name) ? img.name : `${img.name || 'image'}.${ext}`
  a.click()
}

/* ---------- Ctrl+C on the picture under the mouse ---------- */

let hovered: ImageRef | null = null
let installed = false

/** Props for anything showing a picture: hovering it makes Ctrl+C copy it. */
export function hoverCopy(img: ImageRef) {
  install()
  return {
    onMouseEnter: () => (hovered = img),
    onMouseLeave: () => hovered?.sha === img.sha && (hovered = null),
  }
}

/** Forget the hovered picture (it went away with its element). */
export function clearHover(sha?: string) {
  if (!sha || hovered?.sha === sha) hovered = null
}

function install() {
  if (installed) return
  installed = true
  window.addEventListener('keydown', (e) => {
    if (!hovered || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return
    // Selected text wins: Ctrl+C keeps copying what you selected.
    if (window.getSelection()?.toString()) return
    const t = e.target as HTMLElement
    if ((t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).selectionStart !== (t as HTMLInputElement).selectionEnd) return
    e.preventDefault()
    copyImage(hovered)
  })
}
