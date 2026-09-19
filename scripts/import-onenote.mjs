/**
 * Turns an exported OneNote tree into a Notes vault.
 *
 *   node scripts/import-onenote.mjs --export .onenote-export --out "C:\\Users\\me\\Documents\\MyNotes-OneNote"
 *
 * Nothing is ever written back to OneNote, and the output folder is written
 * fresh, so the import can be re-run as often as you like. Page ids are
 * derived from the OneNote page id, so a second run updates the same pages
 * rather than making copies.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { mathmlToLatex, tidyLatex } from './lib/mathml.mjs'

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const EXPORT_DIR = path.resolve(arg('export', '.onenote-export'))
const OUT_DIR = path.resolve(arg('out', path.join(process.env.USERPROFILE || '.', 'Documents', 'MyNotes-OneNote')))
const DRY_RUN = has('dry-run')
/** OneNote measures in points; the app in CSS pixels. */
const PT = 96 / 72
/** Grip strip plus inner padding that a cell adds around its content. */
const CHROME_Y = 40
const CHROME_X = 26

const report = {
  startedAt: new Date().toISOString(),
  exportDir: EXPORT_DIR,
  outDir: OUT_DIR,
  notebooks: 0,
  sections: 0,
  pages: 0,
  cells: 0,
  images: 0,
  tables: 0,
  equations: 0,
  tags: 0,
  inkSkipped: 0,
  pagesWithInk: [],
  warnings: [],
}

/* ------------------------------------------------------------------ */
/* XML into plain nodes                                                */
/* ------------------------------------------------------------------ */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  cdataPropName: '__cdata',
  processEntities: true,
  htmlEntities: true,
})

/** { tag, attrs, children, text } with namespace prefixes removed. */
function normalize(list) {
  const out = []
  for (const item of list || []) {
    const keys = Object.keys(item).filter((k) => k !== ':@')
    for (const key of keys) {
      const value = item[key]
      if (key === '#text') {
        const text = String(value ?? '')
        if (text.trim() || text === ' ') out.push({ tag: '#text', attrs: {}, children: [], text })
        continue
      }
      if (key === '__cdata') {
        const text = Array.isArray(value) ? value.map((v) => v['#text'] ?? '').join('') : String(value ?? '')
        out.push({ tag: '#cdata', attrs: {}, children: [], text })
        continue
      }
      const tag = key.includes(':') ? key.split(':').pop() : key
      const children = Array.isArray(value) ? normalize(value) : []
      const node = { tag, attrs: item[':@'] || {}, children, text: '' }
      // Collapse a lone text child into the node itself.
      const textKids = children.filter((c) => c.tag === '#text' || c.tag === '#cdata')
      if (textKids.length && children.length === textKids.length) {
        node.text = textKids.map((c) => c.text).join('')
        node.children = []
      }
      out.push(node)
    }
  }
  return out
}

function parseXml(xmlText) {
  return normalize(parser.parse(xmlText))
}

const kidsOf = (node, tag) => (node?.children || []).filter((c) => c.tag === tag)
/**
 * An Outline, an OE or a table Cell can hold several OEChildren blocks in a
 * row, so every one of them has to be read, not just the first.
 */
const childOEs = (node) => kidsOf(node, 'OEChildren').flatMap((g) => kidsOf(g, 'OE'))
const firstOf = (node, tag) => (node?.children || []).find((c) => c.tag === tag)
const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const shortId = (seed) => crypto.createHash('sha1').update(String(seed)).digest('base64url').slice(0, 12)

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/* ------------------------------------------------------------------ */
/* inline text: OneNote puts a small HTML fragment inside <one:T>       */
/* ------------------------------------------------------------------ */

function parseInline(raw, ctx) {
  if (!raw) return ''
  const text = tidyFragment(raw)
  let nodes
  try {
    nodes = parseXml(`<root>${text}</root>`)
  } catch (err) {
    // Not well formed: keep the words, lose the styling, and say so.
    ctx.warnings.push(`Could not parse styled text on "${ctx.pageName}": ${err.message}`)
    return escapeHtml(String(raw).replace(/<[^>]*>/g, ''))
  }
  const root = nodes.find((n) => n.tag === 'root')
  return inlineChildren(root ? root.children.length ? root.children : [{ tag: '#text', text: root.text, attrs: {}, children: [] }] : [], ctx)
}

