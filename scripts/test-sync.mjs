/**
 * Scenario tests for the sync merge rules (shared/sync-core.mjs).
 * Run: node scripts/test-sync.mjs
 */
import assert from 'node:assert/strict'
import * as S from '../shared/sync-core.mjs'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.log(`FAIL ${name}`)
    console.log(e)
    process.exitCode = 1
  }
}

const cell = (id, extra = {}) => ({
  id, kind: 'text', x: 0, y: 0, w: 200, h: 100, z: 1, title: '', showTitle: true, html: `<p>${id}</p>`,
  createdAt: 1, updatedAt: 1, ...extra,
})
const page = (cells, extra = {}) => ({ id: 'p1', title: 'Page', cells, strokes: [], gridSize: 20, createdAt: 1, updatedAt: 1, ...extra })
const clone = (v) => JSON.parse(JSON.stringify(v))
const ids = (p) => p.cells.map((c) => c.id).sort()
const byId = (p, id) => p.cells.find((c) => c.id === id)
let clock = 1000
const tick = () => ++clock

/** Saves `cur` (edited from `base`) on a device and returns what lands on disk. */
function save(device, base, cur, disk, touched = null) {
  const { page: stamped, bumped } = S.stampPage(base, cur, device, touched, tick())
  if (!bumped && base && disk) return { disk, skipped: true }
  return { disk: disk ? S.mergePages(stamped, disk, 'a') : stamped, skipped: false }
}

// A shared starting point both laptops have.
const p0 = save('A', null, page([cell('c1'), cell('c2'), cell('c3')]), null).disk

test('one laptop edits, the other gets it with no conflict', () => {
  const a = clone(p0)
  byId(a, 'c1').html = '<p>A edit</p>'
  const disk = save('A', p0, a, p0).disk
  const merged = S.mergePages(p0, disk, 'b') // B reconciles
  assert.equal(byId(merged, 'c1').html, '<p>A edit</p>')
  assert.equal(merged.cells.filter((c) => c.conflict).length, 0)
})

test('different cells edited on both laptops merge cleanly, both orders agree', () => {
  const a = clone(p0)
  byId(a, 'c1').html = '<p>A</p>'
  const b = clone(p0)
  byId(b, 'c2').html = '<p>B</p>'
  const da = S.stampPage(p0, a, 'A', null, tick()).page
  const db = S.stampPage(p0, b, 'B', null, tick()).page
  const m1 = S.mergePages(da, db, 'a')
  const m2 = S.mergePages(db, da, 'a')
  assert.equal(byId(m1, 'c1').html, '<p>A</p>')
  assert.equal(byId(m1, 'c2').html, '<p>B</p>')
  assert.ok(S.samePageContent(m1, m2))
  assert.equal(m1.cells.filter((c) => c.conflict).length, 0)
})

test('same cell edited on both laptops keeps both, identical on both sides', () => {
  const a = clone(p0)
  byId(a, 'c1').html = '<p>A version</p>'
  byId(a, 'c1').updatedAt = 5000
  const b = clone(p0)
  byId(b, 'c1').html = '<p>B version</p>'
  byId(b, 'c1').updatedAt = 6000
  const da = S.stampPage(p0, a, 'A', null, 1).page
  const db = S.stampPage(p0, b, 'B', null, 1).page
  const m1 = S.mergePages(da, db, 'a')
  const m2 = S.mergePages(db, da, 'a')
  assert.equal(m1.cells.length, 4)
  assert.deepEqual(ids(m1), ids(m2))
  assert.ok(S.samePageContent(m1, m2))
  const copy = m1.cells.find((c) => c.conflict)
  assert.equal(copy.conflict.of, 'c1')
  const htmls = [byId(m1, 'c1').html, copy.html].sort()
  assert.deepEqual(htmls, ['<p>A version</p>', '<p>B version</p>'])
  // Merging again changes nothing (no copy of the copy).
  const m3 = S.mergePages(m1, m2, 'a')
  assert.ok(S.samePageContent(m1, m3))
  assert.equal(m3.cells.length, 4)
})

