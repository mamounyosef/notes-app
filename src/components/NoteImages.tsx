/**
 * Pictures inside notes: a full screen viewer (double click a picture), the
 * crop / turn / light editor, and quick turns from the right click menu.
 * Edits are non destructive: the node keeps the original picture and the
 * edit, so opening the editor again starts from the original and Reset
 * brings it back.
 */
import React from 'react'
import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { ChatAttachment, ImageEdit } from '../agent/api'
import { blankEdit, editOf, flip, isBlank, renderEdit, rotate } from '../agent/imageEdit'
import { Lightbox, type LightboxItem } from './agent/Lightbox'
import { ImageEditor } from './agent/ImageEditor'
import { flash } from './agent/imageCopy'
import { storage } from '../lib/storage'

type Open = { kind: 'view' | 'edit'; imgs: HTMLImageElement[]; index: number }

const useNoteImages = create<{ open: Open | null }>(() => ({ open: null }))

function mimeOf(src: string) {
  const data = /^data:([^;,]+)/i.exec(src)
  if (data) return data[1].toLowerCase()
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src)?.[1]?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif' || ext === 'webp' || ext === 'bmp') return `image/${ext}`
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/png'
}

function nameOf(img: HTMLImageElement) {
  const cell = img.closest('.cell')?.querySelector<HTMLInputElement>('.cell-title')?.value?.trim()
  return img.alt || cell || 'Image'
}

/** The editor and position of the image node that shows `img`. */
function locate(img: HTMLImageElement): { editor: Editor; pos: number } | null {
  const editor = (img.closest('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!editor || editor.isDestroyed) return null
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.type.name === 'image' && (editor.view.nodeDOM(pos) as HTMLElement | null)?.contains(img)) found = pos
  })
  return found >= 0 ? { editor, pos: found } : null
}

function setAttrs(img: HTMLImageElement, patch: Record<string, unknown>) {
  const at = locate(img)
  if (!at) return false
  const node = at.editor.state.doc.nodeAt(at.pos)
  if (!node) return false
  at.editor.view.dispatch(at.editor.state.tr.setNodeMarkup(at.pos, undefined, { ...node.attrs, ...patch }))
  return true
}

function attrsOf(img: HTMLImageElement) {
  const at = locate(img)
  return at ? at.editor.state.doc.nodeAt(at.pos)?.attrs ?? null : null
}

/** The note picture as the editor's attachment shape: the sha is the picture's link. */
function asAttachment(img: HTMLImageElement): ChatAttachment | null {
  const attrs = attrsOf(img)
  if (!attrs?.src) return null
  const att: ChatAttachment = { sha: attrs.src, mime: mimeOf(attrs.src), name: nameOf(img), size: 0, kind: 'image' }
  let edit: ImageEdit | undefined
  try {
    edit = attrs.edit ? JSON.parse(attrs.edit) : undefined
  } catch {
    edit = undefined
  }
  return edit?.orig?.sha ? { ...att, edit } : att
}

/** Bakes an edit into a new picture in the notes folder. */
async function saveNoteEdit(att: ChatAttachment, e: ImageEdit): Promise<ChatAttachment> {
  const { orig } = e
  if (isBlank(e)) {
    const { edit: _drop, ...rest } = att
    return { ...rest, sha: orig.sha, mime: orig.mime }
  }
  const mime = orig.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  const c = await renderEdit(e, mime)
  const dataUrl = c.toDataURL(mime, 0.92)
  const src = (await storage.saveAsset(dataUrl)) || dataUrl
  return { ...att, sha: src, mime, edit: e }
}

/**
 * Puts an edited picture back in the note. The shown width follows the
 * picture's new shape, so a turned or cropped picture keeps about the same
 * size on the page instead of stretching.
 */
