/**
 * KaTeX math for TipTap: inline ($x^2$) and block ($$ ... $$).
 * Click a formula to edit its LaTeX with a live KaTeX preview; Done/Enter saves, Esc cancels.
 */
import { Node, mergeAttributes, nodeInputRule } from '@tiptap/core'
import katex from 'katex'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      insertInlineMath: (latex?: string) => ReturnType
      insertBlockMath: (latex?: string) => ReturnType
    }
  }
}

/**
 * Drops the math delimiters people paste along with the formula: $$...$$,
 * $...$, \[...\] and \(...\), only when one pair wraps the whole text
 * (so "$a$ and $b$" is left alone). KaTeX would show them as an error.
 */
export function stripMathDelimiters(latex: string): string {
  let t = (latex || '').trim()
  for (;;) {
    const m =
      t.match(/^\$\$([\s\S]*)\$\$$/) ||
      t.match(/^\\\[([\s\S]*)\\\]$/) ||
      t.match(/^\\\(([\s\S]*)\\\)$/) ||
      t.match(/^\$([\s\S]*)\$$/)
    // The inside must not hold an unescaped $ of its own: then the pair did not wrap it all.
    if (!m || /(^|[^\\])\$/.test(m[1])) return t
    t = m[1].trim()
  }
}

function render(el: HTMLElement, latex: string, display: boolean) {
  el.innerHTML = ''
  const trimmed = stripMathDelimiters(latex)
  if (!trimmed) {
    const emptySpan = document.createElement('span')
    emptySpan.className = 'math-empty'
    emptySpan.textContent = display ? '[Empty LaTeX equation — click to edit]' : '[LaTeX]'
    el.appendChild(emptySpan)
    return
  }
  try {
    katex.render(trimmed, el, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
    })
  } catch {
    el.textContent = trimmed
  }
}

