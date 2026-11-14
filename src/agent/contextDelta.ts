/**
 * Deltas of the app context (context.ts) for a model that keeps the whole
 * conversation (Claude): no imports, so node can test it directly.
 */

const PAGE_MARK = '\nPAGE CONTENT (top to bottom, all cells):\n'
const MENTION_MARK = '\n\nTHE USER POINTED AT THESE WITH @:'
const TREE_MARK = '\n\nNOTEBOOK TREE (notebook > section > page; ids in brackets):\n'
const TREE_END = /\n(?=Recently opened pages:|Favorites:|Total pages:)/

interface Parsed {
  head: string
  pageId: string | null
  cells: { id: string; key: string; text: string; lines: boolean }[]
  mentions: string
  tree: string
  tail: string
}

/** Splits a context built by buildContext back into its parts; null when it does not have the expected shape. */
function parseContext(full: string): Parsed | null {
  const t = full.indexOf(TREE_MARK)
  if (t < 0) return null
  const afterTree = full.slice(t + TREE_MARK.length)
  const end = afterTree.search(TREE_END)
  const tree = end >= 0 ? afterTree.slice(0, end) : afterTree
  const tail = end >= 0 ? afterTree.slice(end + 1) : ''
  let body = full.slice(0, t)
  let mentions = ''
  const mi = body.indexOf(MENTION_MARK)
  if (mi >= 0) {
    mentions = body.slice(mi + 2)
    body = body.slice(0, mi)
  }
  const pi = body.indexOf(PAGE_MARK)
  const head = pi >= 0 ? body.slice(0, pi) : body
  const pageId = /^OPEN PAGE: .*\[([^\]]+)\]$/m.exec(head)?.[1] || null
  const cells: Parsed['cells'] = []
  if (pi >= 0) {
    for (const part of body.slice(pi + PAGE_MARK.length).split(/\n\n(?=### Cell \[|Lines of \[)/)) {
      const id = /^(?:### Cell |Lines of )\[([^\]]+)\]/.exec(part)?.[1]
      if (!id) continue
      const lines = part.startsWith('Lines of ')
      // The on screen state is in the header's "Cells on screen" line: leave it out of the comparison.
      const key = lines ? part : part.replace(/^(### Cell \[[^\]]+\] ".*") - (?:ON SCREEN|PARTLY ON SCREEN.*|off screen.*)$/m, '$1')
      cells.push({ id, key, text: part, lines })
    }
  }
  return { head, pageId, cells, mentions, tree, tail }
}

/** A short hash of a string (FNV-1a), to remember cell versions without keeping their text. */
function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36) + s.length.toString(36)
}

/** Every cell of the open page in a context: id to a hash of its content and geometry. */
export function cellKeys(full: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of parseContext(full)?.cells || []) if (!c.lines) out[c.id] = hash(c.key)
  return out
}

/**
 * The context as a model that already saw `prev` (in the same conversation)
 * needs it: the header in full, then only the cells that are new or changed,
 * and the notebook tree only when it changed. Null when a delta is not safe
 * (another page, unexpected shape): send the full context then.
 */
export function contextDelta(prev: string, cur: string, mine?: Record<string, string> | null): string | null {
  const a = parseContext(prev)
  const b = parseContext(cur)
  if (!a || !b || !b.pageId || a.pageId !== b.pageId) return null
  const before = new Map(a.cells.filter((c) => !c.lines).map((c) => [c.id, c.key]))
  const cellsNow = b.cells.filter((c) => !c.lines)
  const differ = cellsNow.filter((c) => before.get(c.id) !== c.key)
  // Cells exactly as the model's own tool calls left them in its last reply: it knows them already.
  const yours = differ.filter((c) => mine?.[c.id] === hash(c.key))
  const changed = differ.filter((c) => !yours.includes(c))
  const same = cellsNow.length - differ.length
  const gone = [...before.keys()].filter((id) => !cellsNow.some((c) => c.id === id))
  // Little left out: the full context is clearer.
  const saved = cellsNow.filter((c) => before.get(c.id) === c.key || yours.includes(c)).reduce((n, c) => n + c.text.length, 0)
  if (saved + (b.tree === a.tree ? b.tree.length : 0) < 1500) return null

  const out: string[] = [b.head.trimEnd()]
  out.push(
    `PAGE CONTENT (delta: only what changed since the <app_context> of my previous message; ${same} cell${same === 1 ? '' : 's'} not shown here ${same === 1 ? 'is' : 'are'} exactly as you saw ${same === 1 ? 'it' : 'them'} there, apart from whether ${same === 1 ? 'it is' : 'they are'} on screen, which the header above says. Use read_cell if you need one again.)`,
  )
  if (yours.length) out.push(`Changed only by your own tool calls in your last reply, and exactly as they left them (not repeated): ${yours.map((c) => `[${c.id}]`).join(', ')}`)
  if (changed.length) out.push(...changed.map((c) => (before.has(c.id) ? `(CHANGED) ${c.text}` : `(NEW) ${c.text}`)))
  else if (!yours.length) out.push('No cell content changed.')
  if (gone.length) out.push(`Cells no longer on the page: ${gone.map((id) => `[${id}]`).join(', ')}`)
  out.push(...b.cells.filter((c) => c.lines).map((c) => c.text))
  let text = out.join('\n\n')
  if (b.mentions) text += `\n\n${b.mentions}`
  text += b.tree === a.tree ? '\n\nNOTEBOOK TREE: unchanged since my previous message.' : `${TREE_MARK}${b.tree}`
  if (b.tail) text += `\n${b.tail}`
  return text
}
