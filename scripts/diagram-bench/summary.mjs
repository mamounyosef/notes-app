// Prints outcome counts per engine and per task from the benchmark folder.
// Usage: node scripts/diagram-bench/summary.mjs config.json
import fs from 'node:fs'
import path from 'node:path'

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^﻿/, ''))
const metas = []
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (f.endsWith('meta.json')) metas.push(JSON.parse(fs.readFileSync(p, 'utf8')))
  }
}
walk(cfg.out)
const real = metas.filter((m) => m.status !== 'error')
const by = (key) => {
  const t = {}
  for (const m of real) {
    const k = m[key]
    const s = m.status.replace(' (timed out)', '')
    t[k] = t[k] || { jobs: 0 }
    t[k].jobs++
    t[k][s] = (t[k][s] || 0) + 1
    t[k].sec = (t[k].sec || 0) + (m.seconds || 0)
    t[k].left = (t[k].left || 0) + (m.drawings || []).reduce((n, d) => n + (d.lint?.length || 0), 0)
  }
  for (const v of Object.values(t)) { v.avgSec = Math.round(v.sec / v.jobs); delete v.sec }
  return t
}
console.log(`${metas.length} jobs recorded, ${real.length} finished (not service errors)`)
console.log('\nBY ENGINE'); console.table(by('engine'))
console.log('\nBY TASK'); console.table(by('task'))
console.log('\nBY MODEL'); console.table(by('model'))