/**
 * OneNote's inline fragments are HTML, not XML:
 *  - equations are hidden inside `<!--[if mathML]> ... <![endif]-->`
 *  - attributes can be unquoted, as in `<span lang=en-US>`
 *  - `<br>` and friends are not self closing
 * This makes such a fragment parsable without losing anything.
 */
function tidyFragment(raw) {
  let text = String(raw)
    // Reveal the equations, then drop any other comment.
    .replace(/<!--\[if\s+mathML\]>/gi, '')
    .replace(/<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '<br/>')
    .replace(/<(img|hr|input)\b([^>]*?)\/?>/gi, '<$1$2/>')
    .replace(/&nbsp;/g, ' ')

  // Quote bare attribute values so the XML parser accepts the fragment.
  text = text.replace(/<([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g, (whole, tag, attrs) => {
    const fixed = attrs.replace(/([\w:-]+)\s*=\s*(?!["'])([^\s"'<>/]+)/g, '$1="$2"')
    return `<${tag}${fixed}>`
  })
  return text
}

function inlineChildren(children, ctx) {
  return (children || []).map((c) => inlineNode(c, ctx)).join('')
}

function inlineNode(node, ctx) {
  switch (node.tag) {
    case '#text':
    case '#cdata':
      return escapeHtml(node.text)
    case 'br':
      return '<br>'
    case 'math': {
      const latex = tidyLatex(mathmlToLatex(node))
      if (!latex) return ''
      ctx.equations++
      const display = node.attrs.display === 'block'
      return display
        ? `<div data-latex="${escapeAttr(latex)}"></div>`
        : `<span data-latex="${escapeAttr(latex)}"></span>`
    }
    case 'a': {
      const href = node.attrs.href || ''
      const inner = node.children.length ? inlineChildren(node.children, ctx) : escapeHtml(node.text)
      return `<a href="${escapeAttr(href)}">${inner || escapeHtml(href)}</a>`
    }
    case 'span': {
      const inner = node.children.length ? inlineChildren(node.children, ctx) : escapeHtml(node.text)
      return wrapWithStyle(inner, node.attrs.style || '')
    }
    default: {
      const inner = node.children.length ? inlineChildren(node.children, ctx) : escapeHtml(node.text)
      return inner
    }
  }
}

/** Turns a OneNote inline style into the marks this app stores. */
function wrapWithStyle(inner, styleText) {
  if (!inner) return ''
  const style = parseStyle(styleText)
  let html = inner
  const leftovers = []

  if (isBold(style['font-weight'])) html = `<strong>${html}</strong>`
  if (style['font-style'] === 'italic') html = `<em>${html}</em>`
  const deco = style['text-decoration'] || ''
  if (/underline/.test(deco)) html = `<u>${html}</u>`
  if (/line-through/.test(deco)) html = `<s>${html}</s>`
  if (style.color && style.color !== 'automatic') leftovers.push(`color:${style.color}`)
  if (style['font-size']) {
    const px = ptToPx(style['font-size'])
    if (px) leftovers.push(`font-size:${px}px`)
  }
  if (style['font-family']) leftovers.push(`font-family:${style['font-family']}`)
  if (style['background-color'] && style['background-color'] !== 'none') {
    html = `<mark data-color="${escapeAttr(style['background-color'])}" style="background-color:${escapeAttr(style['background-color'])}">${html}</mark>`
  }

  if (leftovers.length) html = `<span style="${escapeAttr(leftovers.join(';'))}">${html}</span>`
  return html
}

function parseStyle(text) {
  const out = {}
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim()
  }
  return out
}

const isBold = (w) => w && (w === 'bold' || num(w, 0) >= 600)

function ptToPx(value) {
  const m = /([\d.]+)\s*(pt|px)?/.exec(String(value))
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return Math.round((m[2] === 'px' ? n : n * PT) * 10) / 10
}

/* ------------------------------------------------------------------ */
/* block content                                                       */
/* ------------------------------------------------------------------ */

/**
 * Converts a list of OE nodes into HTML, grouping consecutive list items and
 * following OneNote's nesting through OEChildren.
 */
function convertOEs(oes, ctx) {
  const parts = []
  let i = 0
  while (i < oes.length) {
    const oe = oes[i]
    const list = firstOf(oe, 'List')
    const bullet = list && firstOf(list, 'Bullet')
    const number = list && firstOf(list, 'Number')
    const tag = firstOf(oe, 'Tag')
    const isTodo = tag && ctx.tagDefs[tag.attrs.index]?.type === '99'

    if (isTodo) {
      const group = []
      while (i < oes.length) {
        const t = firstOf(oes[i], 'Tag')
        if (!t || ctx.tagDefs[t.attrs.index]?.type !== '99') break
        ctx.tags++
        const checked = t.attrs.completed === 'true'
        group.push(
          `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checked ? ' checked' : ''}><span></span></label><div>${oeInner(oes[i], ctx)}</div></li>`,
        )
        i++
      }
      parts.push(`<ul data-type="taskList">${group.join('')}</ul>`)
      continue
    }

    if (bullet || number) {
      const ordered = Boolean(number)
      const items = []
      while (i < oes.length) {
        const l = firstOf(oes[i], 'List')
        if (!l) break
        const isOrdered = Boolean(firstOf(l, 'Number'))
        if (isOrdered !== ordered) break
        items.push(`<li><p>${oeInner(oes[i], ctx)}</p>${oeNested(oes[i], ctx)}</li>`)
        i++
      }
      const start = ordered ? num(firstOf(firstOf(oes[i - 1], 'List'), 'Number')?.attrs?.restartNumberingAt, 0) : 0
      parts.push(ordered ? `<ol${start > 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }

    parts.push(convertBlockOE(oe, ctx))
    i++
  }
  return parts.filter(Boolean).join('')
}

/** Everything inside one OE that is not itself a nested block. */
function oeInner(oe, ctx) {
  const pieces = []
  for (const child of oe.children) {
    if (child.tag === 'T') pieces.push(parseInline(child.text, ctx))
    else if (child.tag === 'Image') pieces.push(convertImage(child, ctx))
  }
  return pieces.join('')
}

function oeNested(oe, ctx) {
  const nested = childOEs(oe)
  return nested.length ? convertOEs(nested, ctx) : ''
}

function convertBlockOE(oe, ctx) {
  const table = firstOf(oe, 'Table')
  if (table) return convertTable(table, ctx) + oeNested(oe, ctx)

  const ink = firstOf(oe, 'InkDrawing') || firstOf(oe, 'InkWord')
  if (ink) {
    ctx.inkSkipped++
    return `<p><em>[handwriting from OneNote, not imported]</em></p>` + oeNested(oe, ctx)
  }

  const inner = oeInner(oe, ctx)
  const nested = oeNested(oe, ctx)
  if (!inner.trim() && !nested) return '<p></p>'

  const style = parseStyle(oe.attrs.style || '')
  const align = oe.attrs.alignment && oe.attrs.alignment !== 'left' ? oe.attrs.alignment : style['text-align']
  const attrs = []
  if (align && align !== 'left') attrs.push(`style="text-align:${escapeAttr(align)}"`)

  const outer = [];
  // Paragraph level size and family, when OneNote set them on the block.
  const inlineStyle = []
  if (style['font-size']) {
    const px = ptToPx(style['font-size'])
    if (px) inlineStyle.push(`font-size:${px}px`)
  }
  if (style['font-family']) inlineStyle.push(`font-family:${style['font-family']}`)
  if (style.color && style.color !== 'automatic') inlineStyle.push(`color:${style.color}`)
  const body = inlineStyle.length ? `<span style="${escapeAttr(inlineStyle.join(';'))}">${inner}</span>` : inner

  outer.push(`<p${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</p>`)
  if (nested) outer.push(nested)
  return outer.join('')
}

function convertTable(table, ctx) {
  ctx.tables++
  const rows = kidsOf(table, 'Row')
  const hasHeader = table.attrs.hasHeaderRow === 'true'
  const cols = kidsOf(firstOf(table, 'Columns') || { children: [] }, 'Column')
  const colGroup = cols.length
    ? `<colgroup>${cols.map((c) => `<col style="width:${Math.round(num(c.attrs.width, 100) * PT)}px">`).join('')}</colgroup>`
    : ''

  const body = rows
    .map((row, rIndex) => {
      const cells = kidsOf(row, 'Cell')
        .map((cell) => {
          const html = convertOEs(childOEs(cell), ctx) || '<p></p>'
          const tag = hasHeader && rIndex === 0 ? 'th' : 'td'
          return `<${tag} colspan="1" rowspan="1">${html || '<p></p>'}</${tag}>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')

  return `<table>${colGroup}<tbody>${body}</tbody></table>`
}

function convertImage(image, ctx) {
  const data = firstOf(image, 'Data')
  if (!data || !data.text) {
    ctx.warnings.push(`Image without data on page "${ctx.pageName}" (it may live only in the OneNote cache).`)
    return ''
  }
  const file = ctx.saveAsset(data.text.replace(/\s+/g, ''))
  if (!file) return ''
  ctx.images++
  const size = firstOf(image, 'Size')
  const w = size ? Math.round(num(size.attrs.width) * PT) : 0
  const alt = (firstOf(firstOf(image, 'OCRData') || { children: [] }, 'OCRText')?.text || '').slice(0, 120)
  return `<img src="asset://local/${file}"${w ? ` width="${w}"` : ''}${alt ? ` alt="${escapeAttr(alt.replace(/\s+/g, ' ').trim())}"` : ''}>`
}

/* ------------------------------------------------------------------ */
/* page conversion                                                     */
/* ------------------------------------------------------------------ */

function convertPage(pageNode, pageId, ctx) {
  const cells = []
  let z = 1

  const tagDefs = {}
  for (const def of kidsOf(pageNode, 'TagDef')) tagDefs[def.attrs.index] = def.attrs
  ctx.tagDefs = tagDefs
  ctx.pageName = pageNode.attrs.name || 'Untitled page'

  const placeAfter = { y: 120 }

  for (const node of pageNode.children) {
    if (node.tag === 'Outline') {
      const pos = firstOf(node, 'Position')
      const size = firstOf(node, 'Size')
      const html = convertOEs(childOEs(node), ctx)
      if (!html.replace(/<p><\/p>/g, '').trim()) continue

      const x = Math.round(num(pos?.attrs.x, 36) * PT)
      const y = Math.round(num(pos?.attrs.y, placeAfter.y) * PT)
      const w = Math.round(num(size?.attrs.width, 468) * PT) + CHROME_X
      const h = Math.round(num(size?.attrs.height, 120) * PT) + CHROME_Y
      // Text grows if this app's fonts need a little more room than OneNote's,
      // so nothing imported can ever be clipped out of sight.
      cells.push(makeCell({ id: `${pageId}c${z}`, x, y, w, h, z: z++, html, autoHeight: true }))
      placeAfter.y = num(pos?.attrs.y, placeAfter.y) + num(size?.attrs.height, 120) + 20
    } else if (node.tag === 'Image') {
      const pos = firstOf(node, 'Position')
      const size = firstOf(node, 'Size')
      const html = convertImage(node, ctx)
      if (!html) continue
      const x = Math.round(num(pos?.attrs.x, 36) * PT)
      const y = Math.round(num(pos?.attrs.y, placeAfter.y) * PT)
      const w = Math.round(num(size?.attrs.width, 400) * PT) + CHROME_X
      const h = Math.round(num(size?.attrs.height, 300) * PT) + CHROME_Y
      cells.push(makeCell({ id: `${pageId}c${z}`, x, y, w, h, z: z++, html: `<p>${html}</p>`, autoHeight: false }))
    } else if (node.tag === 'InkDrawing' || node.tag === 'InkWord') {
      ctx.inkSkipped++
      if (!ctx.inkPages.includes(ctx.pageName)) ctx.inkPages.push(ctx.pageName)
    }
  }

  const now = Date.now()
  const modified = Date.parse(pageNode.attrs.lastModifiedTime || '') || now
  const created = Date.parse(pageNode.attrs.dateTime || '') || modified

  return {
    id: pageId,
    title: pageNode.attrs.name || 'Untitled page',
    cells,
    strokes: [],
    // The app tidies any overlap once, after it knows the real text heights.
    needsReflow: true,
    createdAt: created,
    updatedAt: modified,
  }
}

/**
 * OneNote outlines have no title of their own. When the first line is a short
 * bold line it reads as a heading, so it becomes the cell title, which is how
 * the same note looked in OneNote.
 */
function makeCell({ id, x, y, w, h, z, html, autoHeight = false }) {
  let title = ''
  let body = html
  const m = /^<p(?:\s[^>]*)?>\s*(?:<span[^>]*>)?\s*<strong>([\s\S]*?)<\/strong>\s*(?:<\/span>)?\s*<\/p>/.exec(html)
  if (m) {
    const plain = m[1].replace(/<[^>]+>/g, '').trim()
    if (plain && plain.length <= 90) {
      title = plain
      body = html.slice(m[0].length)
    }
  }
  body = body.replace(/^(?:<p><\/p>)+/, '')

  return {
    id,
    kind: 'text',
    x,
    y,
    w,
    h,
    z,
    title,
    showTitle: Boolean(title),
    html: body || '<p></p>',
    autoHeight,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    collapsed: false,
    locked: false,
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(path.join(EXPORT_DIR, 'hierarchy.xml'))) {
    console.error(`No export found at ${EXPORT_DIR}.`)
    console.error('Run: powershell -ExecutionPolicy Bypass -File scripts\\export-onenote.ps1 -NotebookRoot "<your OneNote Notebooks folder>"')
    process.exit(1)
  }

  const assetsDir = path.join(OUT_DIR, 'assets')
  const pagesDir = path.join(OUT_DIR, 'pages')
  if (!DRY_RUN) {
    await fsp.mkdir(assetsDir, { recursive: true })
    await fsp.mkdir(pagesDir, { recursive: true })
  }

  const seenAssets = new Set()
  const ctx = {
    images: 0,
    tables: 0,
    equations: 0,
    tags: 0,
    inkSkipped: 0,
    inkPages: [],
    warnings: [],
    tagDefs: {},
    pageName: '',
    saveAsset(base64) {
      try {
        const buf = Buffer.from(base64, 'base64')
        if (!buf.length) return null
        const ext = sniffExtension(buf)
        const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`
        if (!seenAssets.has(name)) {
          seenAssets.add(name)
          if (!DRY_RUN) fs.writeFileSync(path.join(assetsDir, name), buf)
        }
        return name
      } catch (err) {
        ctx.warnings.push(`Could not save an image on "${ctx.pageName}": ${err.message}`)
        return null
      }
    },
  }

  const hierarchy = parseXml(await fsp.readFile(path.join(EXPORT_DIR, 'hierarchy.xml'), 'utf8'))
  const root = hierarchy.find((n) => n.tag === 'Notebooks') || hierarchy[0]

  const tree = []
  const pageJobs = []

  const walkSections = (node, into) => {
    for (const child of node.children) {
      if (child.tag === 'SectionGroup') {
        if ((child.attrs.name || '').includes('RecycleBin')) continue
        const group = makeNode('section', child.attrs.name || 'Group', child.attrs.ID)
        into.push(group)
        walkSections(child, group.children)
      } else if (child.tag === 'Section') {
        // OneNote keeps an empty helper section called "Open Notebook" in
        // every notebook folder. It holds nothing, so it is not carried over.
        const pageCount = kidsOf(child, 'Page').length
        if (!pageCount && /[\\/]Open Notebook\.one$/i.test(child.attrs.path || '')) continue
        const section = makeNode('section', child.attrs.name || 'Section', child.attrs.ID)
        if (colorFor(child.attrs.color)) section.color = child.attrs.color
        into.push(section)
        report.sections++
        // Pages, honouring OneNote's subpage levels.
        const stack = [{ level: 0, children: section.children }]
        for (const p of kidsOf(child, 'Page')) {
          const level = Math.max(1, num(p.attrs.pageLevel, 1))
          while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
          const id = shortId(p.attrs.ID)
          const pageNode = makeNode('page', p.attrs.name || 'Untitled page', p.attrs.ID)
          pageNode.id = id
          stack[stack.length - 1].children.push(pageNode)
          stack.push({ level, children: pageNode.children })
          pageJobs.push({ id, oneNoteId: p.attrs.ID })
          report.pages++
        }
      }
    }
  }

  for (const nb of kidsOf(root, 'Notebook')) {
    const notebook = makeNode('notebook', nb.attrs.name || 'Notebook', nb.attrs.ID)
    notebook.color = colorFor(nb.attrs.color) || pickColor(report.notebooks)
    tree.push(notebook)
    report.notebooks++
    walkSections(nb, notebook.children)
  }

  // Convert every page.
  for (const job of pageJobs) {
    const file = path.join(EXPORT_DIR, 'pages', `${String(job.oneNoteId).replace(/[^0-9A-Za-z]/g, '')}.xml`)
    if (!fs.existsSync(file)) {
      ctx.warnings.push(`No exported XML for page ${job.oneNoteId}`)
      continue
    }
    const parsed = parseXml(await fsp.readFile(file, 'utf8'))
    const pageNode = parsed.find((n) => n.tag === 'Page')
    if (!pageNode) continue
    const page = convertPage(pageNode, job.id, ctx)
    report.cells += page.cells.length
    if (!DRY_RUN) await fsp.writeFile(path.join(pagesDir, `${job.id}.json`), JSON.stringify(page, null, 2), 'utf8')
  }

  const firstPage = pageJobs[0]?.id
  const workspace = {
    version: 1,
    tree,
    favorites: [],
    recent: firstPage ? [firstPage] : [],
    lastOpenPageId: firstPage,
  }
  if (!DRY_RUN) {
    await fsp.writeFile(path.join(OUT_DIR, 'workspace.json'), JSON.stringify(workspace, null, 2), 'utf8')
  }

  Object.assign(report, {
    images: ctx.images,
    tables: ctx.tables,
    equations: ctx.equations,
    tags: ctx.tags,
    inkSkipped: ctx.inkSkipped,
    pagesWithInk: ctx.inkPages,
    warnings: ctx.warnings,
    finishedAt: new Date().toISOString(),
  })
  if (!DRY_RUN) await fsp.writeFile(path.join(OUT_DIR, 'import-report.json'), JSON.stringify(report, null, 2), 'utf8')

  console.log('')
  console.log(`  Notebooks : ${report.notebooks}`)
  console.log(`  Sections  : ${report.sections}`)
  console.log(`  Pages     : ${report.pages}`)
  console.log(`  Cells     : ${report.cells}`)
  console.log(`  Images    : ${report.images}`)
  console.log(`  Tables    : ${report.tables}`)
  console.log(`  Equations : ${report.equations}`)
  console.log(`  To do tags: ${report.tags}`)
  if (report.inkSkipped) console.log(`  Ink drawings not imported: ${report.inkSkipped} on ${report.pagesWithInk.length} page(s)`)
  if (report.warnings.length) console.log(`  Warnings  : ${report.warnings.length} (see import-report.json)`)
  console.log('')
  console.log(DRY_RUN ? '  Dry run, nothing written.' : `  Written to ${OUT_DIR}`)
}

function makeNode(kind, title, seed) {
  return {
    id: shortId(seed),
    kind,
    title,
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const PALETTE = ['#7c9cff', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#c678dd', '#f06292', '#8d9bb0']
const pickColor = (i) => PALETTE[i % PALETTE.length]

function colorFor(value) {
  return value && value !== 'none' && value !== 'automatic' ? value : ''
}

function sniffExtension(buf) {
  const hex = buf.subarray(0, 12).toString('hex')
  if (hex.startsWith('89504e47')) return 'png'
  if (hex.startsWith('ffd8ff')) return 'jpg'
  if (hex.startsWith('47494638')) return 'gif'
  if (hex.startsWith('424d')) return 'bmp'
  if (hex.includes('57454250')) return 'webp'
  if (hex.startsWith('3c3f786d') || hex.startsWith('3c737667')) return 'svg'
  return 'png'
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
