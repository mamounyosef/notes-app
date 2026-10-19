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

/**
 * Robust heuristic to determine if plain text looks like source code.
 */
export function looksLikeCode(text: string): { isCode: boolean; language: string | null } {
  if (!text || text.length < 8) return { isCode: false, language: null }
  const lines = text.trim().split('\n')
  if (lines.length < 2) return { isCode: false, language: null }

  // Markdown fenced code block (```lang ... ```)
  const fenceMatch = text.trim().match(/^```([a-zA-Z0-9_-]+)?\s*\n([\s\S]+?)\n```$/)
  if (fenceMatch) {
    return { isCode: true, language: fenceMatch[1]?.toLowerCase() || null }
  }

  // Strong programming language signatures:
  // Python:
  const isPython =
    /^(?:from\s+[a-zA-Z0-9_.]+\s+import|import\s+[a-zA-Z0-9_.]+)/m.test(text) ||
    /^\s*(?:def|class)\s+[a-zA-Z0-9_]+(?:\([^)]*\))?\s*:/m.test(text) ||
    /^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.test(text) ||
    (lines.filter((l) => /^\s*#\s+\S+/.test(l)).length >= 1 &&
      lines.filter((l) => /^\s*[a-zA-Z0-9_.]+\s*=\s*\S+/.test(l)).length >= 1)

  if (isPython) return { isCode: true, language: 'python' }

  // JavaScript / TypeScript:
  const isJsTs =
    /^\s*import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"][^'"]+['"]/m.test(text) ||
    /^\s*export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\b/m.test(text) ||
    /^\s*(?:const|let|var)\s+[a-zA-Z0-9_$]+\s*=\s*(?:require\(|\([^)]*\)\s*=>|function\b|new\s+\w+|[\{\[])/m.test(text) ||
    /^\s*(?:interface|type)\s+[A-Z]\w*(?:<[^>]+>)?\s*[={]/m.test(text) ||
    /console\.(?:log|error|warn|info)\(/m.test(text)

  if (isJsTs) {
    const isTs =
      /:\s*(?:string|number|boolean|any|void|unknown|never|Record<|Array<|Promise<)\b/.test(text) ||
      /^\s*(?:interface|type)\s+[A-Z]/m.test(text)
    return { isCode: true, language: isTs ? 'typescript' : 'javascript' }
  }

  // C / C++:
  const isCpp =
    /^#(?:include\s+[<"]|define\s+\w+)/m.test(text) ||
    /^\s*std::\w+/m.test(text) ||
    /^\s*(?:int|void|char|double|float|bool)\s+main\s*\(/m.test(text)
  if (isCpp) return { isCode: true, language: 'cpp' }

  // Java / C#:
  const isJava =
    /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:class|void|int|String|boolean)\s+\w+/m.test(text) ||
    /^\s*package\s+[a-zA-Z0-9_.]+;/m.test(text)
  if (isJava) return { isCode: true, language: 'java' }

  // Rust:
  const isRust =
    /^\s*(?:fn|pub\s+fn|pub\s+struct|pub\s+enum|impl(?:<[^>]+>)?)\s+\w+/m.test(text) ||
    /println!\(/.test(text)
  if (isRust) return { isCode: true, language: 'rust' }

  // Go:
  const isGo = /^\s*package\s+\w+/m.test(text) && /^\s*func\s+/m.test(text)
  if (isGo) return { isCode: true, language: 'go' }

  // HTML / XML:
  const isHtml =
    /^\s*<(?:!DOCTYPE\s+html|html|div|span|p|head|body|svg)\b[\s\S]*>/i.test(text) &&
    /<\/\w+>\s*$/m.test(text)
  if (isHtml) return { isCode: true, language: 'html' }

  // JSON:
  if (/^\s*\{[\s\S]*\}\s*$/.test(text) || /^\s*\[[\s\S]*\]\s*$/.test(text)) {
    try {
      JSON.parse(text)
      return { isCode: true, language: 'json' }
    } catch {}
  }

  // Shell / Bash:
  const isShell =
    /^#!\/(?:usr\/)?bin\/(?:bash|sh|zsh)/m.test(text) ||
    lines.every(
      (l) =>
        !l.trim() ||
        /^\s*(?:npm|npx|pnpm|yarn|cargo|git|docker|pip|python|node|brew|apt|curl|wget)\s+/.test(l),
    )
  if (isShell) return { isCode: true, language: 'bash' }

  // SQL:
  const isSql = /^\s*(?:SELECT\s+.*\s+FROM|INSERT\s+INTO|UPDATE\s+.*\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/im.test(text)
  if (isSql) return { isCode: true, language: 'sql' }

  // General heuristic for indented code with high symbol ratio:
  const codeLineCount = lines.filter((line) => {
    const l = line.trim()
    if (!l) return false
    return (
      /^[a-zA-Z0-9_.]+\s*=\s*.+/.test(l) ||
      /^[a-zA-Z0-9_.]+\([^)]*\)/.test(l) ||
      /[;{}]$/.test(l) ||
      /^(?:\/\/|#|\/\*)\s+/.test(l)
    )
  }).length

  const nonBlankLines = lines.filter((l) => l.trim().length > 0).length
  if (nonBlankLines >= 3 && codeLineCount / nonBlankLines >= 0.6) {
    return { isCode: true, language: null }
  }

  return { isCode: false, language: null }
}

/**
 * Checks if the text has mixed markdown prose around code blocks
 * (in which case it should be processed by the full markdown parser).
 */
export function looksLikeMixedMarkdown(text: string): boolean {
  if (!text.includes('```')) return false
  const trimmed = text.trim()
  const first = trimmed.indexOf('```')
  if (first !== 0) return true
  const second = trimmed.indexOf('```', 3)
  return second !== -1 && second < trimmed.length - 3
}
