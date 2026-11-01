/**
 * The change ledger: what an edit really did to a cell, read the way the editor reads it.
 *
 * Both versions of the cell go through the note editor's own schema, so the
 * comparison sees what the user will see (a style that the editor drops counts
 * as dropped). Characters are lined up with a diff; for the ones that stayed,
 * every style and the block they sit in are compared. Tools use it three ways:
 * to style text by construction (styleText), to put back styles an edit had no
 * business touching (guard), and to tell the model and the chat exactly what
 * changed (effectLines, chatChanges).
 */
import { createDocument, getHTMLFromFragment, getSchema } from '@tiptap/core'
import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { buildExtensions } from '../editor/extensions'

let schema: Schema | null = null
/** The note editor's schema, built once. */
export const noteSchema = () => (schema ||= getSchema(buildExtensions('')))
export const parseCell = (html: string) => createDocument(html || '', noteSchema())
export const cellHtml = (doc: PMNode) => getHTMLFromFragment(doc.content, noteSchema())

/* ---------------- flattening ---------------- */

interface Unit {
  /** What the diff compares: the character, or a token for a formula, image or break. */
  key: string
  ch: string
  pos: number
  marks: readonly Mark[]
  style: Record<string, string>
  /** Where it sits: "bulletList > listItem > paragraph". */
  block: string
  /** The textblock holding it, for putting its type back. */
  blockPos: number
  blockNode: PMNode | null
}

/** The browser hands colors back as rgb(); the model and the chat speak hex. */
const hex = (v: string) =>
  v.replace(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i, (_m, r, g, b) => '#' + [r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join(''))

/** One flat value per style, so two runs can be compared attribute by attribute. */
function styleOf(marks: readonly Mark[]): Record<string, string> {
  const s: Record<string, string> = {}
  for (const m of marks) {
    const name = m.type.name
    if (name === 'textStyle') {
      for (const [k, v] of Object.entries(m.attrs)) if (v !== null && v !== undefined && v !== '') s[k] = hex(String(v))
    } else if (name === 'highlight') s.highlight = hex(String(m.attrs.color || 'on'))
    else if (name === 'link') s.link = String(m.attrs.href || 'on')
    else s[name] = 'on'
  }
  return s
}

const BLOCK_ATTRS = ['level', 'language', 'checked', 'textAlign']
function label(n: PMNode) {
  const a = BLOCK_ATTRS.filter((k) => n.attrs[k] !== undefined && n.attrs[k] !== null && !(k === 'textAlign' && n.attrs[k] === 'left'))
  return a.length ? `${n.type.name}(${a.map((k) => `${k}=${n.attrs[k]}`).join(',')})` : n.type.name
}

function atomKey(n: PMNode) {
  const extra = n.attrs.latex ?? n.attrs.src ?? ''
  return `￼${n.type.name}:${String(extra).slice(0, 200)}`
}

function flatten(doc: PMNode): Unit[] {
  const out: Unit[] = []
  const visit = (node: PMNode, pos: number, path: string[]) => {
    if (node.isTextblock) {
      const block = [...path, label(node)].join(' > ')
      node.forEach((child, off) => {
        const p = pos + 1 + off
        const style = styleOf(child.marks)
        if (child.isText) {
          const t = child.text || ''
          for (let i = 0; i < t.length; i++) out.push({ key: t[i], ch: t[i], pos: p + i, marks: child.marks, style, block, blockPos: pos, blockNode: node })
        } else out.push({ key: atomKey(child), ch: '￼', pos: p, marks: child.marks, style, block, blockPos: pos, blockNode: node })
      })
      out.push({ key: '\n', ch: '\n', pos: pos + node.nodeSize - 1, marks: [], style: {}, block, blockPos: pos, blockNode: node })
      return
    }
    if (node.isLeaf || node.isAtom) {
      out.push({ key: atomKey(node), ch: '￼', pos, marks: [], style: {}, block: [...path, label(node)].join(' > '), blockPos: pos, blockNode: null })
      out.push({ key: '\n', ch: '\n', pos, marks: [], style: {}, block: '', blockPos: pos, blockNode: null })
      return
    }
    node.forEach((c, off) => visit(c, pos + 1 + off, [...path, label(node)]))
  }
  doc.forEach((c, off) => visit(c, off, []))
  return out
}

/* ---------------- alignment ---------------- */

/** Myers diff on the middle part; null when it would take too long (a full rewrite). */
function myers(a: string[], b: string[]): [number, number][] | null {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  const max = n + m
  const off = max
  const size = 2 * max + 1
  const v = new Int32Array(size)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    if ((d + 1) * size > 6e6) return null
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        const pairs: [number, number][] = []
        let cx = n
        let cy = m
        for (let dd = d; dd >= 0; dd--) {
          const t = trace[dd]
          const kk = cx - cy
          const prevK = kk === -dd || (kk !== dd && t[off + kk - 1] < t[off + kk + 1]) ? kk + 1 : kk - 1
          const px = dd === 0 ? 0 : t[off + prevK]
          const py = dd === 0 ? 0 : px - prevK
          while (cx > px && cy > py) {
            cx--
            cy--
            pairs.push([cx, cy])
          }
          cx = px
          cy = py
        }
        return pairs.reverse()
      }
    }
  }
  return null
}

