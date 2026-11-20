/**
 * Helpers for showing a reply while it streams: split Markdown into blocks so
 * only the last one is parsed again on each frame, and tidy the unfinished tail
 * so half typed syntax (an open **, a formula, a link) never flashes as raw text.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/
const INDENTED = /^(?: {2,}|\t)\S/

/** Count of `$$` on a line, outside inline code. */
const displayMarks = (line: string) => (line.replace(/`[^`]*`/g, '').match(/\$\$/g) || []).length

/**
 * Top level Markdown blocks, split at blank lines. Never splits inside a code
 * fence or a $$ formula, and keeps a list (with its blank lines) in one block.
 * Joining the result with "\n\n" gives back equivalent Markdown.
 */
export function splitBlocks(md: string): string[] {
  const lines = md.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let fence = ''
  let inMath = false
  let gap = false
  let listy = false

  const push = () => {
    if (cur.length) blocks.push(cur.join('\n'))
    cur = []
    listy = false
  }

  for (const line of lines) {
    if (fence) {
      cur.push(line)
      if (line.trim().startsWith(fence)) fence = ''
      continue
    }
    if (inMath) {
      cur.push(line)
      if (displayMarks(line) % 2 === 1) inMath = false
      continue
    }
    if (!line.trim()) {
      if (cur.length) gap = true
      continue
    }
    if (gap) {
      gap = false
      // A list goes on after a blank line when the next line is another item or indented under one.
      const continues = listy && (LIST_ITEM.test(line) || INDENTED.test(line))
      if (continues) cur.push('')
      else push()
    }
    cur.push(line)
    if (LIST_ITEM.test(line)) listy = true
    const f = line.match(FENCE)
    if (f) fence = f[1][0].repeat(3)
    else if (displayMarks(line) % 2 === 1) inMath = true
  }
  push()
  return blocks
}

/**
 * The unfinished end of a streaming reply, made safe to render: an open bold or
 * strike is closed, inline code is closed, and a formula or link still being
 * typed is held back until it is complete.
 */
export function healTail(block: string): string {
  // Inside an open code fence the text is shown as code anyway.
  const fences = block.split('\n').filter((l) => FENCE.test(l)).length
  if (fences % 2 === 1) return block

  let t = block
  // A display formula still open: hold it back.
  const dd = t.lastIndexOf('$$')
  if (dd >= 0 && (t.match(/\$\$/g) || []).length % 2 === 1) t = t.slice(0, dd)

  // An inline formula still open ($ followed by something that is not a price).
  const singles = [...t.replace(/\$\$/g, '\u0000\u0000').matchAll(/(?<!\\)\$/g)].map((m) => m.index!)
  if (singles.length % 2 === 1) {
    const at = singles[singles.length - 1]
    if (!/^\$\d/.test(t.slice(at))) t = t.slice(0, at)
  }

  // A link or image being typed: show nothing of it until it closes.
  const link = t.match(/!?\[[^\]\n]*(?:\]\([^)\n]*)?$/)
  if (link && link.index !== undefined && !/\]\([^)]*\)$/.test(link[0])) t = t.slice(0, link.index)

  // Close open inline code, then bold and strike (outside that code).
  const ticks = (t.match(/(?<!`)`(?!`)/g) || []).length
  if (ticks % 2 === 1) t += '`'
  const plain = t.replace(/`[^`]*`/g, '')
  if ((plain.match(/\*\*/g) || []).length % 2 === 1) t = /\*\*\s*$/.test(t) ? t.replace(/\*\*\s*$/, '') : t + '**'
  if ((plain.match(/~~/g) || []).length % 2 === 1) t = /~~\s*$/.test(t) ? t.replace(/~~\s*$/, '') : t + '~~'
  // A lone list marker or heading mark with nothing after it yet.
  t = t.replace(/(^|\n)\s{0,3}(?:[-*+]|#{1,6}|\d{1,9}[.)])\s*$/, '$1')
  return t
}

/**
 * How many characters to show next frame. The shown text chases what has
 * arrived: it closes most of the gap within about a tenth of a second, never
 * slower than a steady reading pace, so bursts from the network turn into a
 * smooth, even flow.
 */
export function nextShown(shown: number, target: number, dtMs: number): number {
  if (shown >= target) return target
  const gap = target - shown
  const dt = Math.min(Math.max(dtMs, 0), 100)
  const chase = gap * (1 - Math.exp(-dt / 140))
  const floor = (dt / 1000) * 90
  return Math.min(target, shown + Math.max(chase, floor, 0.5))
}
