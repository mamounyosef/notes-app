// Tests for shared/search-core.mjs: node scripts/test-search.mjs
import assert from 'node:assert/strict'
import { searchPages, parseQuery, suggestion } from '../shared/search-core.mjs'

const now = Date.now()
const pages = [
  { id: 'p1', title: 'General DL and Backpropagation', path: ['Courses', 'General-Other Notes'], updatedAt: now - 30 * 864e5,
    cells: [{ id: 'c1', title: 'Chain rule', html: '<p>Backpropagation applies the chain rule to compute gradients.</p>' }] },
  { id: 'p2', title: 'Optimizers', path: ['Courses', 'Deep Learning'], updatedAt: now,
    cells: [{ id: 'c2', title: '', html: '<p>Gradient descent with momentum. Adam uses the gradient and its square.</p>' },
            { id: 'c3', title: 'Learning rate', html: '<p>Schedules: cosine, step.</p>' }] },
  { id: 'p3', title: 'New Words', path: ['Other Notes', 'New Words'], updatedAt: now,
    cells: [{ id: 'c4', title: '', html: '<p>Contemplating : thinking deeply</p><p>Mundane: ordinary, café talk</p>' }] },
]
let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

t('exact title ranks first', () => {
  const r = searchPages('backpropagation', pages)
  assert.equal(r[0].pageId, 'p1')
  assert.ok(r[0].titleMarks.length)
})
t('typo finds the word', () => {
  const r = searchPages('backpropogation', pages)
  assert.equal(r[0].pageId, 'p1')
  const r2 = searchPages('contemplatng', pages)
  assert.equal(r2[0].pageId, 'p3')
})
t('prefix matches', () => {
  const r = searchPages('grad', pages)
  assert.deepEqual(r.map((x) => x.pageId).sort(), ['p1', 'p2'])
})
t('all words must match, in any field', () => {
  const r = searchPages('courses momentum', pages)
  assert.deepEqual(r.map((x) => x.pageId), ['p2'])
})
t('falls back to partial matches', () => {
  const r = searchPages('momentum zebra', pages)
  assert.equal(r[0].pageId, 'p2')
  assert.equal(r[0].partial, true)
})
t('accents are ignored', () => {
  assert.equal(searchPages('cafe', pages)[0].pageId, 'p3')
})
t('quoted phrase must match as written', () => {
  assert.equal(searchPages('"chain rule"', pages)[0].pageId, 'p1')
  assert.equal(searchPages('"rule chain"', pages).length, 0)
})
t('cell hit snippet marks the match', () => {
  const r = searchPages('momentum', pages)
  const h = r[0].hits[0]
  const [a, b] = h.marks[0]
  assert.equal(h.snippet.slice(a, b).toLowerCase(), 'momentum')
})
t('short words do not fuzz', () => {
  assert.equal(searchPages('adm', pages).length, 0)
})
t('near matches are reported, with a suggestion', () => {
  const r = searchPages('backpropogation', pages)
  assert.deepEqual(r[0].near, [{ term: 'backpropogation', word: 'Backpropagation' }])
  assert.equal(suggestion('backpropogation', r), 'backpropagation')
  assert.equal(suggestion('backpropagation', searchPages('backpropagation', pages)), null)
})
t('partial results name the missing word', () => {
  const r = searchPages('momentum zebra', pages)
  assert.deepEqual(r[0].missing, ['zebra'])
  assert.deepEqual(searchPages('courses momentum', pages)[0].matchedIn, ['notebook', 'text'])
})
t('parse', () => {
  assert.deepEqual(parseQuery('Foo "bar baz" qux,').terms, ['foo', 'qux'])
})
console.log(`${n} search tests passed`)