function align(a: string[], b: string[]): [number, number][] {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length
  let eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const pairs: [number, number][] = []
  for (let i = 0; i < s; i++) pairs.push([i, i])
  for (const [i, j] of myers(a.slice(s, ea), b.slice(s, eb)) || []) pairs.push([i + s, j + s])
  for (let k = 0; k < a.length - ea; k++) pairs.push([ea + k, eb + k])
  return pairs
}

/* ---------------- the ledger ---------------- */

export interface Change {
  kind: 'style' | 'text' | 'block'
  /** Style name: color, fontSize, fontFamily, highlight, bold, italic, link... */
  attr?: string
  from: string | null
  to: string | null
  /** The text it happened on (for text changes: from/to hold the text). */
  text: string
}

export interface Ledger {
  before: PMNode
  after: PMNode
  styles: Change[]
  texts: Change[]
  blocks: Change[]
  /** Unchanged characters whose style differs, per attribute, by index in `after`. */
  drift: { i: number; j: number; attrs: string[] }[]
  bu: Unit[]
  au: Unit[]
  pairs: [number, number][]
}

const readable = (s: string) => s.replace(/￼/g, '[formula]').replace(/\n/g, ' / ')

export function ledgerOf(beforeHtml: string, afterHtml: string): Ledger {
  const before = parseCell(beforeHtml)
  const after = parseCell(afterHtml)
  return ledgerOfDocs(before, after)
}

export function ledgerOfDocs(before: PMNode, after: PMNode): Ledger {
  const bu = flatten(before)
  const au = flatten(after)
  const pairs = align(bu.map((u) => u.key), au.map((u) => u.key))

  // Styles on characters that stayed, grouped into runs per (attribute, from, to).
  const styles: Change[] = []
  const open = new Map<string, { c: Change; last: number }>()
  const drift: Ledger['drift'] = []
  const blocks: Change[] = []
  const seenBlock = new Set<string>()
  for (const [i, j] of pairs) {
    const b = bu[i]
    const a = au[j]
    if (b.ch === '\n') continue
    const attrs = [...new Set([...Object.keys(b.style), ...Object.keys(a.style)])].filter((k) => b.style[k] !== a.style[k])
    if (attrs.length) drift.push({ i, j, attrs })
    for (const k of attrs) {
      const key = `${k}|${b.style[k] ?? ''}|${a.style[k] ?? ''}`
      const run = open.get(key)
      if (run && run.last === j - 1) {
        run.c.text += a.ch
        run.last = j
      } else {
        const c: Change = { kind: 'style', attr: k, from: b.style[k] ?? null, to: a.style[k] ?? null, text: a.ch }
        styles.push(c)
        open.set(key, { c, last: j })
      }
    }
    if (b.block !== a.block) {
      const key = `${a.blockPos}|${b.block}|${a.block}`
      if (!seenBlock.has(key)) {
        seenBlock.add(key)
        blocks.push({ kind: 'block', from: b.block, to: a.block, text: a.blockNode?.textContent || '' })
      }
    }
  }
  for (const c of styles) c.text = readable(c.text).trim()

  // Text: whatever lies between the characters that stayed, widened to whole words
  // ("teh" → "the", not "removed e, added e") and merged where they then touch.
  const texts: Change[] = []
  const matchOfB = new Int32Array(bu.length).fill(-1)
  for (const [i, j] of pairs) matchOfB[i] = j
  const word = (u: Unit) => u.ch !== '\n' && u.ch !== '￼' && !/\s/.test(u.ch)
  const spans: [number, number, number, number][] = []
  let pi = 0
  let pj = 0
  for (const [i, j] of [...pairs, [bu.length, au.length] as [number, number]]) {
    if (i > pi || j > pj) {
      let b0 = pi
      let a0 = pj
      let b1 = i
      let a1 = j
      while (b0 > 0 && a0 > 0 && matchOfB[b0 - 1] === a0 - 1 && word(bu[b0 - 1])) (b0--, a0--)
      while (b1 < bu.length && a1 < au.length && matchOfB[b1] === a1 && word(bu[b1])) (b1++, a1++)
      const last = spans[spans.length - 1]
      if (last && b0 <= last[1]) (last[1] = Math.max(last[1], b1), last[3] = Math.max(last[3], a1))
      else spans.push([b0, b1, a0, a1])
    }
    pi = i + 1
    pj = j + 1
  }
  for (const [b0, b1, a0, a1] of spans) {
    const from = bu.slice(b0, b1).map((u) => u.ch).join('')
    const to = au.slice(a0, a1).map((u) => u.ch).join('')
    // A formula swapped for another one is a change even though both read [formula].
    if (from.trim() || to.trim() || bu.slice(b0, b1).some((u) => u.ch === '￼') || au.slice(a0, a1).some((u) => u.ch === '￼'))
      texts.push({ kind: 'text', from: readable(from), to: readable(to), text: '' })
    else if (from !== to) texts.push({ kind: 'text', from: from.includes('\n') ? '(line break)' : readable(from), to: to.includes('\n') ? '(line break)' : readable(to), text: '' })
  }
  return { before, after, styles: styles.filter((c) => c.text), texts, blocks, drift, bu, au, pairs }
}

