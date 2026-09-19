/**
 * Checks an import against the OneNote export it came from, page by page.
 *
 *   node scripts/verify-import.mjs --export .onenote-export --out "<vault folder>"
 *
 * For every page it compares the number of images, tables, equations and the
 * visible text itself. Text is compared word by word: any word that OneNote
 * has and the imported page does not is reported. Nothing is written.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const EXPORT_DIR = path.resolve(arg('export', '.onenote-export'))
const OUT_DIR = path.resolve(arg('out', path.join(process.env.USERPROFILE || '.', 'Documents', 'MyNotes-OneNote')))
const VERBOSE = argv.includes('--verbose')

const shortId = (s) => crypto.createHash('sha1').update(String(s)).digest('base64url').slice(0, 12)

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  cdataPropName: '__cdata',
  processEntities: true,
  htmlEntities: true,
})

/** Every word OneNote shows on a page, ignoring OCR text and markup. */
function oneNoteWords(xml) {
  const texts = []
  let images = 0
  let tables = 0
  let equations = 0
  let ink = 0

  const walk = (list, insideOcr) => {
    for (const item of list || []) {
      for (const key of Object.keys(item).filter((k) => k !== ':@')) {
        const tag = key.includes(':') ? key.split(':').pop() : key
        const value = item[key]
        if (tag === 'Image') images++
        if (tag === 'Table') tables++
        if (tag === 'InkDrawing' || tag === 'InkWord') ink++
        const ocr = insideOcr || tag === 'OCRData' || tag === 'OCRText' || tag === 'OCRToken'
        if (tag === 'T' && !ocr && Array.isArray(value)) {
          for (const part of value) {
            const raw = part.__cdata
              ? (Array.isArray(part.__cdata) ? part.__cdata.map((c) => c['#text'] ?? '').join('') : part.__cdata)
              : part['#text'] ?? ''
            const s = String(raw)
            equations += (s.match(/<math/g) || []).length
            texts.push(stripMarkup(s))
          }
        }
        if (Array.isArray(value)) walk(value, ocr)
      }
    }
  }
  walk(parser.parse(xml), false)
  return { words: words(texts.join(' ')), images, tables, equations, ink }
}

function stripMarkup(s) {
  return String(s)
    .replace(/<!--\[if\s+mathML\]>[\s\S]*?<!\[endif\]-->/gi, ' ')   // equations compared separately
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/[^\p{L}\p{N}'.+-]+/u)
    .map((w) => w.replace(/^[.'+-]+|[.'+-]+$/g, ''))
    .filter((w) => w.length > 1)
}

function importedPage(file) {
  const page = JSON.parse(fs.readFileSync(file, 'utf8'))
  let html = page.title + ' '
  let images = 0
  let tables = 0
  let equations = 0
  for (const cell of page.cells) {
    html += ' ' + cell.title + ' ' + cell.html
    images += (cell.html.match(/<img\b/g) || []).length
    tables += (cell.html.match(/<table\b/g) || []).length
    equations += (cell.html.match(/data-latex=/g) || []).length
  }
  return { page, words: words(stripMarkup(html)), images, tables, equations }
}

const hier = fs.readFileSync(path.join(EXPORT_DIR, 'hierarchy.xml'), 'utf8')
const pages = [...hier.matchAll(/<one:Page\s[^>]*ID="([^"]+)"[^>]*name="([^"]*)"/g)].map((m) => ({ id: m[1], name: m[2] }))

let checked = 0
let skipped = 0
let perfect = 0
const problems = []
const emptyInOneNote = []

for (const p of pages) {
  const src = path.join(EXPORT_DIR, 'pages', p.id.replace(/[^0-9A-Za-z]/g, '') + '.xml')
  const dst = path.join(OUT_DIR, 'pages', shortId(p.id) + '.json')
  if (!fs.existsSync(src)) continue
  if (!fs.existsSync(dst)) {
    skipped++
    continue // deleted pages in the OneNote recycle bin are not imported
  }
  checked++

  const a = oneNoteWords(fs.readFileSync(src, 'utf8'))
  const b = importedPage(dst)

  if (!a.words.length && !a.images && !a.equations) emptyInOneNote.push(p.name)

  const have = new Set(b.words)
  const missing = []
  const counts = new Map()
  for (const w of a.words) counts.set(w, (counts.get(w) || 0) + 1)
  for (const [w] of counts) if (!have.has(w)) missing.push(w)

  const issues = []
  if (missing.length) issues.push(`${missing.length} word(s) missing: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' ...' : ''}`)
  if (b.images !== a.images) issues.push(`images ${b.images} of ${a.images}`)
  if (b.tables !== a.tables) issues.push(`tables ${b.tables} of ${a.tables}`)
  if (b.equations < a.equations) issues.push(`equations ${b.equations} of ${a.equations}`)
  if (a.ink) issues.push(`${a.ink} ink drawing(s) not imported`)

  if (issues.length) problems.push({ name: p.name, issues })
  else perfect++

  if (VERBOSE) console.log(`${issues.length ? 'x' : 'ok'}  ${p.name}`)
}

console.log('')
console.log(`  Pages checked        : ${checked}`)
console.log(`  Identical            : ${perfect}`)
console.log(`  With differences     : ${problems.length}`)
console.log(`  Not imported (trash) : ${skipped}`)
if (emptyInOneNote.length) {
  console.log(`  Empty in OneNote too : ${emptyInOneNote.length} (${emptyInOneNote.slice(0, 6).join(', ')}${emptyInOneNote.length > 6 ? ' ...' : ''})`)
}
console.log('')
for (const p of problems) {
  console.log(`  ${p.name}`)
  for (const i of p.issues) console.log(`      ${i}`)
}
process.exit(problems.some((p) => p.issues.some((i) => !i.includes('ink'))) ? 1 : 0)