test('discarding the copy on one laptop removes it everywhere', () => {
  const a = clone(p0)
  byId(a, 'c1').html = '<p>A2</p>'
  const b = clone(p0)
  byId(b, 'c1').html = '<p>B2</p>'
  const m = S.mergePages(S.stampPage(p0, a, 'A', null, tick()).page, S.stampPage(p0, b, 'B', null, tick()).page, 'a')
  const copy = m.cells.find((c) => c.conflict)
  const resolved = { ...m, cells: m.cells.filter((c) => c.id !== copy.id) }
  const da = S.stampPage(m, resolved, 'A', null, tick()).page
  const mb = S.mergePages(m, da, 'b') // B still has the copy
  assert.equal(mb.cells.find((c) => c.id === copy.id), undefined)
  assert.equal(mb.cells.length, 3)
})

test('keep both: clearing the flag sticks on both laptops', () => {
  const a = clone(p0)
  byId(a, 'c2').html = '<p>A3</p>'
  const b = clone(p0)
  byId(b, 'c2').html = '<p>B3</p>'
  const m = S.mergePages(S.stampPage(p0, a, 'A', null, tick()).page, S.stampPage(p0, b, 'B', null, tick()).page, 'a')
  const copy = m.cells.find((c) => c.conflict)
  const kept = { ...m, cells: m.cells.map((c) => (c.id === copy.id ? { ...c, conflict: undefined } : c)) }
  const da = S.stampPage(m, kept, 'A', null, tick()).page
  const mb = S.mergePages(m, da, 'b')
  assert.equal(mb.cells.filter((c) => c.conflict).length, 0)
  assert.equal(mb.cells.length, 4)
})

test('deleted here, untouched there: stays deleted', () => {
  const a = { ...clone(p0), cells: clone(p0).cells.filter((c) => c.id !== 'c3') }
  const da = S.stampPage(p0, a, 'A', null, tick()).page
  const m = S.mergePages(p0, da, 'b')
  assert.deepEqual(ids(m), ['c1', 'c2'])
  const m2 = S.mergePages(da, p0, 'a') // an old copy arriving later cannot bring it back
  assert.deepEqual(ids(m2), ['c1', 'c2'])
})

test('deleted on one laptop, edited on the other: kept and flagged, stable', () => {
  const a = { ...clone(p0), cells: clone(p0).cells.filter((c) => c.id !== 'c3') }
  const b = clone(p0)
  byId(b, 'c3').html = '<p>edited</p>'
  const da = S.stampPage(p0, a, 'A', null, tick()).page
  const db = S.stampPage(p0, b, 'B', null, tick()).page
  const m1 = S.mergePages(da, db, 'a')
  const m2 = S.mergePages(db, da, 'a')
  assert.equal(byId(m1, 'c3').html, '<p>edited</p>')
  assert.equal(byId(m1, 'c3').conflict.reason, 'deleted-elsewhere')
  assert.ok(S.samePageContent(m1, m2))
  // Resolving "keep" clears the flag for good.
  const kept = { ...m1, cells: m1.cells.map((c) => (c.id === 'c3' ? { ...c, conflict: undefined } : c)) }
  const dk = S.stampPage(m1, kept, 'A', null, tick()).page
  const m3 = S.mergePages(dk, da, 'a')
  assert.equal(byId(m3, 'c3').conflict, undefined)
  // Resolving "delete" removes it for good.
  const del = { ...m1, cells: m1.cells.filter((c) => c.id !== 'c3') }
  const dd = S.stampPage(m1, del, 'A', null, tick()).page
  assert.equal(byId(S.mergePages(dd, db, 'a'), 'c3'), undefined)
})

test('an older copy of the file replacing ours is merged back from the journal', () => {
  const a = clone(p0)
  byId(a, 'c1').html = '<p>precious</p>'
  const journal = save('A', p0, a, p0).disk
  const disk = S.adoptLegacyPage(clone(p0), journal, tick())
  const merged = S.mergePages(journal, disk, 'b')
  assert.equal(byId(merged, 'c1').html, '<p>precious</p>')
})

test('layout the app measured by itself is not an edit', () => {
  const a = clone(p0)
  byId(a, 'c1').h = 140
  const r = S.stampPage(p0, a, 'A', null, tick())
  assert.equal(r.bumped, false)
  const r2 = S.stampPage(p0, a, 'A', { cells: ['c1'] }, tick())
  assert.equal(r2.bumped, true)
})