/* ---------------- repairs ---------------- */

const BOOL_MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'kbd', 'subscript', 'superscript'])

/** The after-marks of one character with `attrs` taken back from before. */
function fixMarks(after: readonly Mark[], before: readonly Mark[], attrs: string[], s: Schema): readonly Mark[] {
  let marks = after
  const ts = s.marks.textStyle
  const tsKeys = ts ? Object.keys(ts.create().attrs) : []
  const own = attrs.filter((k) => tsKeys.includes(k))
  if (own.length && ts) {
    const was = ts.isInSet(after)?.attrs || ts.create().attrs
    const old = ts.isInSet(before)?.attrs || {}
    const next: Record<string, unknown> = { ...was }
    for (const k of own) next[k] = old[k] ?? null
    marks = ts.removeFromSet(marks)
    if (Object.values(next).some((v) => v !== null && v !== undefined && v !== '')) marks = ts.create(next).addToSet(marks)
  }
  for (const k of attrs) {
    if (own.includes(k)) continue
    const type = s.marks[k]
    if (!type) continue
    marks = type.removeFromSet(marks)
    const m = type.isInSet(before)
    if (m) marks = m.addToSet(marks)
  }
  return marks
}

export interface Guarded {
  html: string
  ledger: Ledger
  /** What the edit would have changed and was put back. */
  restored: Change[]
}

/**
 * Puts back what an edit had no business changing, on text it did not touch.
 * `keepStyle` decides per style change (true = put it back); `keepBlocks`
 * puts back a heading, list or paragraph type that changed under unchanged text.
 */
