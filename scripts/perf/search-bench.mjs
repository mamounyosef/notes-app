// Times shared/search-core.mjs over a notes folder, the way the desktop app's search does it
// (page files parsed once and kept, then every query scored from memory).
// Usage: node scripts/perf/search-bench.mjs [vaultDir] [repeats=20]
// Default folder: the synthetic one run-perf.mjs makes. Also prints a checksum of the results,
// so a change to the engine can be checked to give exactly the same answers.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pageIndex, searchPages } from '../../shared/search-core.mjs'

const vault = process.argv[2] || path.join(os.tmpdir(), 'notes-perf-e2e', 'vault')
const REPEATS = Number(process.argv[3] || 20)
const tree = JSON.parse(fs.readFileSync(path.join(vault, 'workspace.json'), 'utf8')).tree || []
const index = pageIndex(tree)
const cache = new Map()
for (const id of index.keys()) {
  try {
    cache.set(id, JSON.parse(fs.readFileSync(path.join(vault, 'pages', `${id}.json`), 'utf8')))
  } catch {}
}
const queries = ['gradient', 'backpropogation', 'matrix vector', 'transformer attention softmax', 'xqzv', '"chain rule"', 'grad', 'eigenvalu']
const hash = crypto.createHash('sha1')
let total = 0
for (const q of queries) {
  const times = []
  for (let r = 0; r < REPEATS; r++) {
    // Fresh page objects each query, as main.ts builds them; the cells are the cached ones.
    const pages = [...index.keys()].filter((id) => cache.has(id)).map((id) => ({ ...cache.get(id), id, path: index.get(id).path, archived: index.get(id).archived }))
    const t0 = performance.now()
    const res = searchPages(q, pages, 1.8e12)
    times.push(performance.now() - t0)
    if (r === 0) hash.update(JSON.stringify(res))
  }
  times.sort((a, b) => a - b)
  const med = times[Math.floor(times.length / 2)]
  total += med
  console.log(q.padEnd(32), `median ${med.toFixed(2)}ms`)
}
console.log(`pages ${cache.size}, sum of medians ${total.toFixed(1)}ms, results checksum ${hash.digest('hex').slice(0, 16)}`)