async function applyToNode(img: HTMLImageElement, to: ChatAttachment) {
  const attrs = attrsOf(img)
  if (!attrs) return
  let width = attrs.width
  const oldW = img.naturalWidth
  const oldH = img.naturalHeight
  const shown = img.offsetWidth || Number(width) || oldW
  try {
    const next = new Image()
    next.src = to.sha
    await next.decode()
    if (oldW && oldH && next.naturalWidth && next.naturalHeight) {
      // Keep the shown area about the same: the long side stays as long as it was.
      const shownH = shown * (oldH / oldW)
      const long = Math.max(shown, shownH)
      const k = long / Math.max(next.naturalWidth, next.naturalHeight)
      width = Math.max(50, Math.round(next.naturalWidth * k))
    }
  } catch {
    /* keep the width it had */
  }
  setAttrs(img, { src: to.sha, edit: to.edit ? JSON.stringify(to.edit) : null, width, height: 'auto' })
}

/* ---------- actions for menus and the picture's own buttons ---------- */

/** All pictures on the page, top to bottom, so arrows can move through them. */
function pagePictures(): HTMLImageElement[] {
  const all = Array.from(document.querySelectorAll<HTMLImageElement>('.canvas .resizable-image img'))
  return all.sort((a, b) => {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left
  })
}

export function viewImage(img: HTMLImageElement) {
  ;(document.activeElement as HTMLElement | null)?.blur()
  const imgs = pagePictures()
  const index = imgs.indexOf(img)
  useNoteImages.setState({ open: index >= 0 ? { kind: 'view', imgs, index } : { kind: 'view', imgs: [img], index: 0 } })
}

export function editImage(img: HTMLImageElement) {
  ;(document.activeElement as HTMLElement | null)?.blur()
  useNoteImages.setState({ open: { kind: 'edit', imgs: [img], index: 0 } })
}

/** A turn or mirror straight from the menu, kept as an edit of the original. */
export async function quickImageEdit(img: HTMLImageElement, op: 'cw' | 'ccw' | 'h' | 'v' | 'reset') {
  const att = asAttachment(img)
  if (!att) return
  const e = editOf(att)
  const next = op === 'reset' ? blankEdit({ ...att, sha: e.orig.sha, mime: e.orig.mime }) : op === 'cw' ? rotate(e, 1) : op === 'ccw' ? rotate(e, -1) : flip(e, op)
  try {
    await applyToNode(img, await saveNoteEdit(att, { ...next, orig: e.orig }))
  } catch (err) {
    flash(err instanceof Error ? err.message : 'Could not change the image', true)
  }
}

export function isEditedImage(img: HTMLImageElement) {
  const att = asAttachment(img)
  return Boolean(att?.edit && !isBlank(att.edit))
}

/** Back to the size the picture was pasted at (capped like a fresh paste). */
export function resetImageSize(img: HTMLImageElement, maxW: number) {
  setAttrs(img, { width: Math.min(img.naturalWidth || maxW, maxW), height: 'auto' })
}

/* ---------- the overlay ---------- */

export function NoteImageHost() {
  const open = useNoteImages((s) => s.open)
  if (!open) return null
  const close = () => useNoteImages.setState({ open: null })

  if (open.kind === 'view') {
    const items: LightboxItem[] = open.imgs.map((img) => {
      const src = img.getAttribute('src') || ''
      return { sha: src, mime: mimeOf(src), name: nameOf(img) }
    })
    return (
      <Lightbox
        items={items}
        index={open.index}
        onClose={close}
        onEdit={(i) => editImage(open.imgs[i])}
      />
    )
  }

  const img = open.imgs[0]
  const att = img.isConnected ? asAttachment(img) : null
  if (!att) {
    queueMicrotask(close)
    return null
  }
  return (
    <ImageEditor
      items={[att]}
      index={0}
      save={saveNoteEdit}
      sizeTitle="Size of the picture in the note"
      onApply={(changes) => {
        for (const c of changes) void applyToNode(img, c.to)
      }}
      onClose={close}
    />
  )
}
