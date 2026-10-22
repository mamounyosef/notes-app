import React, { useState } from 'react'
import type { ChatAttachment } from '../../agent/api'
import { fileToAttachment, prettySize } from '../../agent/files'
import { describeEdit, quickEdit } from '../../agent/imageEdit'
import { AttachmentThumb } from './Lightbox'
import { ImageEditor } from './ImageEditor'
import { CropI, File as FileIcon, RotateI, X } from '../Icons'

export interface PendingFile {
  id: number
  name: string
  status: string
  error?: string
}

type Update = (fn: (list: ChatAttachment[]) => ChatAttachment[]) => void

let pendingSeq = 0

/** Turns dropped, pasted or picked files into attachments, with a status chip for each while it works. */
export function useAddFiles(update: Update) {
  const [pending, setPending] = useState<PendingFile[]>([])
  const addFiles = async (files: File[]) => {
    for (const f of files) {
      const id = ++pendingSeq
      setPending((p) => [...p, { id, name: f.name || 'pasted image', status: 'Adding' }])
      try {
        const att = await fileToAttachment(f, (status) => setPending((p) => p.map((x) => (x.id === id ? { ...x, status } : x))))
        update((list) => [...list.filter((x) => x.sha !== att.sha), att])
        setPending((p) => p.filter((x) => x.id !== id))
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        setPending((p) => p.map((x) => (x.id === id ? { ...x, error } : x)))
        setTimeout(() => setPending((p) => p.filter((x) => x.id !== id)), 6000)
      }
    }
  }
  return { pending, addFiles, working: pending.some((p) => !p.error) }
}

/**
 * The pictures and files about to go with a message. Click a picture to
 * view and edit it (crop, turn, mirror, light); hover for a quick turn or
 * to take it out.
 */
export function AttachmentTray({ attachments, update, pending = [], children }: { attachments: ChatAttachment[]; update: Update; pending?: PendingFile[]; children?: React.ReactNode }) {
  const [editing, setEditing] = useState<number | null>(null)
  const [turning, setTurning] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<string | null>(null)
  const images = attachments.filter((a) => a.kind === 'image')
  const others = attachments.filter((a) => a.kind !== 'image')
  const remove = (sha: string) => update((list) => list.filter((a) => a.sha !== sha))
  const replace = (from: string, to: ChatAttachment) => update((list) => list.map((a) => (a.sha === from ? to : a)))

  const quickTurn = async (a: ChatAttachment) => {
    if (turning.has(a.sha)) return
    setTurning((s) => new Set(s).add(a.sha))
    try {
      replace(a.sha, await quickEdit(a, 'cw'))
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
      setTimeout(() => setFailed(null), 5000)
    } finally {
      setTurning((s) => {
        const n = new Set(s)
        n.delete(a.sha)
        return n
      })
    }
  }

  if (!children && !attachments.length && !pending.length && !failed) return null
  return (
    <div className="ag-chips">
      {children}
      {images.map((a, i) => {
        const how = describeEdit(a.edit)
        return (
          <div key={a.sha} className={`ag-chip img ${turning.has(a.sha) ? 'turning' : ''}`}>
            <AttachmentThumb att={a} onClick={() => setEditing(i)} title={`${a.name}${how ? ` (${how})` : ''}: click to view, crop or turn`} />
            {how && <span className="ag-edited" title={how}>edited</span>}
            <div className="ag-img-acts">
              <button onClick={() => quickTurn(a)} title="Turn right"><RotateI size={12} /></button>
              <button onClick={() => setEditing(i)} title="Crop, turn, mirror, fix the light"><CropI size={12} /></button>
              <button onClick={() => remove(a.sha)} title="Don't send this picture"><X size={12} /></button>
            </div>
          </div>
        )
      })}
      {others.map((a) => (
        <div key={a.sha} className="ag-chip file" title={a.name}>
          <FileIcon size={13} />
          <span className="n">{a.name}</span>
          <em>{a.pageCount ? `${a.pageCount} pages` : prettySize(a.size)}</em>
          <button onClick={() => remove(a.sha)} title="Don't send this file"><X size={11} /></button>
        </div>
      ))}
      {pending.map((p) => (
        <div key={p.id} className={`ag-chip file ${p.error ? 'err' : 'busy'}`} title={p.error || p.status}>
          <span className="n">{p.error || `${p.name}: ${p.status}`}</span>
        </div>
      ))}
      {failed && (
        <div className="ag-chip file err" title={failed}>
          <span className="n">{failed}</span>
        </div>
      )}
      {editing !== null && images.length > 0 && (
        <ImageEditor
          items={images}
          index={Math.min(editing, images.length - 1)}
          onApply={(changes) => update((list) => list.map((a) => changes.find((c) => c.from === a.sha)?.to || a))}
          onRemove={remove}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
