import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { lowlight } from 'lowlight'
import { mergeAttributes } from '@tiptap/core'
import pythonOrig from 'highlight.js/lib/languages/python'
import javascriptOrig from 'highlight.js/lib/languages/javascript'
import typescriptOrig from 'highlight.js/lib/languages/typescript'

function createEnhancedPython(hljs: any) {
  const orig = pythonOrig(hljs)
  const MODULE_AFTER_FROM = {
    className: 'title.class',
    begin: /(?<=\bfrom\s+)[\w.]+(?=\s+import\b)/,
  }
  const IMPORTED_LOWERCASE = {
    className: 'title.function',
    begin: /(?<=\bimport\s+[^;\n]*)\b[a-z_]\w*\b/,
  }
  const FUNCTION_CALL = {
    className: 'title.function',
    begin: /\b[a-z_]\w*(?=\s*\()/,
  }
  const CLASS_NAME = {
    className: 'title.class',
    begin: /\b[A-Z]\w*\b/,
  }
  const PARAM_OR_VAR = {
    className: 'params',
    begin: /\b[a-zA-Z_]\w*(?=\s*=(?!=))/,
  }
  const OPERATOR = {
    className: 'operator',
    begin: /[-+*\/%=<>!&|^~]+/,
  }
  const PUNCTUATION = {
    className: 'punctuation',
    begin: /[.,:;(){}\[\]]/,
  }

  orig.contains.unshift(
    MODULE_AFTER_FROM,
    IMPORTED_LOWERCASE,
    FUNCTION_CALL,
    CLASS_NAME,
    PARAM_OR_VAR,
    OPERATOR,
    PUNCTUATION,
  )
  return orig
}

function createEnhancedJs(hljs: any) {
  const orig = javascriptOrig(hljs)
  const FUNCTION_CALL = {
    className: 'title.function',
    begin: /\b[a-z_$]\w*(?=\s*\()/,
  }
  const CLASS_NAME = {
    className: 'title.class',
    begin: /\b[A-Z]\w*\b/,
  }
  const PARAM_OR_VAR = {
    className: 'params',
    begin: /\b[a-zA-Z_$]\w*(?=\s*=(?!=))/,
  }
  const OPERATOR = {
    className: 'operator',
    begin: /[-+*\/%=<>!&|^~]+/,
  }
  const PUNCTUATION = {
    className: 'punctuation',
    begin: /[.,:;(){}\[\]]/,
  }

  orig.contains.unshift(
    FUNCTION_CALL,
    CLASS_NAME,
    PARAM_OR_VAR,
    OPERATOR,
    PUNCTUATION,
  )
  return orig
}

function createEnhancedTs(hljs: any) {
  const orig = typescriptOrig(hljs)
  const FUNCTION_CALL = {
    className: 'title.function',
    begin: /\b[a-z_$]\w*(?=\s*\()/,
  }
  const CLASS_NAME = {
    className: 'title.class',
    begin: /\b[A-Z]\w*\b/,
  }
  const PARAM_OR_VAR = {
    className: 'params',
    begin: /\b[a-zA-Z_$]\w*(?=\s*=(?!=))/,
  }
  const OPERATOR = {
    className: 'operator',
    begin: /[-+*\/%=<>!&|^~]+/,
  }
  const PUNCTUATION = {
    className: 'punctuation',
    begin: /[.,:;(){}\[\]]/,
  }

  orig.contains.unshift(
    FUNCTION_CALL,
    CLASS_NAME,
    PARAM_OR_VAR,
    OPERATOR,
    PUNCTUATION,
  )
  return orig
}

// Register enhanced grammars for rich VS Code style tokenization
lowlight.registerLanguage('python', createEnhancedPython)
lowlight.registerLanguage('py', createEnhancedPython)
lowlight.registerLanguage('javascript', createEnhancedJs)
lowlight.registerLanguage('js', createEnhancedJs)
lowlight.registerLanguage('typescript', createEnhancedTs)
lowlight.registerLanguage('ts', createEnhancedTs)

/**
 * Custom CodeBlock using lowlight for fast, rich syntax highlighting.
 * Includes a native NodeView with an easy one-click Copy button positioned in the bottom-right corner.
 * Renders `data-language` on the `<pre>` tag so CSS displays the language badge in the top-right.
 */
export const CustomCodeBlockLowlight = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const dom = document.createElement('div')
      dom.className = 'code-block-wrapper'

      const pre = document.createElement('pre')
      pre.className = 'code-block'
      const lang = node.attrs.language || ''
      if (lang) {
        pre.setAttribute('data-language', lang)
      }

      const code = document.createElement('code')
      if (lang) {
        code.className = `language-${lang}`
      }
      pre.appendChild(code)
      dom.appendChild(pre)

      const copyBtn = document.createElement('button')
      copyBtn.className = 'code-block-copy-btn'
      copyBtn.type = 'button'
      copyBtn.setAttribute('contenteditable', 'false')
      copyBtn.setAttribute('aria-label', 'Copy code')
      copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span>`

      copyBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const text = node.textContent
        void navigator.clipboard.writeText(text).then(() => {
          copyBtn.classList.add('copied')
          copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Copied!</span>`
          setTimeout(() => {
            copyBtn.classList.remove('copied')
            copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span>`
          }, 2000)
        })
      })

      dom.appendChild(copyBtn)

      return {
        dom,
        contentDOM: code,
        update(updatedNode) {
          if (updatedNode.type !== node.type) return false
          node = updatedNode
          const currentLang = node.attrs.language || ''
          if (currentLang) {
            pre.setAttribute('data-language', currentLang)
            code.className = `language-${currentLang}`
          } else {
            pre.removeAttribute('data-language')
            code.className = ''
          }
          return true
        },
        ignoreMutation(mutation) {
          return !dom.contains(mutation.target) || mutation.target === copyBtn || copyBtn.contains(mutation.target)
        },
      }
    }
  },

  renderHTML({ node, HTMLAttributes }) {
    const lang = node.attrs.language || ''
    return [
      'pre',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'code-block',
        'data-language': lang,
      }),
      [
        'code',
        {
          class: lang ? this.options.languageClassPrefix + lang : null,
        },
        0,
      ],
    ]
  },
}).configure({
  lowlight,
  exitOnTripleEnter: true,
  exitOnArrowDown: true,
})

/**
 * Checks if raw HTML copied to clipboard came from a code block,
 * syntax highlighter, or pre-formatted monospace element.
 */
export function isCodeHtml(html: string): boolean {
  if (!html) return false
  return (
    /<(?:pre|code)\b/i.test(html) ||
    /class=["'][^"']*(?:token|hljs|shiki|cm-line|code-block|monaco|syntax)[^"']*/i.test(html) ||
    /white-space:\s*pre/i.test(html) ||
    /font-family:[^;]*(?:monospace|Consolas|Menlo|Courier|SFMono|ui-monospace)/i.test(html)
  )
}

const CODE_CLASS = /(?:^|\s|-)(?:token|hljs|shiki|cm-line|cm-content|code-block|monaco|syntax|highlight|sourceCode)/i
const CODE_STYLE = /white-space:\s*pre|font-family:[^;]*(?:monospace|Consolas|Menlo|Courier|SFMono|ui-monospace|Cascadia|Fira Code|JetBrains Mono)/i

/**
 * True only when every piece of text in the clipboard HTML sits inside code
 * (a <pre>, a highlighter's element, or a monospace / pre-styled block).
 * An answer with one inline `code` span in its prose is not code.
 */
export function isWhollyCodeHtml(html: string): boolean {
  if (!isCodeHtml(html)) return false
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const inCode = (el: Element | null): boolean => {
      for (; el && el !== doc.body; el = el.parentElement) {
        if (el.tagName === 'PRE' || el.tagName === 'CODE') return true
        if (CODE_CLASS.test(el.getAttribute('class') || '')) return true
        if (CODE_STYLE.test(el.getAttribute('style') || '')) return true
      }
      return false
    }
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let any = false
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue?.trim()) continue
      any = true
      if (!inCode(n.parentElement)) return false
    }
    return any
  } catch {
    return false
  }
}

/**
 * Extracts language identifier from clipboard HTML (e.g. from Claude's code block
 * `<code class="language-python">` or `<span class="code-language">python</span>`).
 */
export function extractLanguageFromHtml(html: string): string | null {
  if (!html) return null
  const m =
    html.match(/(?:class=["'][^"']*(?:language-|lang-)|data-language=["']|data-lang=["'])([a-zA-Z0-9_-]+)/i) ||
    html.match(/<span[^>]*class=["'][^"']*code-language[^"']*["'][^>]*>([a-zA-Z0-9_-]+)<\/span>/i)
  if (m) {
    const lang = m[1].toLowerCase()
    if (lang !== 'plaintext' && lang !== 'text') return lang
  }
  return null
}

export { looksLikeCode, looksLikeMixedMarkdown } from './pasteClassify'
