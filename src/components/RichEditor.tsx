import React, { useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { buildExtensions } from '../editor/extensions'
import { useActiveEditor } from '../editor/activeEditor'

interface Props {
  html: string
  editable?: boolean
  placeholder?: string
  spellcheck?: boolean
  onChange(html: string): void
  onSize?(w: number, h: number): void
  onFocus?(): void
  /** Backspace in an empty editor bubbles up so the cell can delete itself. */
  onEmptyBackspace?(): void
}

export default function RichEditor({
  html,
  editable = true,
  placeholder = 'Type here. Markdown and LaTeX are understood.',
  spellcheck = true,
  onChange,
  onSize,
  onFocus,
  onEmptyBackspace,
}: Props) {
  const extensions = useMemo(() => buildExtensions(placeholder), [placeholder])
  const setActive = useActiveEditor((s) => s.setEditor)
  const bump = useActiveEditor((s) => s.bump)
  const lastEmitted = useRef(html)
  const wrapRef = useRef<HTMLDivElement>(null)

  const editor = useEditor(
    {
      extensions,
      content: html,
      editable,
      editorProps: {
        attributes: { spellcheck: String(spellcheck) },
        handleKeyDown(view, event) {
          // Escape steps out of the text and selects the cell itself, so the
          // next Delete removes the cell rather than a character.
          if (event.key === 'Escape') {
            ;(view.dom as HTMLElement).blur()
            return true
          }
          if (event.key === 'Backspace' && onEmptyBackspace) {
            const empty = view.state.doc.textContent.length === 0 && view.state.doc.childCount <= 1
            if (empty) {
              event.preventDefault()
              onEmptyBackspace()
              return true
            }
          }
          return false
        },
      },
      onUpdate({ editor }) {
        const next = editor.getHTML()
        lastEmitted.current = next
        onChange(next)
      },
      onSelectionUpdate: bump,
      onTransaction: bump,
      onFocus({ editor }) {
        setActive(editor)
        onFocus?.()
      },
    },
    [extensions],
  )

  // Outside changes (undo, page switch) push new content in without
  // stomping on what the user is currently typing.
  useEffect(() => {
    if (!editor) return
    if (html !== lastEmitted.current && html !== editor.getHTML()) {
      lastEmitted.current = html
      editor.commands.setContent(html, false)
    }
  }, [html, editor])

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editable, editor])

  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  // Report the natural content height and width so cells can auto-grow.
  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(() => {
      const pm = wrapRef.current?.querySelector('.ProseMirror') as HTMLElement | null
      const h = pm ? pm.scrollHeight : wrapRef.current!.scrollHeight
      const w = pm ? pm.scrollWidth : wrapRef.current!.scrollWidth
      onSizeRef.current?.(w, h)
    })
    // The ProseMirror element might be added asynchronously by Tiptap.
    // Observing the wrapper ensures we catch the change when PM is mounted and when it grows.
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [editor])

  useEffect(() => {
    return () => {
      if (useActiveEditor.getState().editor === editor) setActive(null)
    }
  }, [editor, setActive])

  return (
    <div ref={wrapRef} className="rich">
      <EditorContent editor={editor} />
    </div>
  )
}
