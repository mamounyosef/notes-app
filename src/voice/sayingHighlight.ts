/**
 * Voice mode: the sentence being spoken right now is highlighted in the chat,
 * like karaoke, so the text and the voice can be followed together.
 *
 * Uses the CSS Custom Highlight API: nothing in the rendered message changes,
 * a highlight is just painted over a Range (styled by ::highlight(voice-saying)
 * in voice.css). The spoken text went through speakable() and the chat shows
 * rendered Markdown, so the two are matched on letters and digits only.
 */

const NAME = 'voice-saying'

const hl = () => (globalThis as any).CSS?.highlights as Map<string, unknown> | undefined

export function clearSaying() {
  hl()?.delete(NAME)
}

/** Paints the sentence in the newest replies under `root`; false when it was not found. */
export function showSaying(root: HTMLElement | null, sentence: string): boolean {
  const reg = hl()
  const Highlight = (globalThis as any).Highlight
  if (!root || !reg || !Highlight) return false
  const want = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (want.length < 2) return false
  const blocks = [...root.querySelectorAll<HTMLElement>('.ag-reply .md')].slice(-4).reverse()
  for (const el of blocks) {
    const chars: { node: Text; i: number }[] = []
    let flat = ''
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      // MathML copies and code are never read out.
      acceptNode: (n) => ((n.parentElement?.closest('.katex-mathml, pre, .md-copy') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
    })
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const t = n.data
      for (let i = 0; i < t.length; i++) {
        const c = t[i].toLowerCase()
        if (/[\p{L}\p{N}]/u.test(c)) {
          chars.push({ node: n, i })
          flat += c
        }
      }
    }
    // The whole sentence, else its opening words (math reads differently than it shows).
    let at = flat.lastIndexOf(want)
    let len = want.length
    if (at < 0 && want.length > 24) {
      const head = want.slice(0, 24)
      at = flat.lastIndexOf(head)
      len = Math.min(want.length, flat.length - at)
    }
    if (at < 0) continue
    const a = chars[at]
    const b = chars[Math.min(chars.length - 1, at + len - 1)]
    const range = document.createRange()
    range.setStart(a.node, a.i)
    range.setEnd(b.node, b.i + 1)
    reg.set(NAME, new Highlight(range))
    // Keep it in view, gently, unless they scrolled away to read something else.
    const scroller = root
    const r = range.getBoundingClientRect()
    const box = scroller.getBoundingClientRect()
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240
    if (nearBottom && (r.bottom > box.bottom - 12 || r.top < box.top + 12)) {
      scroller.scrollBy({ top: r.top - box.top - box.height * 0.4, behavior: 'smooth' })
    }
    return true
  }
  reg.delete(NAME)
  return false
}

/**
 * Keeps the sentence lit while it is being said: a reply still streaming
 * re-renders its text, which drops the old Range, so it is found again after
 * every change. Returns a function that stops (and clears the highlight).
 */
export function followSaying(root: HTMLElement | null, sentence: string): () => void {
  if (!root || !sentence) {
    clearSaying()
    return () => {}
  }
  showSaying(root, sentence)
  let frame = 0
  const obs = new MutationObserver(() => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      showSaying(root, sentence)
    })
  })
  obs.observe(root, { childList: true, subtree: true, characterData: true })
  return () => {
    obs.disconnect()
    if (frame) cancelAnimationFrame(frame)
    clearSaying()
  }
}
