// Breaks down where a Notes assistant Claude session's context goes.
// Usage: node scripts/claude-context-report.mjs <session.jsonl>
import fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/claude-context-report.mjs <session.jsonl>')
  process.exit(1)
}
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const tok = (s) => Math.round(String(s || '').length / 3.6)
// Image tokens from the real pixel size (w*h/750), read from the PNG or JPEG header.
const imgTok = (b64) => {
  try {
    const b = Buffer.from(String(b64 || '').slice(0, 200000), 'base64')
    let w = 0, h = 0
    if (b[0] === 0x89) { w = b.readUInt32BE(16); h = b.readUInt32BE(20) }
    else if (b[0] === 0xff) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue }
        const m = b[i + 1]
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break }
        i += 2 + b.readUInt16BE(i + 2)
      }
    }
    return w && h ? Math.round((w * h) / 750) : 1600
  } catch { return 1600 }
}
const sizes = []
const IMG_OF = (p) => { const t = imgTok(p.data || p.source?.data); sizes.push(t); return t }
const by = {}
const add = (k, n) => (by[k] = (by[k] || 0) + n)
const toolNames = {}
const turns = []
let ctxCount = 0
let ctxTok = 0

for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.type === 'assistant') {
    const u = e.message?.usage
    if (u) turns.push((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0))
    for (const b of e.message?.content || []) {
      if (b.type === 'tool_use') {
        toolNames[b.id] = b.name.replace('mcp__notes__', '')
        add(`tool input: ${toolNames[b.id]}`, tok(JSON.stringify(b.input)))
      } else if (b.type === 'text') add('assistant text', tok(b.text))
      else if (b.type === 'thinking') add('thinking (dropped later)', tok(b.thinking))
    }
  } else if (e.type === 'user') {
    const c = e.message?.content
    if (typeof c === 'string') { add('user text', tok(c)); continue }
    for (const b of c || []) {
      if (b.type === 'tool_result') {
        const name = toolNames[b.tool_use_id] || '?'
        const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: b.content }]
        for (const p of parts) {
          if (p.type === 'image') add(`tool result image: ${name}`, IMG_OF(p))
          else add(`tool result: ${name}`, tok(p.text))
        }
      } else if (b.type === 'image') add('user image', IMG_OF(b))
      else if (b.type === 'document') add('user document', tok(b.source?.data) / 2)
      else if (b.type === 'text') {
        const m = b.text.match(/<app_context>([\s\S]*?)<\/app_context>/)
        if (m) { ctxCount++; ctxTok += tok(m[1]); add('user app_context', tok(m[1])); add('user text', tok(b.text) - tok(m[1])) }
        else add('user text', tok(b.text))
      }
    }
  }
}
console.log(`API calls: ${turns.length}, last context: ${turns.at(-1)}, max: ${Math.max(...turns)}`)
console.log(`Sum of context over all calls: ${turns.reduce((a, b) => a + b, 0)}`)
console.log(`app_context blocks: ${ctxCount}, avg ${Math.round(ctxTok / (ctxCount || 1))} tok`)
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(String(v).padStart(8), k)
console.log('first calls context:', turns.slice(0, 5).join(', '))
console.log('image tokens each:', sizes.join(', '))
// Biggest jumps between consecutive API calls, and the entries that came in between.
if (process.argv[3] === '--jumps') {
  let prev = 0, between = []
  for (const l of lines) {
    let e; try { e = JSON.parse(l) } catch { continue }
    const u = e.type === 'assistant' && e.message?.usage
    if (u) {
      const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (n - prev > 8000) console.log(`+${n - prev} -> ${n}:`, between.join(' | ').slice(0, 400))
      if (n) prev = n
      between = []
    } else between.push(`${e.type}${e.subtype ? '/' + e.subtype : ''}:${l.length}`)
  }
}
