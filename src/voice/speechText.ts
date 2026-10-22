/**
 * Voice mode: text that is spoken, and speech that is read.
 *
 * Pure helpers, no DOM, tested on their own (speechText.test.ts):
 *
 *   speakable()        Markdown and symbols out, words a voice can read in;
 *                      LaTeX is read the way a teacher says it ("x squared
 *                      over 2"), never as backslashes and braces
 *   mathSpeech()       that LaTeX reading on its own
 *   SentenceSplitter   a reply streaming in token by token, cut into whole
 *                      sentences the moment each one is complete, so the
 *                      voice starts on the first sentence while the model is
 *                      still writing the rest
 *   askSpeech()        an ask_user question, said out loud
 *   isUndoCommand()    "undo that" said on its own
 *
 * Ported from the weekly planner (src/lib/voice/speechText.ts), with the math
 * reading added for notes.
 */

// ---------------------------------------------------------------- math

const GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho sigma tau upsilon phi varphi chi psi omega'.split(' ')

const SYMBOLS: Array<[RegExp, string]> = [
  [/\\(?:cdot|times|ast)/g, ' times '],
  [/\\div/g, ' divided by '],
  [/\\pm/g, ' plus or minus '],
  [/\\mp/g, ' minus or plus '],
  [/\\(?:leq|le)\b/g, ' is less than or equal to '],
  [/\\(?:geq|ge)\b/g, ' is greater than or equal to '],
  [/\\(?:neq|ne)\b/g, ' is not equal to '],
  [/\\approx/g, ' is approximately '],
  [/\\equiv/g, ' is equivalent to '],
  [/\\propto/g, ' is proportional to '],
  [/\\infty/g, ' infinity '],
  [/\\(?:to|rightarrow|longrightarrow)\b/g, ' goes to '],
  [/\\(?:Rightarrow|implies)\b/g, ' implies '],
  [/\\(?:Leftrightarrow|iff)\b/g, ' if and only if '],
  [/\\in\b/g, ' in '],
  [/\\notin\b/g, ' not in '],
  [/\\subseteq\b/g, ' is a subset of '],
  [/\\cup\b/g, ' union '],
  [/\\cap\b/g, ' intersect '],
  [/\\forall\b/g, ' for all '],
  [/\\exists\b/g, ' there exists '],
  [/\\partial\b/g, ' partial '],
  [/\\nabla\b/g, ' nabla '],
  [/\\sum\b/g, ' the sum of '],
  [/\\prod\b/g, ' the product of '],
  [/\\int\b/g, ' the integral of '],
  [/\\lim\b/g, ' the limit of '],
  [/\\(log|ln|sin|cos|tan|exp|max|min|det)\b/g, ' $1 '],
  [/\\(?:dots|ldots|cdots)/g, ' and so on '],
  [/\\degree|\^\\circ/g, ' degrees '],
  [/\\%/g, ' percent '],
]

const POWERS: Record<string, string> = { '2': 'squared', '3': 'cubed' }

/**
 * LaTeX as a person would say it. Not a full parser: it covers what notes
 * hold (fractions, roots, powers, indices, Greek letters, relations) and drops
 * whatever formatting is left, so nothing is ever read as "backslash".
 */
