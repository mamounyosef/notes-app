// Breaks down where time goes under one function in a saved profile (see profile.mjs).
// Usage: node scripts/perf/callees.mjs <profile.cpuprofile> <functionName> [depth=2]
import fs from 'node:fs'
import path from 'node:path'

const [file, fn, depthArg] = process.argv.slice(2)
const DEPTH = Number(depthArg || 2)
const prof = JSON.parse(fs.readFileSync(file, 'utf8'))
const byId = new Map(prof.nodes.map((n) => [n.id, n]))
const dt = new Map()
for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) || 0) + (prof.timeDeltas[i] || 0))
const totalOf = new Map()
const tot = (n) => {
  if (totalOf.has(n.id)) return totalOf.get(n.id)
  let t = (dt.get(n.id) || 0) / 1000
  for (const c of n.children || []) t += tot(byId.get(c))
  totalOf.set(n.id, t)
  return t
}
const name = (n) => `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url || '')}:${n.callFrame.lineNumber}`
// Merge every occurrence of fn (outermost only), then its callee tree by name.
const agg = new Map()
const add = (n, prefix, d, inFn) => {
  const isFn = n.callFrame.functionName === fn
  if (isFn && !inFn) {
    walk(n, 'ROOT', 0)
    return
  }
  for (const c of n.children || []) add(byId.get(c), prefix, d, inFn || isFn)
}
const walk = (n, key, d) => {
  agg.set(key, (agg.get(key) || 0) + tot(n))
  if (key === 'ROOT') agg.set('ROOT self', (agg.get('ROOT self') || 0) + (dt.get(n.id) || 0) / 1000)
  if (d >= DEPTH) return
  for (const c of n.children || []) {
    const cn = byId.get(c)
    walk(cn, `${key} > ${name(cn)}`, d + 1)
  }
}
add(prof.nodes[0], '', 0, false)
for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 50)) if (v >= 1) console.log(v.toFixed(1).padStart(8), k)
