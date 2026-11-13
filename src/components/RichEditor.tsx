import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
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
      // Nothing here draws from the editor state (the toolbar listens through bump), so
      // the component does not need to redraw on every keystroke and caret move.
      shouldRerenderOnTransaction: false,
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
  if (editor) skipNeedlessViewRebuild(editor)

  // Let go of the editor before tiptap's EditorContent unmounts: that would first redraw
  // the whole cell without its blocks, only for the editor to be destroyed right after.
  // (Not in development, where React mounts everything twice on purpose.)
  useLayoutEffect(() => {
    if (!editor || import.meta.env.DEV) return
    return () => {
      if (!editor.isDestroyed) editor.destroy()
    }
  }, [editor])

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
    const wrap = wrapRef.current
    if (!wrap) return
    // The ProseMirror element might be added asynchronously by Tiptap.
    // Observing the wrapper ensures we catch the change when PM is mounted and when it grows.
    return watchSize(wrap, () => {
      const pm = wrap.querySelector('.ProseMirror') as HTMLElement | null
      const h = pm ? pm.scrollHeight : wrap.scrollHeight
      const w = pm ? pm.scrollWidth : wrap.scrollWidth
      onSizeRef.current?.(w, h)
    })
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

/**
 * tiptap's EditorContent builds every node view again once it mounts, which draws the whole
 * cell a second time. That is only needed for blocks drawn by React (pictures, diagrams):
 * before there is a place to draw them they decline (a view without a DOM node) and show as
 * plain HTML until the rebuild. A cell without any such block skips it.
 */
const viewsChecked = new WeakSet<object>()
function skipNeedlessViewRebuild(editor: any) {
  if (viewsChecked.has(editor)) return
  viewsChecked.add(editor)
  const rebuild = editor.createNodeViews.bind(editor)
  let first = true
  editor.createNodeViews = () => {
    const skip = first && !editor.isDestroyed && !hasDeclinedView(editor.view?.docView)
    first = false
    if (!skip) rebuild()
  }
}

/** True when some node view in the drawn document declined to draw (or when unsure). */
function hasDeclinedView(desc: any): boolean {
  try {
    if (!desc) return true
    const walk = (d: any): boolean => {
      for (const c of d.children || []) {
        if (c.spec && !c.spec.dom) return true
        if (walk(c)) return true
      }
      return false
    }
    return walk(desc)
  } catch {
    return true
  }
}

/**
 * One ResizeObserver for every editor. A page opening sizes all its cells in one callback,
 * so the store changes in one go and the page redraws once, not once per cell.
 */
const sizeWatchers = new Map<Element, () => void>()
let sizeObserver: ResizeObserver | null = null
function watchSize(el: Element, fn: () => void): () => void {
  sizeObserver ??= new ResizeObserver((entries) => {
    for (const e of entries) sizeWatchers.get(e.target)?.()
  })
  sizeWatchers.set(el, fn)
  sizeObserver.observe(el)
  return () => {
    if (sizeWatchers.get(el) === fn) sizeWatchers.delete(el)
    sizeObserver?.unobserve(el)
  }
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
