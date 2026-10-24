// Shows what TeX prints for a broken TikZ picture (to shape the error message).
// Usage: node scripts/diagram-bench/tex-error-smoke.mjs
const tk = await import('node-tikzjax')
const tex2svg = tk.default.default || tk.default
const body = '\\begin{document}\n\\begin{tikzpicture}\n\\node[draw, fancy=3] (a) {A};\n\\node[draw, below=of a] (b) {B}\n\\draw (a) -- (b);\n\\end{tikzpicture}\n\\end{document}'
const out = []
const log = console.log
console.log = (...a) => out.push(a.map(String).join(' '))
let ok = true
try { await tex2svg(body, { tikzLibraries: 'positioning', showConsole: true }) } catch (e) { ok = false; out.push('THROWN ' + e.message) }
console.log = log
console.log('produced svg:', ok)
console.log(out.slice(1).join('\n').split('\n').filter((l) => /^!|^l\.\d|THROWN/.test(l) || l.startsWith('<')).slice(0, 30).join('\n'))
process.exit(0)