function makeNodeView(display: boolean) {
  return ({ node, editor, getPos }: any) => {
    const dom = document.createElement(display ? 'div' : 'span')
    dom.className = display ? 'math-block' : 'math-inline'
    dom.contentEditable = 'false'

    const view = document.createElement(display ? 'div' : 'span')
    view.className = 'math-render'
    render(view, node.attrs.latex, display)
    dom.appendChild(view)

    let editing = false
    let cleanupEdit: (() => void) | null = null

    const startEdit = () => {
      if (editing || !editor.isEditable) return
      editing = true

      if (display) {
        // Block math in-place card editor with live preview
        view.style.display = 'none'

        const card = document.createElement('div')
        card.className = 'math-block-editor'

        // Header
        const header = document.createElement('div')
        header.className = 'math-editor-header'

        const title = document.createElement('span')
        title.className = 'math-editor-title'
        title.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 5H7l6 7-6 7h11"/></svg><span>LaTeX Equation</span>`

        const actions = document.createElement('div')
        actions.className = 'math-editor-actions'

        const btnDelete = document.createElement('button')
        btnDelete.type = 'button'
        btnDelete.className = 'math-btn math-btn-danger'
        btnDelete.textContent = 'Delete'
        btnDelete.title = 'Delete equation'

        const btnCancel = document.createElement('button')
        btnCancel.type = 'button'
        btnCancel.className = 'math-btn'
        btnCancel.textContent = 'Cancel'
        btnCancel.title = 'Cancel editing (Esc)'

        const btnDone = document.createElement('button')
        btnDone.type = 'button'
        btnDone.className = 'math-btn math-btn-primary'
        btnDone.textContent = 'Done'
        btnDone.title = 'Apply changes (Ctrl+Enter)'

        actions.append(btnDelete, btnCancel, btnDone)
        header.append(title, actions)

        // Textarea
        const textarea = document.createElement('textarea')
        textarea.className = 'math-editor-textarea'
        textarea.value = node.attrs.latex || ''
        textarea.placeholder = 'Type LaTeX equation... e.g. \\int_0^1 f(x)\\,dx'
        textarea.spellcheck = false

        // Live preview
        const previewWrap = document.createElement('div')
        previewWrap.className = 'math-editor-preview-wrap'

        const previewLabel = document.createElement('div')
        previewLabel.className = 'math-editor-preview-label'
        previewLabel.textContent = 'Live Preview'

        const previewContent = document.createElement('div')
        previewContent.className = 'math-editor-preview'

        previewWrap.append(previewLabel, previewContent)

        // Footer hint
        const footer = document.createElement('div')
        footer.className = 'math-editor-footer'
        footer.innerHTML = `<span>Ctrl+Enter or Done to save • Esc to cancel</span><span>Shift+Enter for newline</span>`

        card.append(header, textarea, previewWrap, footer)
        dom.appendChild(card)

        const updatePreview = () => {
          render(previewContent, textarea.value, true)
          textarea.style.height = 'auto'
          textarea.style.height = `${Math.max(52, textarea.scrollHeight + 2)}px`
        }

        textarea.addEventListener('input', updatePreview)
        updatePreview()

        const stop = (e: Event) => e.stopPropagation()
        card.addEventListener('mousedown', stop)
        card.addEventListener('mouseup', stop)
        card.addEventListener('click', stop)
        card.addEventListener('pointerdown', stop)

        const finish = () => {
          if (cleanupEdit) {
            cleanupEdit()
            cleanupEdit = null
          }
          view.style.display = ''
          card.remove()
          editing = false
        }

        const commit = () => {
          if (!editing) return
          const latex = stripMathDelimiters(textarea.value)
          finish()
          const pos = typeof getPos === 'function' ? getPos() : null
          if (pos !== null && pos !== undefined) {
            editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { latex, autoEdit: false }))
          }
          render(view, latex, true)
          editor.commands.focus()
        }

        const cancel = () => {
          if (!editing) return
          finish()
          render(view, node.attrs.latex, true)
          editor.commands.focus()
        }

        const removeNode = () => {
          if (!editing) return
          finish()
          const pos = typeof getPos === 'function' ? getPos() : null
          if (pos !== null && pos !== undefined) {
            editor.view.dispatch(editor.view.state.tr.delete(pos, pos + node.nodeSize))
            editor.commands.focus()
          }
        }

        btnDone.addEventListener('click', commit)
        btnCancel.addEventListener('click', cancel)
        btnDelete.addEventListener('click', removeNode)

        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            commit()
          }
        }
        textarea.addEventListener('keydown', onKeyDown)

        const onDocMouseDown = (e: MouseEvent) => {
          if (!card.contains(e.target as Node)) {
            commit()
          }
        }

        const timer = setTimeout(() => {
          document.addEventListener('mousedown', onDocMouseDown, true)
        }, 80)

        cleanupEdit = () => {
          clearTimeout(timer)
          document.removeEventListener('mousedown', onDocMouseDown, true)
        }

        setTimeout(() => {
          textarea.focus()
          textarea.select()
        }, 20)
      } else {
        // Inline math floating popover editor
        const popover = document.createElement('div')
        popover.className = 'math-inline-popover'

        // Top row: input + done button + delete button
        const row = document.createElement('div')
        row.className = 'math-popover-row'

        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'math-popover-input'
        input.value = node.attrs.latex || ''
        input.placeholder = 'LaTeX... e.g. x^2'
        input.spellcheck = false

        const btnDone = document.createElement('button')
        btnDone.type = 'button'
        btnDone.className = 'math-btn math-btn-primary'
        btnDone.textContent = 'Done'
        btnDone.title = 'Apply (Enter)'

        const btnDelete = document.createElement('button')
        btnDelete.type = 'button'
        btnDelete.className = 'math-btn math-btn-danger'
        btnDelete.textContent = '✕'
        btnDelete.title = 'Delete'

        row.append(input, btnDone, btnDelete)

        // Preview box
        const previewWrap = document.createElement('div')
        previewWrap.className = 'math-popover-preview-wrap'

        const previewContent = document.createElement('span')
        previewContent.className = 'math-popover-preview'
        previewWrap.appendChild(previewContent)

        // Footer
        const footer = document.createElement('div')
        footer.className = 'math-popover-footer'
        footer.textContent = 'Enter to apply • Esc to cancel'

        popover.append(row, previewWrap, footer)
        dom.appendChild(popover)

        // Clamp popover within viewport horizontally
        const rect = dom.getBoundingClientRect()
        if (rect.left + 320 > window.innerWidth) {
          popover.style.right = '0'
          popover.style.left = 'auto'
        }

        const updatePreview = () => {
          render(previewContent, input.value, false)
        }
        input.addEventListener('input', updatePreview)
        updatePreview()

        const stop = (e: Event) => e.stopPropagation()
        popover.addEventListener('mousedown', stop)
        popover.addEventListener('mouseup', stop)
        popover.addEventListener('click', stop)
        popover.addEventListener('pointerdown', stop)

        const finish = () => {
          if (cleanupEdit) {
            cleanupEdit()
            cleanupEdit = null
          }
          popover.remove()
          editing = false
        }

        const commit = () => {
          if (!editing) return
          const latex = stripMathDelimiters(input.value)
          finish()
          const pos = typeof getPos === 'function' ? getPos() : null
          if (pos !== null && pos !== undefined) {
            editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { latex, autoEdit: false }))
          }
          render(view, latex, false)
          editor.commands.focus()
        }

        const cancel = () => {
          if (!editing) return
          finish()
          editor.commands.focus()
        }

        const removeNode = () => {
          if (!editing) return
          finish()
          const pos = typeof getPos === 'function' ? getPos() : null
          if (pos !== null && pos !== undefined) {
            editor.view.dispatch(editor.view.state.tr.delete(pos, pos + node.nodeSize))
            editor.commands.focus()
          }
        }

        btnDone.addEventListener('click', commit)
        btnDelete.addEventListener('click', removeNode)

        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }
        input.addEventListener('keydown', onKeyDown)

        const onDocMouseDown = (e: MouseEvent) => {
          if (!popover.contains(e.target as Node)) {
            commit()
          }
        }

        const timer = setTimeout(() => {
          document.addEventListener('mousedown', onDocMouseDown, true)
        }, 80)

        cleanupEdit = () => {
          clearTimeout(timer)
          document.removeEventListener('mousedown', onDocMouseDown, true)
        }

        setTimeout(() => {
          input.focus()
          input.select()
        }, 20)
      }
    }

    dom.addEventListener('click', (e) => {
      if (editing) return
      e.stopPropagation()
      startEdit()
    })

    if (node.attrs.autoEdit) {
      setTimeout(() => {
        if (!editing) startEdit()
      }, 50)
    }

    return {
      dom,
      stopEvent(event: Event) {
        if (editing) return true
        return false
      },
      ignoreMutation: () => true,
      update(updated: any) {
        if (updated.type.name !== node.type.name) return false
        node = updated
        if (!editing) render(view, updated.attrs.latex, display)
        return true
      },
      destroy() {
        if (cleanupEdit) cleanupEdit()
      },
    }
  }
}