test('two laptops measuring different heights do not create conflicts', () => {
  const a = clone(p0)
  byId(a, 'c1').h = 140
  byId(a, 'c1').html = '<p>A text</p>'
  const da = S.stampPage(p0, a, 'A', null, tick()).page
  const b = clone(da)
  byId(b, 'c1').h = 160
  const rb = S.stampPage(da, b, 'B', null, tick())
  assert.equal(rb.bumped, false)
})

test('concurrent move and text edit: no copy, newest layout wins', () => {
  const a = clone(p0)
  Object.assign(byId(a, 'c1'), { x: 300, updatedAt: 9000 })
  const b = clone(p0)
  Object.assign(byId(b, 'c1'), { x: 500, updatedAt: 8000 })
  const da = S.stampPage(p0, a, 'A', { cells: ['c1'] }, 1).page
  const db = S.stampPage(p0, b, 'B', { cells: ['c1'] }, 1).page
  const m = S.mergePages(da, db, 'b')
  assert.equal(m.cells.length, 3)
  assert.equal(byId(m, 'c1').x, 300)
})

test('a file from the old app version keeps its edits as conflicts, not silently lost', () => {
  const a = clone(p0)
  byId(a, 'c1').html = '<p>new app</p>'
  const ours = S.stampPage(p0, a, 'A', null, tick()).page
  const legacy = clone(p0)
  delete legacy.syncV
  for (const c of legacy.cells) delete c.vv
  legacy.cells[0].html = '<p>old app</p>'
  const adopted = S.adoptLegacyPage(legacy, p0, tick())
  const m = S.mergePages(ours, adopted, 'a')
  const htmls = m.cells.map((c) => c.html)
  assert.ok(htmls.includes('<p>new app</p>'))
  assert.ok(htmls.includes('<p>old app</p>'))
})

test('an old app version editing a versioned file without bumping is not lost', () => {
  const ours = clone(p0)
  const old = clone(p0)
  byId(old, 'c2').html = '<p>typed in the old app</p>' // vv untouched
  const m1 = S.mergePages(ours, old, 'a')
  const m2 = S.mergePages(old, ours, 'a')
  assert.ok(m1.cells.some((c) => c.html === '<p>typed in the old app</p>'))
  assert.ok(S.samePageContent(m1, m2))
})

test('page ink drawn on both laptops is kept from both', () => {
  const a = { ...clone(p0), strokes: [{ color: 'r', size: 2, points: [1, 1, 2, 2] }] }
  const b = { ...clone(p0), strokes: [{ color: 'b', size: 2, points: [5, 5, 6, 6] }] }
  const m = S.mergePages(S.stampPage(p0, a, 'A', null, tick()).page, S.stampPage(p0, b, 'B', null, tick()).page, 'a')
  assert.equal(m.strokes.length, 2)
})

test('edits made during a save are kept and moved onto the result', () => {
  const sent = clone(p0)
  byId(sent, 'c1').html = '<p>sent</p>'
  const result = S.stampPage(p0, sent, 'A', null, tick()).page
  const cur = { ...sent, cells: sent.cells.map((c) => (c.id === 'c2' ? { ...c, html: '<p>typed later</p>' } : c)) }
  const rebased = S.rebasePage(cur, sent, result)
  assert.equal(byId(rebased, 'c1').html, '<p>sent</p>')
  assert.equal(byId(rebased, 'c2').html, '<p>typed later</p>')
})

test('edit during a save that collides with a remote change keeps both', () => {
  const sent = clone(p0)
  const remote = clone(p0)
  byId(remote, 'c2').html = '<p>remote</p>'
  const result = S.mergePages(S.stampPage(p0, sent, 'A', null, tick()).page, S.stampPage(p0, remote, 'B', null, tick()).page, 'a')
  const cur = { ...sent, cells: sent.cells.map((c) => (c.id === 'c2' ? { ...c, html: '<p>local</p>' } : c)) }
  const rebased = S.rebasePage(cur, sent, result)
  const htmls = rebased.cells.map((c) => c.html)
  assert.ok(htmls.includes('<p>local</p>'))
  assert.ok(htmls.includes('<p>remote</p>'))
})

