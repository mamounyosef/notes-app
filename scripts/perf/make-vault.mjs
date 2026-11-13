// Writes a synthetic notes folder for performance tests: a few heavy pages (many cells with
// lists, tables, LaTeX and diagrams) plus a few hundred lighter pages for search.
// Usage: node scripts/perf/make-vault.mjs <vaultDir> [lightPages=300]
// Deterministic (seeded), so before and after runs see the same notes.
import fs from 'node:fs'
import path from 'node:path'

const vault = process.argv[2]
const LIGHT = Number(process.argv[3] || 300)
if (!vault) throw new Error('usage: make-vault.mjs <vaultDir> [lightPages]')

let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (a) => a[Math.floor(rnd() * a.length)]
const WORDS = ('gradient descent optimizer learning rate momentum batch normalization convolution kernel stride padding ' +
  'activation sigmoid tanh relu softmax entropy loss function backpropagation chain rule derivative matrix vector ' +
  'eigenvalue eigenvector probability distribution bayes theorem likelihood posterior prior variance covariance ' +
  'regression classification clustering kmeans transformer attention embedding token sequence recurrent network ' +
  'operating system process thread scheduler memory paging cache latency throughput database index query join').split(' ')
const sentence = (n) => {
  const w = []
  for (let i = 0; i < n; i++) w.push(pick(WORDS))
  w[0] = w[0][0].toUpperCase() + w[0].slice(1)
  return w.join(' ') + '.'
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const now = Date.now()
let idn = 0
const id = (p) => `${p}${(++idn).toString(36).padStart(6, '0')}`

function cell(x, y, w, h, title, html, z) {
  return { id: id('c'), kind: 'text', x, y, w, h, z, title, showTitle: true, html, autoHeight: true, createdAt: now, updatedAt: now }
}

const LATEX = ['\\theta \\leftarrow \\theta - \\eta \\nabla L(\\theta)', '\\sum_{i=1}^{n} x_i^2', '\\frac{\\partial L}{\\partial w} = \\delta \\cdot a',
  'P(A\\mid B) = \\frac{P(B\\mid A)P(A)}{P(B)}', '\\int_0^1 x^2\\,dx = \\tfrac13', '\\sigma(z) = \\frac{1}{1+e^{-z}}']

function heavyCellHtml(k) {
  switch (k % 6) {
    case 0:
      return `<p>${sentence(18)} <span data-latex="${pick(LATEX)}"></span> ${sentence(10)}</p><p>${sentence(25)}</p>`
    case 1:
      return `<ul>${Array.from({ length: 6 }, () => `<li><p>${sentence(8)}</p></li>`).join('')}</ul>`
    case 2:
      return `<ol>${Array.from({ length: 5 }, () => `<li><p>${sentence(7)} <span data-latex="${pick(LATEX)}"></span></p></li>`).join('')}</ol>`
    case 3: {
      const row = (tag) => `<tr>${Array.from({ length: 4 }, () => `<${tag}><p>${pick(WORDS)} ${pick(WORDS)}</p></${tag}>`).join('')}</tr>`
      return `<table><tbody>${row('th')}${Array.from({ length: 5 }, () => row('td')).join('')}</tbody></table>`
    }
    case 4:
      return `<div data-latex="${pick(LATEX)}"></div><p>${sentence(30)}</p><p>${sentence(20)}</p>`
    default:
      return `<p>${sentence(40)}</p><ul data-type="taskList">${Array.from({ length: 3 }, () => `<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>${sentence(5)}</p></div></li>`).join('')}</ul>`
  }
}

const MERMAID = 'graph TD\n  A[Input] --> B{Layer}\n  B --> C[ReLU]\n  B --> D[Softmax]\n  C --> E[Output]\n  D --> E'

function heavyPage(n) {
  const cells = []
  let z = 1
  for (let i = 0; i < 30; i++) {
    const col = i % 2
    const row = Math.floor(i / 2)
    let html = heavyCellHtml(i + n)
    // Two diagrams per heavy page.
    if (i === 5 || i === 18) html = `<div data-html-embed="" data-kind="mermaid" data-html-src="${b64(MERMAID)}"></div>`
    cells.push(cell(40 + col * 620, 120 + row * 320, 580, 280, i % 3 ? `Topic ${i + 1}` : '', html, z++))
  }
  return { id: `heavy${n}`, title: `Heavy page ${n}`, cells, strokes: [], gridSize: 20, createdAt: now, updatedAt: now }
}

function lightPage(n) {
  const cells = []
  const count = 3 + Math.floor(rnd() * 6)
  for (let i = 0; i < count; i++) {
    const html = i % 3 === 1 ? `<ul>${Array.from({ length: 3 }, () => `<li><p>${sentence(6)}</p></li>`).join('')}</ul>` : `<p>${sentence(20 + Math.floor(rnd() * 30))}</p>`
    cells.push(cell(40, 120 + i * 200, 600, 180, i === 0 ? `Notes ${n}` : '', html, i + 1))
  }
  return { id: `light${n}`, title: `${pick(WORDS)} ${pick(WORDS)} ${n}`, cells, strokes: [], gridSize: 20, createdAt: now, updatedAt: now - Math.floor(rnd() * 30) * 864e5 }
}

fs.mkdirSync(path.join(vault, 'pages'), { recursive: true })
const node = (nid, kind, title, children = []) => ({ id: nid, kind, title, children, createdAt: now, updatedAt: now })
const heavy = []
for (let i = 1; i <= 6; i++) heavy.push(heavyPage(i))
const light = []
for (let i = 1; i <= LIGHT; i++) light.push(lightPage(i))
for (const p of [...heavy, ...light]) fs.writeFileSync(path.join(vault, 'pages', `${p.id}.json`), JSON.stringify(p))

// One section holds the heavy pages; the light ones are spread over ten sections.
const sections = [node('secHeavy', 'section', 'Heavy', heavy.map((p) => node(p.id, 'page', p.title)))]
for (let s = 0; s < 10; s++) {
  const mine = light.filter((_, i) => i % 10 === s)
  sections.push(node(`sec${s}`, 'section', `Section ${s}`, mine.map((p) => node(p.id, 'page', p.title))))
}
const ws = { version: 1, tree: [node('nb1', 'notebook', 'University', sections)], favorites: [], recent: [] }
fs.writeFileSync(path.join(vault, 'workspace.json'), JSON.stringify(ws))
console.log(`vault ${vault}: ${heavy.length} heavy pages, ${light.length} light pages`)
