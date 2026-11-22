/** The line a reply ends with to say which memories shaped it: [[mem: m4k2, m9ab]]. Pure, so it can be tested. */
// Ids may come bracketed themselves ("[[mem: [m4k2], [m9ab]]]"): a lone ] does not end it.
const MARK = /\s*\[\[\s*mem(?:ory|ories)?\s*:((?:[^\]]|\](?!\]))*)\]\]\]?\s*/gi

/** Splits a finished reply into its text and the memory ids it said it applied. */
export function takeMemoryMarker(content: string): { text: string; ids: string[] } {
  if (!content || !content.includes('[[')) return { text: content, ids: [] }
  const ids: string[] = []
  const text = content.replace(MARK, (_m, list: string) => {
    for (const id of String(list).match(/m[a-z0-9]{3,6}/gi) || []) ids.push(id.toLowerCase())
    return '\n'
  })
  return { text: text.replace(/\n{3,}/g, '\n\n').trimEnd(), ids: [...new Set(ids)] }
}

/** A reply still streaming: hides the marker, even half written. */
export function hideMemoryMarker(content: string): string {
  if (!content || !content.includes('[')) return content
  let t = content.replace(MARK, '\n')
  const at = t.lastIndexOf('[[')
  if (at >= 0 && !t.slice(at).includes(']]')) {
    const tail = t.slice(at + 2).trimStart().toLowerCase()
    if (!tail || 'mem'.startsWith(tail.slice(0, 3)) || tail.startsWith('mem')) t = t.slice(0, at)
  } else if (t.endsWith('[')) t = t.slice(0, -1)
  return t.trimEnd()
}