/* ---------------- workspace ---------------- */

const node = (id, kind, title, children = []) => ({ id, kind, title, children, createdAt: 1, updatedAt: 1 })
const ws0raw = {
  version: 1,
  tree: [node('nb', 'notebook', 'NB', [node('s1', 'section', 'S1', [node('p1', 'page', 'P1'), node('p2', 'page', 'P2')])])],
  favorites: [],
}
const ws0 = S.stampWorkspace(null, ws0raw, 'A', 1).workspace
const titles = (ws) => [...S.flattenTree(ws.tree).values()].map((r) => `${r.id}:${r.title}:${r.parentId}`).sort()

test('rename here and new page there both survive', () => {
  const a = clone(ws0)
  a.tree[0].children[0].children[0].title = 'P1 renamed'
  const b = clone(ws0)
  b.tree[0].children[0].children.push(node('p3', 'page', 'P3'))
  const m1 = S.mergeWorkspaces(S.stampWorkspace(ws0, a, 'A', tick()).workspace, S.stampWorkspace(ws0, b, 'B', tick()).workspace, 'a')
  const m2 = S.mergeWorkspaces(S.stampWorkspace(ws0, b, 'B', tick()).workspace, S.stampWorkspace(ws0, a, 'A', tick()).workspace, 'a')
  const t = titles(m1)
  assert.ok(t.includes('p1:P1 renamed:s1'))
  assert.ok(t.includes('p3:P3:s1'))
  assert.deepEqual(titles(m1), titles(m2))
})

test('section deleted here while a page was added to it there: page is recovered', () => {
  const a = clone(ws0)
  a.tree[0].children = []
  const b = clone(ws0)
  b.tree[0].children[0].children.push(node('p9', 'page', 'New one'))
  const m = S.mergeWorkspaces(S.stampWorkspace(ws0, a, 'A', tick()).workspace, S.stampWorkspace(ws0, b, 'B', tick()).workspace, 'a')
  const recs = S.flattenTree(m.tree)
  assert.ok(recs.has('p9'))
  assert.equal(recs.get('p9').parentId, S.RECOVERED_SECTION)
  assert.ok(!recs.has('p1'))
})

test('nodes moved into each other on two laptops do not make a loop', () => {
  const base = S.stampWorkspace(null, {
    version: 1, favorites: [],
    tree: [node('nb', 'notebook', 'NB', [node('x', 'section', 'X'), node('y', 'section', 'Y')])],
  }, 'A', 1).workspace
  const a = clone(base)
  const [x, y] = a.tree[0].children
  a.tree[0].children = [{ ...x, children: [y] }]
  const b = clone(base)
  const [x2, y2] = b.tree[0].children
  b.tree[0].children = [{ ...y2, children: [x2] }]
  const m = S.mergeWorkspaces(S.stampWorkspace(base, a, 'A', tick()).workspace, S.stampWorkspace(base, b, 'B', tick()).workspace, 'a')
  const recs = S.flattenTree(m.tree)
  assert.ok(recs.has('x') && recs.has('y'))
})

test('favorites added on both laptops are both kept', () => {
  const a = { ...clone(ws0), favorites: ['p1'] }
  const b = { ...clone(ws0), favorites: ['p2'] }
  const m = S.mergeWorkspaces(S.stampWorkspace(ws0, a, 'A', tick()).workspace, S.stampWorkspace(ws0, b, 'B', tick()).workspace, 'a')
  assert.deepEqual(m.favorites.sort(), ['p1', 'p2'])
})

test('collapsing a folder is not a synced change', () => {
  const a = clone(ws0)
  a.tree[0].collapsed = true
  assert.equal(S.stampWorkspace(ws0, a, 'A', tick()).bumped, false)
})

/* ---------------- settings ---------------- */

test('settings: the newest change to each setting wins', () => {
  const base = S.stampSettings(null, { theme: 'dark', gridSize: 20 }, 1).settings
  const a = S.stampSettings(base, { ...base, theme: 'light' }, 100).settings
  const b = S.stampSettings(base, { ...base, gridSize: 24 }, 200).settings
  const m = S.mergeSettings(a, b, 'a')
  assert.equal(m.theme, 'light')
  assert.equal(m.gridSize, 24)
})

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
