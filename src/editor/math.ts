/**
 * KaTeX math for TipTap: inline ($x^2$) and block ($$ ... $$).
 * Click a formula to edit its LaTeX inline; Enter or blur re-renders it.
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

function render(el: HTMLElement, latex: string, display: boolean) {
  try {
    katex.render(latex || '\\;', el, { displayMode: display, throwOnError: false, output: 'html' })
  } catch {
    el.textContent = latex
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

    const startEdit = () => {
      if (editing || !editor.isEditable) return
      editing = true
      const input = document.createElement(display ? 'textarea' : 'input')
      input.className = 'math-input'
      input.value = node.attrs.latex
      if (display) (input as HTMLTextAreaElement).rows = Math.max(1, node.attrs.latex.split('\n').length)
      dom.replaceChildren(input)
      input.focus()
      input.select?.()

      const commit = () => {
        if (!editing) return
        editing = false
        const latex = input.value
        const pos = typeof getPos === 'function' ? getPos() : null
        if (pos !== null && pos !== undefined) {
          editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { latex }))
        }
        render(view, latex, display)
        dom.replaceChildren(view)
      }

      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (ev: Event) => {
        const e = ev as KeyboardEvent
        if (e.key === 'Escape' || (e.key === 'Enter' && (!display || !e.shiftKey))) {
          e.preventDefault()
          commit()
          editor.commands.focus()
        }
      })
    }

    dom.addEventListener('click', startEdit)

    return {
      dom,
      ignoreMutation: () => true,
      update(updated: any) {
        if (updated.type.name !== node.type.name) return false
        if (!editing) render(view, updated.attrs.latex, display)
        node = updated
        return true
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
          commands.insertContent({ type: this.name, attrs: { latex } }),
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
          commands.insertContent({ type: this.name, attrs: { latex } }),
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