const attrs = {
  latex: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') || el.textContent || '',
    renderHTML: (a: any) => ({ 'data-latex': a.latex }),
  },
  autoEdit: {
    default: false,
    rendered: false,
  },
}

export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => attrs,
  parseHTML: () => [{ tag: 'span[data-latex]' }],
  renderHTML: ({ HTMLAttributes, node }) => [
    'span',
    mergeAttributes(HTMLAttributes, { class: 'math-inline' }),
    node.attrs.latex,
  ],
  addNodeView: () => makeNodeView(false) as any,
  addCommands() {
    return {
      insertInlineMath:
        (latex = '') =>
        ({ commands }: any) =>
          commands.insertContent({ type: this.name, attrs: { latex: stripMathDelimiters(latex), autoEdit: true } }),
    } as any
  },
  addInputRules() {
    return [
      nodeInputRule({
        find: /(?:^|[^$])\$([^$\n]+)\$$/,
        type: this.type,
        getAttributes: (m) => ({ latex: m[1] }),
      }),
    ]
  },
})

export const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => attrs,
  parseHTML: () => [{ tag: 'div[data-latex]' }],
  renderHTML: ({ HTMLAttributes, node }) => [
    'div',
    mergeAttributes(HTMLAttributes, { class: 'math-block' }),
    node.attrs.latex,
  ],
  addNodeView: () => makeNodeView(true) as any,
  addCommands() {
    return {
      insertBlockMath:
        (latex = '') =>
        ({ commands }: any) =>
          commands.insertContent({ type: this.name, attrs: { latex: stripMathDelimiters(latex), autoEdit: true } }),
    } as any
  },
  addInputRules() {
    return [
      nodeInputRule({
        find: /\$\$([^$]+)\$\$$/,
        type: this.type,
        getAttributes: (m) => ({ latex: m[1].trim() }),
      }),
    ]
  },
})
