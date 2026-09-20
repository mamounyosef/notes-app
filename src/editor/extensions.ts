import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import { Extension, Mark, mergeAttributes, Node } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { BlockMath, InlineMath } from './math'
import { looksLikeMarkdown, markdownToHtml } from './markdown'
import { storage } from '../lib/storage'
import { useStore } from '../store'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType
      unsetFontSize: () => ReturnType
    }
    fontFamily2: {
      setFontFamily2: (family: string) => ReturnType
    }
  }
}

/** Font size / family as TextStyle attributes so they survive save + reload. */
export const FontSize = Extension.create({
  name: 'fontSize',
  addOptions: () => ({ types: ['textStyle'] }),
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el) => el.style.fontSize || null,
            renderHTML: (a) => (a.fontSize ? { style: `font-size:${a.fontSize}` } : {}),
          },
          fontFamily: {
            default: null,
            parseHTML: (el) => el.style.fontFamily || null,
            renderHTML: (a) => (a.fontFamily ? { style: `font-family:${a.fontFamily}` } : {}),
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      setFontSize:
        (size: string) =>
        ({ chain }: any) =>
          chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }: any) =>
          chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
      setFontFamily2:
        (family: string) =>
        ({ chain }: any) =>
          chain().setMark('textStyle', { fontFamily: family }).run(),
    } as any
  },
})

/** Inline `code` already exists; this adds a small keyboard-key style mark. */
export const Kbd = Mark.create({
  name: 'kbd',
  parseHTML: () => [{ tag: 'kbd' }],
  renderHTML: ({ HTMLAttributes }) => ['kbd', mergeAttributes(HTMLAttributes), 0],
})

/** Paste handling: images to the vault, Markdown to rich text, math preserved. */
export const SmartPaste = Extension.create({
  name: 'smartPaste',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            const cb = event.clipboardData
            if (!cb) return false

            const imageItem = Array.from(cb.items || []).find((it) => it.type.startsWith('image/'))
            if (imageItem) {
              const file = imageItem.getAsFile()
              if (file) {
                event.preventDefault()
                insertImageFile(editor, file)
                return true
              }
            }

            const html = cb.getData('text/html')
            const text = cb.getData('text/plain')
            const mode = pasteMode()
            if (mode === 'never' || !text) return false

            // Markdown-like plain text must win in auto mode so math delimiters,
            // emphasis, and blank-line paragraph breaks are parsed correctly.
            const preferMarkdown = mode === 'always' ? !!text : looksLikeMarkdown(text)
            if (preferMarkdown) {
              event.preventDefault()
              editor.commands.insertContent(markdownToHtml(text))
              return true
            }
            return false
          },
          handleDrop(_view, event) {
            const files = Array.from((event as DragEvent).dataTransfer?.files || [])
            const img = files.find((f) => f.type.startsWith('image/'))
            if (!img) return false
            event.preventDefault()
            insertImageFile(editor, img)
            return true
          },
        },
      }),
    ]
  },
})

/** Live paste preference, kept in sync from App so this module stays leaf-level. */
let currentPasteMode: 'auto' | 'always' | 'never' = 'auto'
export function setPasteMode(mode: 'auto' | 'always' | 'never') {
  currentPasteMode = mode
}
function pasteMode() {
  return currentPasteMode
}

import { ReactNodeViewRenderer } from '@tiptap/react'
import { ResizableImageNode } from './ResizableImage'

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => element.getAttribute('width'),
        renderHTML: (attributes) => {
          if (!attributes.width) return {}
          return { width: attributes.width }
        },
      },
      height: {
        default: null,
        parseHTML: (element) => element.getAttribute('height'),
        renderHTML: (attributes) => {
          if (!attributes.height) return {}
          return { height: attributes.height }
        },
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageNode)
  },
})

export async function insertImageFile(editor: any, file: File) {
  const dataUrl = await new Promise<string>((res) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.readAsDataURL(file)
  })

  const settings = useStore.getState().settings
  const maxW = settings.maxImageWidth || 800

  const img = new window.Image()
  img.src = dataUrl
  await new Promise((res) => {
    img.onload = res
    img.onerror = res
  })

  let width = img.width
  if (width > maxW) {
    width = maxW
  }

  const src = (await storage.saveAsset(dataUrl)) || dataUrl
  editor.chain().focus().setImage({ src, width }).run()
}

export const DraggableHorizontalRule = HorizontalRule.extend({
  draggable: true,
})

export const ThickHorizontalRule = Node.create({
  name: 'thickHorizontalRule',
  group: 'block',
  draggable: true,
  parseHTML() {
    return [{ tag: 'hr.thick-hr', priority: 100 }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['hr', mergeAttributes(HTMLAttributes, { class: 'thick-hr' })]
  },
  addCommands() {
    return {
      setThickHorizontalRule:
        () =>
        ({ chain }: any) => {
          return chain().insertContent({ type: this.name }).run()
        },
    } as any
  },
  addKeyboardShortcuts() {
    const shortcut = useStore.getState().settings.thickLineShortcut || 'Alt-s'
    return {
      [shortcut]: () => this.editor.commands.setThickHorizontalRule(),
    }
  },
})

export function buildExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      horizontalRule: false,
      heading: { levels: [1, 2, 3, 4] },
      codeBlock: { HTMLAttributes: { class: 'code-block' } },
      history: { depth: 200 },
    }),
    DraggableHorizontalRule,
    Underline,
    TextStyle,
    Color,
    FontSize,
    Kbd,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph', 'image'] }),
    Link.configure({ openOnClick: true, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } }),
    ResizableImage.configure({ inline: false, allowBase64: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    InlineMath,
    BlockMath,
    SmartPaste,
    ThickHorizontalRule,
    Placeholder.configure({ placeholder }),
  ]
}
