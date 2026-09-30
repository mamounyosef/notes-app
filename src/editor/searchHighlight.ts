/**
 * Temporarily paints every match of `query` inside `root` using the CSS Custom
 * Highlight API, so the editor DOM is never modified. Returns the first match
 * range (or null) so callers can scroll to it.
 */

const NAME = 'search-hit'
const FADE_NAME = 'search-hit-fade'
let timers: any[] = []

function registry(): Map<string, unknown> | null {
  const hl = (CSS as any).highlights
  return hl && typeof (window as any).Highlight === 'function' ? hl : null
}

export function clearSearchHighlight() {
  timers.forEach(clearTimeout)
  timers = []
  const reg = registry()
  reg?.delete(NAME)
  reg?.delete(FADE_NAME)
}

export function flashSearchMatches(root: HTMLElement, query: string, ms = 3000): Range | null {
  clearSearchHighlight()
  const needle = query.trim().toLowerCase()
  if (!needle) return null

  // Join all text nodes so matches that cross formatting (bold, links) still hit.
  const nodes: Text[] = []
  const starts: number[] = []
  let full = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    if (!t.data) continue
    nodes.push(t)
    starts.push(full.length)
    full += t.data
  }
  const hay = full.toLowerCase()

  const locate = (pos: number, isEnd: boolean): [Text, number] => {
    // Last node whose start is before pos (or at pos for a start boundary).
    let i = nodes.length - 1
    while (i > 0 && (isEnd ? starts[i] >= pos : starts[i] > pos)) i--
    return [nodes[i], pos - starts[i]]
  }

  const ranges: Range[] = []
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    const [sn, so] = locate(i, false)
    const [en, eo] = locate(i + needle.length, true)
    const r = document.createRange()
    r.setStart(sn, so)
    r.setEnd(en, eo)
    ranges.push(r)
  }
  if (!ranges.length) return null

  const reg = registry()
  if (reg) {
    const Highlight = (window as any).Highlight
    reg.set(NAME, new Highlight(...ranges))
    // Swap to a softer style near the end so it fades out rather than vanishing.
    timers.push(setTimeout(() => {
      reg.delete(NAME)
      reg.set(FADE_NAME, new Highlight(...ranges))
    }, Math.max(0, ms - 600)))
    timers.push(setTimeout(clearSearchHighlight, ms))
  }
  return ranges[0]
}