export function mathSpeech(latex: string): string {
  let t = String(latex ?? '')
  t = t.replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|limits|,|;|!|quad|qquad)/g, ' ')
  t = t.replace(/\\(?:text|mathrm|mathbf|mathit|mathcal|mathbb|operatorname|boldsymbol)\s*\{([^{}]*)\}/g, ' $1 ')
  t = t.replace(/\\(?:hat|bar|vec|tilde|dot)\s*\{([^{}]*)\}/g, ' $1 ')
  // Innermost first, so nested fractions and roots read in order.
  for (let i = 0; i < 6; i++) {
    const before = t
    t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a, b) => ` ${wrap(a)} over ${wrap(b)} `)
    t = t.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_m, n, a) => ` the ${n === '3' ? 'cube' : `${n}th`} root of ${wrap(a)} `)
    t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, a) => ` the square root of ${wrap(a)} `)
    t = t.replace(/\^\s*\{([^{}]*)\}/g, (_m, a) => power(a))
    t = t.replace(/_\s*\{([^{}]*)\}/g, (_m, a) => ` sub ${a} `)
    if (t === before) break
  }
  t = t.replace(/\^\s*([A-Za-z0-9])/g, (_m, a) => power(a))
  t = t.replace(/_\s*([A-Za-z0-9])/g, ' sub $1 ')
  for (const [re, say] of SYMBOLS) t = t.replace(re, say)
  t = t.replace(/\\([A-Za-z]+)/g, (_m, w) => (GREEK.includes(w.toLowerCase()) ? ` ${w.replace(/^var/, '').toLowerCase()} ` : ' '))
  t = t.replace(/\s*<=\s*/g, ' is less than or equal to ').replace(/\s*>=\s*/g, ' is greater than or equal to ')
  t = t.replace(/\s*!=\s*/g, ' is not equal to ')
  t = t.replace(/\s*=\s*/g, ' equals ').replace(/\s*<\s*/g, ' is less than ').replace(/\s*>\s*/g, ' is greater than ')
  t = t.replace(/\s*\+\s*/g, ' plus ')
  t = t.replace(/(\S)\s*-\s*(\S)/g, '$1 minus $2').replace(/(^|\s)-\s*(\S)/g, '$1minus $2')
  t = t.replace(/\s*\/\s*/g, ' over ')
  t = t.replace(/(\d)\s*([a-zA-Z])(?![a-zA-Z])/g, '$1 $2')
  t = t.replace(/[{}\\&]/g, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

/** A compound part reads with a pause around it ("a plus b, over 2"). */
function wrap(a: string) {
  const s = a.trim()
  return /[+\-=]/.test(s) && s.length >= 3 ? `${s},` : s
}

function power(a: string) {
  const s = a.trim()
  if (POWERS[s]) return ` ${POWERS[s]} `
  if (s === 'T') return ' transpose '
  if (s === '-1') return ' inverse '
  return ` to the power of ${s} `
}

// ---------------------------------------------------------------- writing for the ear

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu

/**
 * What a voice should say for a piece of the model's Markdown. Formatting
 * goes, the words stay: "**Gradient** descent" -> "Gradient descent", a list
 * item loses its bullet, a note link keeps its title, math is read out.
 */
export function speakable(text: string): string {
  let t = String(text ?? '')
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/```[\s\S]*$/g, ' ')
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_m, m) => ` ${mathSpeech(m)}. `)
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_m, m) => ` ${mathSpeech(m)}. `)
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_m, m) => ` ${mathSpeech(m)} `)
  t = t.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\d)/g, (_m, pre, m) => `${pre} ${mathSpeech(m)} `)
  t = t.replace(/`([^`]*)`/g, '$1')
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  t = t.replace(/https?:\/\/\S+/g, 'a link')
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s*>\s?/gm, '')
  t = t.replace(/^\s*[-*+•]\s+\[[ xX]\]\s+/gm, '')
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
  t = t.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
  t = t.replace(/^[ \t]*\|/gm, '').replace(/\|[ \t]*$/gm, '')
  t = t.replace(/\s*\|\s*/g, ', ')
  t = t.replace(/==(.+?)==/g, '$1')
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2')
  t = t.replace(/(^|[^\w*])[*_](?!\s)([^*_\n]+?)[*_](?=[^\w*]|$)/g, '$1$2')
  t = t.replace(/[*_~#$]+/g, ' ')
  t = t.replace(EMOJI, ' ')
  // Dashes and arrows read as a pause or a word, never as symbols.
  t = t.replace(/\s*[—–]\s*/g, ', ')
  t = t.replace(/\s+-\s+/g, ', ')
  t = t.replace(/\s*(?:->|→|=>)\s*/g, ' to ')
  t = t.replace(/&/g, ' and ')
  t = t.replace(/\s+([,.!?;:])/g, '$1')
  t = t.replace(/([,.!?;:])(?:\s*[,.])+/g, '$1')
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(/^[,;:.]\s*/, '')
  return t
}

// ---------------------------------------------------------------- streaming into sentences

/** Words whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'fig', 'eq', 'ch', 'sec', 'vol',
  'approx', 'no', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'min', 'hr', 'hrs',
])

/** A long run with no full stop is cut at a comma once it reaches this. */
const SOFT_MAX = 180
/** ...and anywhere at all once it reaches this. */
const HARD_MAX = 320
/** The first piece may go to the voice early, at a comma, to start sooner. */
const FIRST_MIN = 40

/** Position i is inside $...$ or a code span, where nothing may be cut. */
function insideMarkup(s: string, i: number): boolean {
  const head = s.slice(0, i).replace(/\\\$/g, '')
  const display = (head.match(/\$\$/g) || []).length
  const single = (head.replace(/\$\$/g, '').match(/\$/g) || []).length
  const ticks = (head.match(/`/g) || []).length
  return display % 2 === 1 || single % 2 === 1 || ticks % 2 === 1
}

function endsSentenceAt(s: string, i: number): boolean {
  const ch = s[i]
  if (ch === '\n') return !insideMarkup(s, i)
  if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== ':' && ch !== ';') return false
  // Closing quotes and brackets belong to the sentence they close.
  let j = i + 1
  while (j < s.length && /["'”’)\]*]/.test(s[j])) j++
  if (j >= s.length) return false // unknown yet: more text may follow
  if (!/\s/.test(s[j])) return false // "3.5", "e.g.x", "10:30"
  if (insideMarkup(s, i)) return false
  if (ch === ':' || ch === ';') {
    // Only a colon before a new line is a break worth pausing on.
    let k = j
    while (k < s.length && s[k] === ' ') k++
    return s[k] === '\n'
  }
  if (ch === '.') {
    const word = /([A-Za-z.]+)$/.exec(s.slice(0, i))?.[1]?.toLowerCase() ?? ''
    if (ABBREVIATIONS.has(word)) {
      let k = j
      while (k < s.length && s[k] === ' ') k++
      if (!(word === 'a.m' || word === 'p.m') || !/[A-Z]/.test(s[k] ?? '')) return false
    }
    // An initial: "J. Smith". Until the letter after that capital has arrived, it cannot be told apart.
    if (/(^|\s)[A-Z]$/.test(s.slice(0, i)) && /^\s+([A-Z][a-z]|[A-Z]?$)/.test(s.slice(i + 1))) return false
  }
  return true
}

/**
 * Feed it the reply as it streams; it hands back each sentence once it is
 * complete. `push` takes the WHOLE text so far (not a delta), so a missed or
 * repeated stream update can never double or drop words.
 */
export class SentenceSplitter {
  private spoken = 0
  private emitted = 0

  /** Everything up to here has been handed out. */
  get position(): number {
    return this.spoken
  }

  push(full: string): string[] {
    const out: string[] = []
    if (full.length < this.spoken) this.spoken = 0 // a different text: start again
    for (;;) {
      const piece = this.next(full)
      if (piece === null) break
      if (piece) out.push(piece)
    }
    return out
  }

  /** The text is complete: whatever is left is the last sentence. */
  finish(full: string): string[] {
    const out = this.push(full)
    const rest = speakable(full.slice(this.spoken))
    this.spoken = full.length
    if (rest && /[\p{L}\p{N}]/u.test(rest)) {
      out.push(rest)
      this.emitted++
    }
    return out
  }

  reset(): void {
    this.spoken = 0
    this.emitted = 0
  }

  private next(full: string): string | null {
    const s = full.slice(this.spoken)
    if (!s.trim()) return null
    // A code or diagram block is never read: skip it whole once it is closed.
    const fence = /^\s*```/.exec(s)
    if (fence) {
      const close = s.indexOf('```', fence[0].length)
      if (close < 0) return null
      const end = s.indexOf('\n', close + 3)
      if (end < 0) return null
      this.spoken += end + 1
      return ''
    }
    let cut = -1
    for (let i = 0; i < s.length; i++) {
      if (s.startsWith('```', i)) {
        cut = i
        break
      }
      if (endsSentenceAt(s, i)) {
        cut = i + 1
        break
      }
    }
    if (cut === 0) return null
    if (cut < 0) {
      const soft = this.emitted === 0 ? FIRST_MIN : SOFT_MAX
      if (s.length >= soft) {
        // A clause break: a comma followed by more text, outside math.
        const window = s.slice(0, Math.min(s.length, HARD_MAX))
        const m = [...window.matchAll(/,\s/g)].filter((x) => (x.index ?? 0) >= Math.min(soft, 24) && !insideMarkup(s, x.index ?? 0)).pop()
        if (m && (this.emitted > 0 || s.length >= FIRST_MIN)) cut = (m.index ?? 0) + 1
      }
      if (cut < 0 && s.length >= HARD_MAX && !insideMarkup(s, HARD_MAX)) {
        const sp = s.lastIndexOf(' ', HARD_MAX)
        cut = sp > 0 ? sp : HARD_MAX
      }
      if (cut < 0) return null
    }
    // Swallow closing quotes/brackets that belong to the sentence.
    while (cut < s.length && /["'”’)\]]/.test(s[cut])) cut++
    this.spoken += cut
    const said = speakable(s.slice(0, cut))
    if (!said || !/[\p{L}\p{N}]/u.test(said)) return ''
    this.emitted++
    return said
  }
}

// ---------------------------------------------------------------- spoken answers

/** An ask_user card read out: the question, then its options. */
export function askSpeech(ask: { question: string; options?: string[] }): string {
  let q = speakable(ask.question)
  if (q && !/[.?!]$/.test(q)) q += '?'
  const opts = (ask.options || [])
    .map((o) => speakable(String(o).replace(/\s*\(Recommended\)\s*/i, '')).replace(/[.?!]+$/, ''))
    .filter(Boolean)
    .slice(0, 4)
  if (!opts.length) return q
  const choices = opts.length === 1 ? opts[0] : `${opts.slice(0, -1).join(', ')}, or ${opts[opts.length - 1]}`
  return `${q} ${choices}?`.trim()
}

/** "Undo that", "take it back": said on its own, it undoes the last change, no model involved. */
export function isUndoCommand(text: string): boolean {
  const t = String(text ?? '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return /^(?:(?:okay|ok|no|oh|hmm|actually|wait|please|hey|um|uh)\s)*(?:undo|undo (?:that|it|this|the (?:last )?(?:change|changes|edit))|take (?:that|it) back|revert (?:that|it|the (?:last )?changes?)|put it back)(?:\s(?:please|now))?$/.test(t)
}

/** Short acknowledgements that mean "go on", not "stop". */
export const BACKCHANNEL = /^(mm+[- ]?h?mm+|uh[- ]?huh|mhm|yeah|yes|yep|right|okay|ok|sure|got it|i see|cool|nice|great|alright|all right)[.!?, ]*$/i

export const wordCount = (s: string) => s.trim().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length

// ---------------------------------------------------------------- settings

/** One-tap pause lengths, in milliseconds. */
export const PAUSE_PRESETS = [
  { label: 'Quick', ms: 500 },
  { label: 'Balanced', ms: 800 },
  { label: 'Patient', ms: 1100 },
  { label: 'Relaxed', ms: 2000 },
  { label: 'Slow', ms: 3500 },
  { label: 'Unhurried', ms: 5500 },
  { label: 'Take your time', ms: 9000 },
]

/** What the engine itself waits before it writes down what it heard; it allows at most 2 s, and the rest is waited here. */
export const engineEndpointMs = (pauseMs: number) => Math.max(350, Math.min(2000, Math.round(pauseMs)))

/** Words (or a comma) people trail off on mid thought: the same list the engine uses. */
const TRAIL_OFF = /(\b(and|but|or|so|because|then|also|like|um|uh|er|the|a|an|to|for|with|at|on|in|of|my|is|are|if|when|that|which|maybe|actually)|,|-)\s*$/i

/**
 * How much silence ends the turn after hearing `text`: the pause, times the
 * trail off factor after "and", "um", a comma..., or times the mid-sentence
 * factor when it does not end like a finished sentence.
 */
export function turnWaitMs(text: string, p: { pauseMs: number; trailMult: number; midMult: number }): number {
  const t = text.trim()
  if (TRAIL_OFF.test(t)) return p.pauseMs * p.trailMult
  if (!/[.?!]["')\]]*$/.test(t)) return p.pauseMs * p.midMult
  return p.pauseMs
}
