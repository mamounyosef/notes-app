/**
 * MathML to LaTeX. OneNote stores its equations as MathML inside the page
 * text, and this app stores maths as LaTeX, so every equation goes through
 * here. Covers the constructs Office actually emits.
 */

const OPERATORS = new Map(Object.entries({
  '−': '-',
  '⁢': '',        // invisible times
  '⁡': '',        // function application
  '×': '\\times',
  '÷': '\\div',
  '±': '\\pm',
  '∓': '\\mp',
  '≤': '\\le',
  '≥': '\\ge',
  '≠': '\\neq',
  '≈': '\\approx',
  '≡': '\\equiv',
  '∝': '\\propto',
  '∈': '\\in',
  '∉': '\\notin',
  '⊂': '\\subset',
  '⊆': '\\subseteq',
  '∪': '\\cup',
  '∩': '\\cap',
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '√': '\\sqrt',
  '∂': '\\partial',
  '∇': '\\nabla',
  '∞': '\\infty',
  '→': '\\to',
  '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow',
  '←': '\\leftarrow',
  '⋅': '\\cdot',
  '…': '\\dots',
  '⋯': '\\cdots',
  '⋮': '\\vdots',
  '⋱': '\\ddots',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '‖': '\\|',
  '′': "'",
  '∗': '*',
  '∘': '\\circ',
  '≅': '\\cong',
  '∷': '::',
  '∴': '\\therefore',
  '¬': '\\neg',
  '∧': '\\land',
  '∨': '\\lor',
  '∀': '\\forall',
  '∃': '\\exists',
}))

const LETTERS = new Map(Object.entries({
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\epsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
  'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
  'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho',
  'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi',
  'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Φ': '\\Phi',
  'Ψ': '\\Psi', 'Ω': '\\Omega',
  'ℂ': '\\mathbb{C}', 'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}',
  'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ᵓc': '\\mathbb{E}',
}))

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min',
  'arg', 'det', 'dim', 'gcd', 'sup', 'inf', 'sinh', 'cosh', 'tanh', 'softmax',
])

function escapeText(s) {
  return String(s).replace(/([%#&_{}$])/g, '\\$1')
}

function translateToken(text, kind) {
  let out = ''
  for (const ch of String(text)) {
    if (LETTERS.has(ch)) out += LETTERS.get(ch) + ' '
    else if (OPERATORS.has(ch)) out += OPERATORS.get(ch) + ' '
    else if (ch === '&') out += '\\&'
    else if (ch === '%') out += '\\%'
    else if (ch === '#') out += '\\#'
    else if (ch === '_') out += '\\_'
    else if (ch === '$') out += '\\$'
    else if (ch === '{' || ch === '}') out += '\\' + ch
    else if (ch === ' ') out += '\\,'
    else out += ch
  }
  out = out.trim()
  if (kind === 'mi' && FUNCTIONS.has(out)) return `\\${out}`
  if (kind === 'mi' && out.length > 1 && /^[A-Za-z]+$/.test(out)) return `\\mathrm{${out}}`
  return out
}

/** `node` is a DOM-like object: { tag, attrs, children, text }. */
export function mathmlToLatex(node) {
  const tag = node.tag
  const kids = node.children || []
  const seq = (list) => list.map((k) => mathmlToLatex(k)).filter((s) => s !== '').join(' ')
  const group = (n) => {
    const s = n ? mathmlToLatex(n) : ''
    return s.length === 1 || /^\\[A-Za-z]+$/.test(s) ? s : `{${s}}`
  }

  switch (tag) {
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'semantics':
      return seq(kids)
    case 'mi':
    case 'mn':
    case 'mo':
      return translateToken(node.text || '', tag)
    case 'mtext':
      return `\\text{${escapeText(node.text || '')}}`
    case 'mspace':
      return '\\;'
    case 'mfrac':
      return `\\frac${group(kids[0])}${group(kids[1])}`
    case 'msqrt':
      return `\\sqrt{${seq(kids)}}`
    case 'mroot':
      return `\\sqrt[${mathmlToLatex(kids[1])}]{${mathmlToLatex(kids[0])}}`
    case 'msub':
      return `${group(kids[0])}_${group(kids[1])}`
    case 'msup':
      return `${group(kids[0])}^${group(kids[1])}`
    case 'msubsup':
      return `${group(kids[0])}_${group(kids[1])}^${group(kids[2])}`
    case 'munder':
      return `\\underset{${mathmlToLatex(kids[1])}}{${mathmlToLatex(kids[0])}}`
    case 'mover': {
      const base = mathmlToLatex(kids[0])
      const over = mathmlToLatex(kids[1])
      if (over === '^') return `\\hat{${base}}`
      if (over === '˜' || over === '~') return `\\tilde{${base}}`
      if (over === '¯' || over === '_') return `\\overline{${base}}`
      if (over === '\\to') return `\\vec{${base}}`
      return `\\overset{${over}}{${base}}`
    }
    case 'munderover':
      return `${group(kids[0])}_${group(kids[1])}^${group(kids[2])}`
    case 'mfenced': {
      const open = node.attrs?.open ?? '('
      const close = node.attrs?.close ?? ')'
      return `\\left${fence(open)} ${seq(kids)} \\right${fence(close)}`
    }
    case 'mtable':
      return `\\begin{matrix} ${kids.map((r) => mathmlToLatex(r)).join(' \\\\ ')} \\end{matrix}`
    case 'mtr':
      return kids.map((c) => mathmlToLatex(c)).join(' & ')
    case 'mtd':
      return seq(kids)
    case 'mmultiscripts':
    case 'mpadded':
    case 'mphantom':
      return seq(kids)
    default:
      return seq(kids) || translateToken(node.text || '', 'mi')
  }
}

function fence(ch) {
  if (ch === '{' || ch === '}') return `\\${ch}`
  if (ch === '|') return '|'
  if (ch === '‖') return '\\|'
  if (ch === '⌊') return '\\lfloor'
  if (ch === '⌋') return '\\rfloor'
  if (ch === '⌈') return '\\lceil'
  if (ch === '⌉') return '\\rceil'
  if (ch === '⟨') return '\\langle'
  if (ch === '⟩') return '\\rangle'
  return ch || '.'
}

/**
 * Some OneNote equations arrive as plain fenced operators rather than
 * <mfenced>, which KaTeX handles fine, so nothing else is needed here.
 */
export function tidyLatex(tex) {
  return tex
    .replace(/\s+/g, ' ')
    .replace(/\s*([_^])\s*/g, '$1')
    .replace(/\{\s+/g, '{')
    .replace(/\s+\}/g, '}')
    .trim()
}
