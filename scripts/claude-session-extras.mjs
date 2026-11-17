// Lists what Claude Code adds to a Notes assistant session besides our own messages:
// attachment entries and system-reminder text, with their sizes.
// Usage: node scripts/claude-session-extras.mjs <session.jsonl>
import fs from 'node:fs'

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
const seen = new Map()
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.type === 'attachment') {
    const a = e.attachment || {}
    const key = `attachment ${a.type}`
    const prev = seen.get(key) || { n: 0, chars: 0, sample: JSON.stringify(a).slice(0, 300) }
    seen.set(key, { ...prev, n: prev.n + 1, chars: prev.chars + l.length })
  }
  const c = e.message?.content
  for (const b of Array.isArray(c) ? c : []) {
    const t = typeof b.text === 'string' ? b.text : ''
    for (const m of t.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) {
      const key = `reminder ${m[1].trim().slice(0, 60).replace(/\s+/g, ' ')}`
      const prev = seen.get(key) || { n: 0, chars: 0, sample: m[1].slice(0, 300) }
      seen.set(key, { ...prev, n: prev.n + 1, chars: prev.chars + m[1].length })
    }
  }
}
for (const [k, v] of [...seen].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`${String(v.chars).padStart(8)} chars x${v.n}  ${k}`)
  console.log(`         ${v.sample.replace(/\s+/g, ' ').slice(0, 220)}`)
}
