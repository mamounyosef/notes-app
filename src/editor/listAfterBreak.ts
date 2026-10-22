/**
 * "1. ", "- " or "* " typed right after a line break (Shift+Enter) starts a
 * list, like it does at the start of a paragraph: the text after the break
 * becomes its own paragraph and is turned into the list. The built in rules
 * only look at the start of a paragraph, so the first item stayed plain text.
 */
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

export const ListAfterBreak = Extension.create({
  name: 'listAfterBreak',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== ' ' || from !== to || !editor.isEditable) return false
            const $from = view.state.doc.resolve(from)
            const para = $from.parent
            if (para.type.name !== 'paragraph' || $from.node(-1)?.type.name === 'listItem') return false
            // The last line break before the caret.
            let br = -1
            para.forEach((child, offset) => {
              const at = $from.start() + offset
              if (child.type.name === 'hardBreak' && at < from) br = at
            })
            if (br < 0) return false
            const m = view.state.doc.textBetween(br + 1, from).match(/^(?:(\d+)\.|([-*+]))$/)
            if (!m) return false
            const start = m[1] ? Number(m[1]) : 0
            const chain = editor
              .chain()
              .command(({ tr }) => {
                // Drop the break and the marker, then split there: the rest of the line is the new paragraph.
                tr.delete(br, from)
                tr.split(br)
                return true
              })
            if (m[1]) chain.toggleOrderedList()
            else chain.toggleBulletList()
            if (m[1] && start !== 1) chain.updateAttributes('orderedList', { start })
            return chain.run()
          },
        },
      }),
    ]
  },
})
