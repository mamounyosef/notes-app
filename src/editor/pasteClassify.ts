/**
 * Decides what pasted plain text is: a code snippet, Markdown, or plain text.
 * Pure (no DOM, no editor imports) so it can be unit tested in Node.
 *
 * The old rule ("any <code> in the clipboard HTML means code") turned whole
 * Markdown answers with one inline `code` span into a code block. Now prose
 * wins: text that reads like sentences is never pasted as code.
 */

export type PasteKind =
  | { kind: 'code'; language: string | null; code?: string }
  | { kind: 'markdown' }
  | { kind: 'plain' }

/**
 * Robust heuristic to determine if plain text looks like source code.
 */
export function looksLikeCode(text: string): { isCode: boolean; language: string | null } {
  if (!text || text.length < 8) return { isCode: false, language: null }
  const lines = text.trim().split('\n')
  if (lines.length < 2) return { isCode: false, language: null }

  // Markdown fenced code block (```lang ... ```)
  const fenceMatch = text.trim().match(/^```([a-zA-Z0-9_+-]+)?[ \t]*\n([\s\S]+?)\n```$/)
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
    /^#!\/(?:usr\/)?bin\/(?:env\s+)?(?:bash|sh|zsh)/m.test(text) ||
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

const MARKDOWN_SIGNALS = [
  /^#{1,6}\s+\S/m, // heading
  /^\s*[-*+]\s+\S/m, // bullet
  /^\s*\d+[.)]\s+\S/m, // numbered item
  /^\s*>\s+\S/m, // quote
  /```|~~~/, // fence
  /\*\*[^*\n]+\*\*|__[^_\n]+__/, // bold
  /(?:^|[\s(])\*[^\s*][^*\n]*[^\s*]\*(?=[\s.,;:!?)]|$)/m, // italic
  /~~[^~\n]+~~/, // strike
  /==[^=\n]+==/, // highlight
  /\[[^\]\n]+\]\([^)\n]+\)/, // link
  /^\s*\|.+\|\s*$/m, // table row
  /\$\$[\s\S]+?\$\$|\$[^\s$][^$\n]*\$/, // math
  /\\\(|\\\[|\\begin\{/, // LaTeX math
  /^\s*(?:---|\*\*\*|___)\s*$/m, // rule
  /^[ \t]*<svg\b/im, // drawing
]

/** How many distinct Markdown features the text uses. */
export function markdownSignals(text: string) {
  if (!text || text.length < 2) return 0
  return MARKDOWN_SIGNALS.filter((re) => re.test(text)).length
}

const CODE_KEYWORD_START =
  /^(?:if|for|while|def|class|elif|else|try|except|finally|with|return|import|from|const|let|var|function|fn|pub|public|private|protected|static|async|await|switch|case|package|using|namespace|echo|print)\b/

/** A line that reads like a natural-language sentence, not a statement. */
export function isProseLine(line: string) {
  let l = line.trim()
  if (!l) return false
  // Comments, headings, tags.
  if (/^(?:#|\/\/|\/\*|\*\/|--|<|"""|''')/.test(l)) return false
  l = l.replace(/^(?:[-*+]|\d+[.)]|>)\s+/, '')
  if (CODE_KEYWORD_START.test(l)) return false
  if (/[;{]$/.test(l)) return false
  // Math and inline code are fine inside a sentence; judge the words around them.
  l = l.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|`[^`]*`/g, ' M ')
  if (/\w\.[a-z_]\w*\(|\b(?:self|this)\.|::|=>|->|\b[a-z]+_[a-z_]+\b/.test(l)) return false
  const symbols = (l.match(/[{}();=<>[\]]/g) || []).length
  if (symbols > 2) return false
  const words = l.match(/[A-Za-z][A-Za-z'’]*/g) || []
  if (words.length < 4) return false
  const letters = words.join('').length
  const nonSpace = l.replace(/\s/g, '').length
  return letters / nonSpace >= 0.6
}

/** Share of the text's lines that read like prose (code fences and comment blocks left out). */
export function proseRatio(text: string) {
  const body = text
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '')
  const lines = body.split('\n').filter((l) => l.trim())
  if (!lines.length) return 0
  return lines.filter(isProseLine).length / lines.length
}

/**
 * Classifies a paste. `htmlIsCode` says the clipboard HTML is code from end to end
 * (every bit of text sits in a <pre>, highlighter or monospace block), not merely
 * that it contains an inline <code> span somewhere.
 */
export function classifyPaste(text: string, htmlIsCode = false, htmlLanguage: string | null = null): PasteKind {
  const t = (text || '').replace(/\r\n?/g, '\n')
  if (!t.trim()) return { kind: 'plain' }

  const md = markdownSignals(t)
  const prose = proseRatio(t) >= 0.3
  const detected = looksLikeCode(t)
  // One fenced block and nothing else: the code is what is inside the fences.
  const fence = t.trim().match(/^(`{3,}|~{3,})([a-zA-Z0-9_+-]*)[^\n]*\n([\s\S]*?)\n?\1\s*$/)
  if (fence && !fence[3].includes(fence[1])) {
    return { kind: 'code', language: fence[2].toLowerCase() || null, code: fence[3] }
  }

  const multiline = t.trim().includes('\n')
  if (htmlIsCode && multiline && !(prose && md > 0)) {
    return { kind: 'code', language: htmlLanguage || detected.language }
  }
  if (detected.isCode && !prose && !looksLikeMixedMarkdown(t)) {
    return { kind: 'code', language: htmlLanguage || detected.language }
  }
  return md > 0 ? { kind: 'markdown' } : { kind: 'plain' }
}