export function guard(beforeHtml: string, afterHtml: string, keepStyle: (c: Change) => boolean, keepBlocks = false): Guarded {
  const ledger = ledgerOf(beforeHtml, afterHtml)
  const s = noteSchema()
  const restored: Change[] = []
  const fixAttrs = new Map<number, { i: number; attrs: string[] }>()
  for (const c of ledger.styles) if (keepStyle(c)) restored.push(c)
  if (restored.length) {
    const want = new Set(restored.map((c) => `${c.attr}|${c.from ?? ''}|${c.to ?? ''}`))
    for (const d of ledger.drift) {
      const b = ledger.bu[d.i].style
      const a = ledger.au[d.j].style
      const attrs = d.attrs.filter((k) => want.has(`${k}|${b[k] ?? ''}|${a[k] ?? ''}`))
      if (attrs.length) fixAttrs.set(d.j, { i: d.i, attrs })
    }
  }
  const blockFixes: { pos: number; node: PMNode }[] = []
  if (keepBlocks && ledger.blocks.length) {
    // A textblock whose every remaining character came from one block of another type gets that type back.
    const from = new Map<number, Set<number>>()
    for (const [i, j] of ledger.pairs) {
      const a = ledger.au[j]
      const b = ledger.bu[i]
      if (!a.blockNode || !b.blockNode || a.ch === '\n') continue
      if (!from.has(a.blockPos)) from.set(a.blockPos, new Set())
      from.get(a.blockPos)!.add(b.blockPos)
    }
    for (const c of ledger.blocks) {
      const unit = ledger.au.find((u) => u.block === c.to && u.blockNode && (u.blockNode.textContent || '') === c.text)
      const srcs = unit && from.get(unit.blockPos)
      if (!unit || !srcs || srcs.size !== 1) continue
      const src = ledger.bu.find((u) => u.blockPos === [...srcs][0] && u.blockNode)?.blockNode
      // Only the textblock itself (a lost heading level); a moved list item is left as is.
      const parentPath = (p: string) => p.split(' > ').slice(0, -1).join(' > ')
      if (!src || parentPath(c.from || '') !== parentPath(c.to || '')) continue
      if (!src.isTextblock || !unit.blockNode!.isTextblock) continue
      blockFixes.push({ pos: unit.blockPos, node: src })
      restored.push(c)
    }
  }
  if (!fixAttrs.size && !blockFixes.length) return { html: afterHtml, ledger, restored: [] }

  const tr = new Transform(ledger.after)
  // Contiguous characters needing the same marks are fixed in one step.
  let run: { from: number; to: number; marks: readonly Mark[] } | null = null
  const flush = () => {
    if (!run) return
    tr.removeMark(run.from, run.to, null)
    for (const m of run.marks) tr.addMark(run.from, run.to, m)
    run = null
  }
  for (const j of [...fixAttrs.keys()].sort((x, y) => x - y)) {
    const { i, attrs } = fixAttrs.get(j)!
    const a = ledger.au[j]
    const marks = fixMarks(a.marks, ledger.bu[i].marks, attrs, s)
    const cur = run as { from: number; to: number; marks: readonly Mark[] } | null
    if (cur && cur.to === a.pos && cur.marks.length === marks.length && cur.marks.every((m, k) => m.eq(marks[k]))) cur.to = a.pos + 1
    else {
      flush()
      run = { from: a.pos, to: a.pos + 1, marks }
    }
  }
  flush()
  for (const f of blockFixes) {
    try {
      tr.setNodeMarkup(f.pos, f.node.type, f.node.attrs)
    } catch {
      /* the new place does not allow that type: leave it */
    }
  }
  const html = cellHtml(tr.doc)
  return { html, ledger: ledgerOfDocs(ledger.before, tr.doc), restored }
}

/* ---------------- styling by construction ---------------- */

export interface StyleSpec {
  color?: string
  fontSize?: string
  highlight?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

/** The style names a spec may change, as the ledger names them. */
export function specAttrs(spec: StyleSpec): Set<string> {
  const out = new Set<string>()
  if (spec.color) out.add('color')
  if (spec.fontSize) out.add('fontSize')
  if (spec.highlight) out.add('highlight')
  for (const k of ['bold', 'italic', 'underline', 'strike'] as const) if (spec[k]) out.add(k)
  return out
}

/**
 * Styles text the way the editor's own toolbar does: new styles merge into the
 * ones already there (a heading's size stays when only its color changes), and
 * a phrase is found even when formatting splits it.
 */
export function styleText(html: string, find: string | null, spec: StyleSpec, opts: { all?: boolean; caseSensitive?: boolean } = {}): { html: string; count: number } {
  const s = noteSchema()
  const doc = parseCell(html)
  const ranges = findRanges(doc, find, opts)
  if (!ranges.length) return { html, count: 0 }
  const tr = new Transform(doc)
  const ts = s.marks.textStyle
  const boolMarks = (['bold', 'italic', 'underline', 'strike'] as const).filter((k) => spec[k] && s.marks[k])
  for (const [from, to] of ranges) {
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true
      const a = Math.max(from, pos)
      const b = Math.min(to, pos + node.nodeSize)
      if (a >= b) return false
      if ((spec.color || spec.fontSize) && ts) {
        const old = ts.isInSet(node.marks)?.attrs || {}
        tr.addMark(a, b, ts.create({ ...old, ...(spec.color ? { color: spec.color } : {}), ...(spec.fontSize ? { fontSize: spec.fontSize } : {}) }))
      }
      for (const k of boolMarks) tr.addMark(a, b, s.marks[k].create())
      if (spec.highlight && s.marks.highlight) tr.addMark(a, b, s.marks.highlight.create({ color: spec.highlight }))
      return false
    })
  }
  return { html: cellHtml(tr.doc), count: ranges.length }
}

