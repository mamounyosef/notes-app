/**
 * Copies of two small pure functions from the desktop editor
 * (src/editor/columns.ts and src/editor/math.ts), so showing a page does not
 * load the whole editor (TipTap) at start. Keep them in step with those files.
 */
/**
 * Drops the math delimiters people paste along with the formula: $$...$$,
 * $...$, \[...\] and \(...\), only when one pair wraps the whole text
 * (so "$a$ and $b$" is left alone). KaTeX would show them as an error.
 */
export function stripMathDelimiters(latex: string): string {
  let t = (latex || '').trim()
  for (;;) {
    const m =
      t.match(/^\$\$([\s\S]*)\$\$$/) ||
      t.match(/^\\\[([\s\S]*)\\\]$/) ||
      t.match(/^\\\(([\s\S]*)\\\)$/) ||
      t.match(/^\$([\s\S]*)\$$/)
    // The inside must not hold an unescaped $ of its own: then the pair did not wrap it all.
    if (!m || /(^|[^\\])\$/.test(m[1])) return t
    t = m[1].trim()
  }
}

/**
 * Old notes stored the vertical line as an inline span with hard-break +
 * spacer hacks for the text beside it. Convert those into real columns.
 */
export function migrateLegacyHtml(html: string): string {
  if (!html || (!html.includes('thick-vr') && !html.includes('align-spacer'))) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  doc.querySelectorAll('span.align-spacer').forEach((s) => s.remove())
  doc.querySelectorAll('span.thick-vr').forEach((vr) => {
    const block = vr.closest('p, h1, h2, h3, h4')
    if (!block || !vr.isConnected) {
      vr.remove()
      return
    }
    const before = doc.createRange()
    before.setStart(block, 0)
    before.setEndBefore(vr)
    const after = doc.createRange()
    after.setStartAfter(vr)
    after.setEnd(block, block.childNodes.length)
    const leftFrag = before.cloneContents()
    const rightFrag = after.cloneContents()

    const left = doc.createElement(block.tagName.toLowerCase())
    left.appendChild(leftFrag)
    const rightCol = doc.createElement('div')
    rightCol.setAttribute('data-type', 'column')
    let p = doc.createElement('p')
    Array.from(rightFrag.childNodes).forEach((n) => {
      if (n.nodeName === 'BR') {
        rightCol.appendChild(p)
        p = doc.createElement('p')
      } else p.appendChild(n)
    })
    rightCol.appendChild(p)

    const leftCol = doc.createElement('div')
    leftCol.setAttribute('data-type', 'column')
    leftCol.appendChild(left)
    const columns = doc.createElement('div')
    columns.setAttribute('data-type', 'columns')
    columns.setAttribute('data-divider', 'true')
    columns.append(leftCol, rightCol)
    block.replaceWith(columns)
  })
  doc.querySelectorAll('span.thick-vr').forEach((s) => s.remove())
  return doc.body.innerHTML
}
