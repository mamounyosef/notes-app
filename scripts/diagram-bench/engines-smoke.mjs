// Smoke test: Graphviz and TikZ each turn a tiny source into SVG under Node.
// Usage: node scripts/diagram-bench/engines-smoke.mjs <outDir>
import fs from 'node:fs'
import path from 'node:path'

const out = process.argv[2] || '.'
fs.mkdirSync(out, { recursive: true })
const t0 = Date.now()
const lap = (s) => console.log(s, Date.now() - t0, 'ms')

const { Graphviz } = await import('@hpcc-js/wasm-graphviz')
const gv = await Graphviz.load()
fs.writeFileSync(path.join(out, 'gv.svg'), gv.dot('digraph { rankdir=BT; a [shape=box, style="rounded,filled"]; a -> b -> c; a -> c }'))
lap('graphviz')

const tk = await import("node-tikzjax"); const tikz = tk.default.default || tk.default
const svg = await tikz('\\begin{document}\\begin{tikzpicture}\\node[draw,rounded corners] (a) {Round 1}; \\node[draw,below=1cm of a] (b) {$K_1$}; \\draw[->] (a) -- (b);\\end{tikzpicture}\\end{document}', { tikzLibraries: 'positioning' })
fs.writeFileSync(path.join(out, 'tikz.svg'), svg)
lap('tikz')
console.log(svg.slice(0, 400))
process.exit(0)
