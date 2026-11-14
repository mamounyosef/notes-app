// Replays the <app_context> blocks of a real Claude session through contextDelta and reports the saving.
// Usage: node --experimental-strip-types scripts/claude-context-delta-sim.mts <session.jsonl>
import fs from 'node:fs'
import { contextDelta } from '../src/agent/contextDelta.ts'

const ctxs: string[] = []
for (const l of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  if (!l.includes('<app_context>')) continue
  const e = JSON.parse(l)
  const c = e.message?.content
  const t = typeof c === 'string' ? c : (c || []).map((b: any) => b.text || '').join('')
  const m = /<app_context>\n([\s\S]*?)\n<\/app_context>/.exec(t)
  if (m && !m[1].startsWith('Unchanged')) ctxs.push(m[1])
}
let full = 0, sent = 0
ctxs.forEach((c, i) => {
  const d = i ? contextDelta(ctxs[i - 1], c) : null
  full += c.length
  sent += (d ?? c).length
  console.log(`#${i}: ${c.length} chars -> ${(d ?? c).length}${d ? ' (delta)' : ' (full)'}`)
})
console.log(`total ${full} -> ${sent} chars (${Math.round((1 - sent / full) * 100)}% less)`)
