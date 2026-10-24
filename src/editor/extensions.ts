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
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import { DOMSerializer } from '@tiptap/pm/model'
import { BlockMath, InlineMath } from './math'
import { ListAfterBreak } from './listAfterBreak'
import { htmlToMarkdown, looksLikeMarkdown, markdownToHtml } from './markdown'
import { latexDocumentToHtml, looksLikeLatexDocument } from './latexDocument'
import { storage } from '../lib/storage'
import { useStore } from '../store'
import { useActiveEditor } from './activeEditor'
import { ColumnsKit } from './columns'
import { WordFormatting } from './wordFormatting'
import { ConfigurableShortcuts } from './shortcuts'
import { ClickBelowBlock } from './clickBelow'
import { HtmlEmbed, looksLikeHtmlDocument } from './HtmlEmbed'
import {
  CustomCodeBlockLowlight,
  extractLanguageFromHtml,
  isCodeHtml,
  looksLikeCode,
  looksLikeMixedMarkdown,
} from './codeBlock'

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
          // Copied plain text is Markdown with LaTeX delimiters, not flattened text.
          clipboardTextSerializer(slice, view) {
            const div = document.createElement('div')
            div.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content))
            return htmlToMarkdown(div.innerHTML)
          },
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

            // Pasting inside an existing code block: insert plain text directly so newlines are preserved
            if (editor.isActive('codeBlock')) {
              const text = cb.getData('text/plain')
              if (text) {
                event.preventDefault()
                editor.commands.insertContent(text.replace(/\r\n?/g, '\n'))
                return true
              }
            }

            const html = cb.getData('text/html')
            const text = cb.getData('text/plain')
            const mode = pasteMode()
            if (mode === 'never' || !text) return false
            // Copied from this app: the rich HTML keeps colors and highlights the Markdown lacks.
            if (html.includes('data-pm-slice')) return false

            if (looksLikeLatexDocument(text)) {
              event.preventDefault()
              editor.commands.insertContent(latexDocumentToHtml(text))
              return true
            }

            if (looksLikeHtmlDocument(text)) {
              event.preventDefault()
              ;(editor.commands as any).insertHtmlEmbed(text)
              return true
            }

            // Code detection: if copied from a code block (HTML with code tags/classes/white-space:pre)
            // or if the plain text looks like a multi-line code snippet (e.g. from Claude's Copy button)
            const codeDetection = looksLikeCode(text)
            const htmlIsCode = isCodeHtml(html)
            const shouldPasteAsCode =
              (htmlIsCode &&
                (codeDetection.isCode ||
                  /<(?:pre|code)\b/i.test(html) ||
                  /class=["'][^"']*(?:token|hljs|shiki|cm-line|code-block)[^"']*/i.test(html)) &&
                text.trim().includes('\n')) ||
              (codeDetection.isCode && !looksLikeMixedMarkdown(text))

            if (shouldPasteAsCode) {
              event.preventDefault()
              const language = extractLanguageFromHtml(html) || codeDetection.language
              const cleanCode = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
              editor.commands.insertContent({
                type: 'codeBlock',
                attrs: { language },
                content: cleanCode ? [{ type: 'text', text: cleanCode }] : [],
              })
              return true
            }

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
          transformPastedHTML(html) {
            // If HTML contains inline newlines inside elements with white-space: pre / pre-wrap,
            // replace them with <br> so ProseMirror's paragraph parser doesn't collapse them to spaces.
            if (!html || !html.includes('\n')) return html
            try {
              const parser = new DOMParser()
              const doc = parser.parseFromString(html, 'text/html')
              const preWsNodes = doc.querySelectorAll('[style*="white-space"]')
              let modified = false
              preWsNodes.forEach((node) => {
                if (node.tagName === 'PRE') return
                const style = (node as HTMLElement).style.whiteSpace
                if (style && /pre/.test(style)) {
                  const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT)
                  const textNodes: Text[] = []
                  let cur: Node | null
                  while ((cur = walker.nextNode())) {
                    if (cur.nodeValue && cur.nodeValue.includes('\n')) {
                      textNodes.push(cur as Text)
                    }
                  }
                  textNodes.forEach((tn) => {
                    const parts = (tn.nodeValue || '').split('\n')
                    if (parts.length > 1) {
                      const frag = doc.createDocumentFragment()
                      parts.forEach((p, i) => {
                        if (i > 0) frag.appendChild(doc.createElement('br'))
                        if (p) frag.appendChild(doc.createTextNode(p))
                      })
                      tn.parentNode?.replaceChild(frag, tn)
                      modified = true
                    }
                  })
                }
              })
              return modified ? doc.body.innerHTML : html
            } catch {
              return html
            }
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
import { ResizableImageNode, copyImageToClipboard } from './ResizableImage'
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
      /** Crop, turn and light changes plus the original picture, as JSON (see NoteImages). */
      edit: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-edit'),
        renderHTML: (attributes) => {
          if (!attributes.edit) return {}
          return { 'data-edit': attributes.edit }
        },
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageNode)
  },
  addKeyboardShortcuts() {
    return {
      // Ctrl+C on a selected image copies the picture itself, not just the node.
      'Mod-c': () => {
        const { state, view } = this.editor
        const sel = state.selection
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== this.name) return false
        const img = (view.nodeDOM(sel.from) as HTMLElement | null)?.querySelector('img')
        if (!img) return false
        void copyImageToClipboard(img)
        return true
      },
    }
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
})

export const CustomShortcuts = Extension.create({
  name: 'customShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        useActiveEditor.getState().setLinkModalOpen(true)
        return true
      },
      'Mod-Shift-a': () => {
        useActiveEditor.getState().setArtifactModalOpen(true)
        return true
      },
    }
  },
})

export function buildExtensions(placeholder: string) {
  return [
    ColumnsKit,
    CustomShortcuts,
    StarterKit.configure({
      horizontalRule: false,
      heading: { levels: [1, 2, 3, 4] },
      codeBlock: false,
      history: { depth: 200 },
    }),
    ListAfterBreak,
    CustomCodeBlockLowlight,
    DraggableHorizontalRule,
    Underline,
    TextStyle,
    Color,
    FontSize,
    Kbd,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph', 'image', 'htmlEmbed'] }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      protocols: [
        'http',
        'https',
        'ftp',
        'mailto',
        'artifact',
        { scheme: 'file', optionalSlashes: true },
        { scheme: 'artifact', optionalSlashes: true },
      ],
      isAllowedUri: () => true,
      validate: (url: string) => {
        if (/^(?:https?|ftp|file|mailto|artifact):/i.test(url)) return true
        if (/^www\./i.test(url)) return true
        // Only autolink domain-like strings that end with recognized common web TLDs
        // Avoid treating Python method calls or object accesses like model.save_pretrained as links
        return /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.(?:com|org|net|edu|gov|io|ai|dev|co|app|info|me|xyz)(?:\/|\?|#|$)/i.test(url)
      },
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    }),
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
    WordFormatting,
    ConfigurableShortcuts,
    ThickHorizontalRule,
    HtmlEmbed,
    ClickBelowBlock,
    // includeChildren marks the empty line inside a new side column so CSS can hint there.
    Placeholder.configure({ placeholder, includeChildren: true }),
  ]
}
