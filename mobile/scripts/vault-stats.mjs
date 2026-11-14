// Prints the size of the desktop notes folder (counts only, never content).
// Usage: node mobile/scripts/vault-stats.mjs
import fs from 'node:fs'
import path from 'node:path'

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'notesapp', 'config.json'), 'utf8'))
const vault = cfg.vaultPath || cfg.vault || path.join(process.env.USERPROFILE, 'Documents', 'MyNotes')
const size = (dir) => {
  let n = 0
  let bytes = 0
  let max = 0
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile()) continue
    const s = fs.statSync(path.join(dir, f.name)).size
    n++
    bytes += s
    max = Math.max(max, s)
  }
  return { files: n, mb: +(bytes / 1048576).toFixed(1), maxKb: Math.round(max / 1024) }
}
console.log('config keys:', Object.keys(cfg).join(', '))
console.log('cloud configured:', Boolean(cfg.cloud?.url && cfg.cloud?.key))
console.log('pages:', size(path.join(vault, 'pages')))
console.log('assets:', size(path.join(vault, 'assets')))
const ws = JSON.parse(fs.readFileSync(path.join(vault, 'workspace.json'), 'utf8'))
let nodes = 0
const walk = (a) => a.forEach((n) => (nodes++, walk(n.children || [])))
walk(ws.tree)
console.log('tree nodes:', nodes)