function findRanges(doc: PMNode, find: string | null, opts: { all?: boolean; caseSensitive?: boolean }): [number, number][] {
  const tries = find === null ? [null] : [...new Set([find, find.replace(/\*\*|__|`/g, ''), find.replace(/[*_`]/g, '')])].filter((t) => t !== '')
  for (const t of tries) {
    const out: [number, number][] = []
    const re = t === null ? null : new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.all === false ? (opts.caseSensitive ? '' : 'i') : opts.caseSensitive ? 'g' : 'gi')
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      if (opts.all === false && out.length) return false
      if (node.type.spec.code) return false
      let text = ''
      const at: number[] = []
      node.forEach((c, off) => {
        if (c.isText) for (let i = 0; i < (c.text || '').length; i++) (text += c.text![i], at.push(pos + 1 + off + i))
        else (text += '￼', at.push(pos + 1 + off))
      })
      if (!re) {
        const m = /\S(?:[\s\S]*\S)?/.exec(text)
        if (m) out.push([at[m.index], at[m.index + m[0].length - 1] + 1])
        return false
      }
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        if (!m[0]) { re.lastIndex++; continue }
        out.push([at[m.index], at[m.index + m[0].length - 1] + 1])
        if (opts.all === false || !re.global) break
      }
      return false
    })
    if (out.length) return out
  }
  return []
}

/* ---------------- reporting ---------------- */

const ATTR_NAME: Record<string, string> = { fontSize: 'size', fontFamily: 'font', color: 'color', highlight: 'highlight', link: 'link' }
const cut = (t: string, n = 40) => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
/** "bulletList > listItem > paragraph" → "bulletList paragraph"; "heading(level=2)" → "heading 2". */
const blockName = (b: string | null) => {
  if (!b) return 'nothing'
  const parts = b.split(' > ').map((p) => p.replace(/\(level=(\d)\)/, ' $1').replace(/\(.*\)$/, ''))
  return parts.filter((p) => p !== 'listItem' && p !== 'taskItem').join(' ')
}

export function describe(c: Change): string {
  if (c.kind === 'text') {
    if (!c.from) return `added "${cut(c.to || '')}"`
    if (!c.to) return `removed "${cut(c.from)}"`
    return `"${cut(c.from)}" → "${cut(c.to)}"`
  }
  if (c.kind === 'block') return `"${cut(c.text)}": ${blockName(c.from)} → ${blockName(c.to)}`
  const name = c.attr || ''
  if (BOOL_MARKS.has(name)) return `${name} ${c.to ? 'added' : 'removed'} on "${cut(c.text)}"`
  return `${ATTR_NAME[name] || name} ${c.from ?? 'none'} → ${c.to ?? 'none'} on "${cut(c.text)}"`
}

/** What the model reads back: every real effect, then what was put back. */
export function effectLines(changes: Change[], restored: Change[] = [], max = 10): string {
  const list = (cs: Change[]) => cs.slice(0, max).map((c) => `- ${describe(c)}`).concat(cs.length > max ? [`- ...and ${cs.length - max} more`] : [])
  const out: string[] = []
  out.push(changes.length ? 'Effect, checked against the saved note:' : 'Effect, checked against the saved note: nothing changed.')
  out.push(...list(changes))
  if (restored.length) {
    out.push('Put back (the edit would also have changed these, which it was not asked to):')
    out.push(...list(restored))
  }
  if (changes.length) out.push('Nothing else in the cell changed.')
  return out.join('\n')
}

/** The real effects of a ledger, text first, for the report. */
export const effectsOf = (l: Ledger): Change[] => [...l.texts, ...l.styles, ...l.blocks]

/** Small enough to keep in the chat message. */
export const chatChanges = (cs: Change[], max = 6) => cs.slice(0, max).map((c) => ({ ...c, text: cut(c.text, 60), from: c.from && cut(c.from, 60), to: c.to && cut(c.to, 60) }))
