/**
 * Word style formatting: when the caret sits inside a word with nothing
 * selected, mark commands (bold, italic, underline, colour, highlight, font
 * size, clear formatting...) apply to that whole word, then the caret is put
 * back where it was. At a word edge nothing changes, so typing new bold text
 * still works as usual.
 *
 * This overrides Tiptap's core mark commands, so every toolbar button and
 * keyboard shortcut that goes through them gets the behaviour.
 */
import { Extension, extensions } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { ResolvedPos } from '@tiptap/pm/model'

const WORD_CHAR = /[\p{L}\p{M}\p{N}_'’]/u
const isWordChar = (ch: string | undefined) => !!ch && WORD_CHAR.test(ch)

/** Range of the word around the caret, or null when the caret is not strictly inside one. */
export function wordRangeAt($pos: ResolvedPos): { from: number; to: number } | null {
  const parent = $pos.parent
  if (!parent.isTextblock) return null
  const start = $pos.start()
  let text = ''
  const posOf: number[] = []
  // Text across differently formatted text nodes counts as one run. Any other
  // inline node (math, image, hard break) breaks the word.
  parent.forEach((child, offset) => {
    if (child.isText && child.text) {
      for (let i = 0; i < child.text.length; i++) {
        text += child.text[i]
        posOf.push(start + offset + i)
      }
    } else {
      text += '￼'
      posOf.push(start + offset)
    }
  })

  let idx = posOf.findIndex((p) => p >= $pos.pos)
  if (idx < 0) idx = text.length
  if (idx === 0 || idx === text.length) return null
  if (!isWordChar(text[idx - 1]) || !isWordChar(text[idx])) return null

  let a = idx - 1
  while (a > 0 && isWordChar(text[a - 1])) a--
  let b = idx
  while (b < text.length - 1 && isWordChar(text[b + 1])) b++
  return { from: posOf[a], to: posOf[b] + 1 }
}

const core: Record<string, any> = (extensions.Commands as any).config.addCommands()

function wordAware(name: 'toggleMark' | 'setMark' | 'unsetMark' | 'unsetAllMarks') {
  const original = core[name]
  return (...args: any[]) => (props: any) => {
    const { tr } = props
    // extendEmptyMarkRange means "the whole mark around the caret" (e.g. unset link): keep that.
    const opts = name === 'toggleMark' ? args[2] : name === 'unsetMark' ? args[1] : undefined
    if (!tr.selection.empty || opts?.extendEmptyMarkRange) return original(...args)(props)

    const range = wordRangeAt(tr.selection.$from)
    if (!range) return original(...args)(props)

    const caret = tr.selection.from
    tr.setSelection(TextSelection.create(tr.doc, range.from, range.to))
    const ok = original(...args)(props)
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(caret)))
    return ok
  }
}

export const WordFormatting = Extension.create({
  name: 'wordFormatting',
  // Lowest priority sorts last, so these win over the core commands of the same name.
  priority: 1,
  addCommands() {
    return {
      toggleMark: wordAware('toggleMark'),
      setMark: wordAware('setMark'),
      unsetMark: wordAware('unsetMark'),
      unsetAllMarks: wordAware('unsetAllMarks'),
    } as any
  },
})
