import React, { useEffect, useRef, useState } from 'react'
import { useActiveEditor } from '../editor/activeEditor'
import { storage } from '../lib/storage'
import { useStore } from '../store'
import { LinkI, X, Folder } from './Icons'

export default function LinkModal({ onClose }: { onClose(): void }) {
  const editor = useActiveEditor((s) => s.editor)
  const isDesktop = storage.isDesktop

  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [isExisting, setIsExisting] = useState(false)
  const urlInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editor) {
      const existingHref = editor.getAttributes('link').href || ''
      const { from, to, empty } = editor.state.selection
      const selectedText = empty ? '' : editor.state.doc.textBetween(from, to)

      const hasLink = Boolean(editor.isActive('link'))
      setIsExisting(hasLink)
      setUrl(existingHref)
      setText(selectedText)
    }
    urlInputRef.current?.focus()
    urlInputRef.current?.select()
  }, [editor])

  const handleBrowseFile = async () => {
    const filePath = await storage.openFileDialog()
    if (filePath) {
      const fileUrl = 'file:///' + filePath.replace(/\\/g, '/')
      setUrl(fileUrl)
      if (!text.trim()) {
        const baseName = filePath.split(/[\\/]/).pop() || ''
        setText(baseName)
      }
    }
  }

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    let finalUrl = url.trim()

    if (!finalUrl) {
      if (isExisting && editor) {
        editor.chain().focus().unsetLink().run()
      }
      onClose()
      return
    }

    // Convert Windows file paths (C:\... or \\...) to file:/// format
    if (/^[a-zA-Z]:[\\/]/.test(finalUrl)) {
      finalUrl = 'file:///' + finalUrl.replace(/\\/g, '/')
    } else if (finalUrl.startsWith('\\\\')) {
      finalUrl = 'file://' + finalUrl.replace(/\\/g, '/')
    } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl)) {
      finalUrl = 'https://' + finalUrl
    }

    const displayText = text.trim()

    if (editor) {
      const { from, to, empty } = editor.state.selection
      const selectedText = empty ? '' : editor.state.doc.textBetween(from, to)

      if (empty) {
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'text',
            text: displayText || finalUrl,
            marks: [{ type: 'link', attrs: { href: finalUrl } }],
          })
          .run()
      } else {
        if (displayText && displayText !== selectedText) {
          editor
            .chain()
            .focus()
            .insertContent({
              type: 'text',
              text: displayText,
              marks: [{ type: 'link', attrs: { href: finalUrl } }],
            })
            .run()
        } else {
          editor.chain().focus().setLink({ href: finalUrl }).run()
        }
      }
    } else {
      const st = useStore.getState()
      if (st.page) {
        const label = displayText || finalUrl
        st.addCell({
          html: `<p><a href="${finalUrl}" target="_blank" rel="noopener noreferrer">${label}</a></p>`,
        })
      }
    }

    onClose()
  }

  const handleRemove = () => {
    if (editor) {
      editor.chain().focus().unsetLink().run()
    }
    onClose()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal link-modal" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head">
          <LinkI />
          <h2>{isExisting ? 'Edit link' : 'Insert link'}</h2>
          <div className="spacer" />
          <button className="tb-btn" onClick={onClose}><X /></button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          <div className="link-field">
            <label>Link address (web URL or file path)</label>
            <div className="link-field-row">
              <input
                ref={urlInputRef}
                className="link-input"
                placeholder="https://example.com or file:///C:/path/file.html"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              {isDesktop && (
                <button
                  type="button"
                  className="btn"
                  title="Browse for local file"
                  onClick={handleBrowseFile}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Folder size={14} /> Browse...
                </button>
              )}
            </div>
          </div>

          <div className="link-field">
            <label>Text to display (optional)</label>
            <input
              className="link-input"
              placeholder={url || 'Display text'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <div className="link-modal-actions">
            {isExisting && (
              <button
                type="button"
                className="btn danger"
                onClick={handleRemove}
                style={{ marginRight: 'auto' }}
              >
                Remove link
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              {isExisting ? 'Save' : 'Insert'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
