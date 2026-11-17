// Breaks down the fixed part of a Notes assistant session (system prompt and tools), from its prompt_snapshot.
// Usage: node scripts/claude-prompt-size.mjs <session.jsonl>
import fs from 'node:fs'

const tok = (s) => Math.round(String(s || '').length / 3.6)
for (const l of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  if (!l.includes('"prompt_snapshot"')) continue
  const a = JSON.parse(l).attachment
  console.log('snapshot keys:', Object.keys(a).join(', '))
  const sys = [].concat(a.systemPrompt || [])
  sys.forEach((s, i) => console.log(`system[${i}]: ~${tok(s)} tok  ${String(s).slice(0, 80).replace(/\s+/g, ' ')}`))
  const tools = a.tools || a.toolSchemas || []
  const rows = tools.map((t) => ({ name: t.name, desc: tok(t.description), schema: tok(JSON.stringify(t.input_schema || t.inputSchema || {})) }))
  rows.sort((x, y) => y.desc + y.schema - (x.desc + x.schema))
  console.log(`tools: ${rows.length}, ~${rows.reduce((n, r) => n + r.desc + r.schema, 0)} tok`)
  for (const r of rows) console.log(`${String(r.desc + r.schema).padStart(6)}  ${r.name} (desc ${r.desc}, schema ${r.schema})`)
  for (const [k, v] of Object.entries(a)) if (!['systemPrompt', 'tools', 'type'].includes(k)) console.log(`${k}: ~${tok(JSON.stringify(v))} tok`)
  break
}
