import React, { useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import { buildExtensions } from '../editor/extensions'
import { useActiveEditor } from '../editor/activeEditor'
import { migrateLegacyHtml } from '../editor/columns'

interface Props {
  html: string
  editable?: boolean
  placeholder?: string
  spellcheck?: boolean
  onChange(html: string): void
  onSize?(w: number, h: number): void
  onFocus?(): void
  onPaste?(): void
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
  onPaste,
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
      content: migrateLegacyHtml(html),
      editable,
      editorProps: {
        attributes: { spellcheck: String(spellcheck) },
        handlePaste() {
          onPaste?.()
          return false
        },
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
      // A picked equation, image or drawing would stay outlined after a click on the
      // canvas or another cell: let go of it. Focus moving to a control (the assistant's
      // box, a toolbar) keeps it, since that control acts on it.
      onBlur({ editor, event }) {
        const to = (event as FocusEvent).relatedTarget as HTMLElement | null
        const sel = editor.state.selection
        if (!(sel instanceof NodeSelection) || (to && (!to.closest('.ProseMirror') || editor.view.dom.contains(to)))) return
        releasePick(editor)
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
      const was = editor.state.selection
      editor.commands.setContent(migrateLegacyHtml(html), false)
      keepCaret(editor, was)
    }
  }, [html, editor])

  // A picked equation, image or drawing stays picked while focus is in a control that
  // acts on it (the assistant's box, the toolbar). The next click anywhere else on the
  // page lets go of it, even though the editor lost focus long before.
  useEffect(() => {
    if (!editor) return
    const onDown = (e: PointerEvent) => {
      if (editor.isDestroyed || !(editor.state.selection instanceof NodeSelection)) return
      const t = e.target as HTMLElement | null
      if (!t || editor.view.dom.contains(t) || t.closest(KEEPS_PICK)) return
      releasePick(editor)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editor.isDestroyed && !editor.isFocused && editor.state.selection instanceof NodeSelection) releasePick(editor)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [editor])

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

/** Controls that act on a picked equation or image: a click in them keeps it picked. */
const KEEPS_PICK = '.agent-panel, .toolbar, .popover, .menu, [role="menu"], [role="dialog"], .math-block-editor, .math-inline-editor'

/** A caret where text can go, at or near `pos` (never a picked node). */
function textCaretNear(doc: any, pos: number): Selection | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  return Selection.findFrom($p, -1, true) || Selection.findFrom($p, 1, true)
}

/** Lets go of a picked equation, image or drawing, leaving the caret right after it. */
function releasePick(editor: any) {
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection)) return
  const next = textCaretNear(editor.state.doc, sel.to) || TextSelection.near(editor.state.doc.resolve(sel.to))
  if (next instanceof NodeSelection) return
  editor.view.dispatch(editor.state.tr.setSelection(next).setMeta('addToHistory', false))
}

/**
 * Content swapped in from outside (the assistant, undo, sync) maps the old selection to
 * the end of the new content, which picks a closing equation or image and leaves it
 * outlined for good. The caret goes back where it was instead, as plain text.
 */
function keepCaret(editor: any, was: Selection) {
  const doc = editor.state.doc
  if (was instanceof NodeSelection && editor.isFocused) {
    const n = doc.nodeAt(was.from)
    if (n && n.type === was.node.type) {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(doc, was.from)).setMeta('addToHistory', false))
      return
    }
  }
  const next = textCaretNear(doc, was.from)
  if (next) editor.view.dispatch(editor.state.tr.setSelection(next).setMeta('addToHistory', false))
}
