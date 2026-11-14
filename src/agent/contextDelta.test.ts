// Run: npm run test:context
import assert from 'node:assert/strict'
import { cellKeys, contextDelta } from './contextDelta.ts'

const long = (s: string) => `${s} ${'x'.repeat(2000)}`
const ctx = (o: { page?: string; a: string; b: string; state?: string; tree?: string; mention?: boolean }) =>
  [
    'Local time: now',
    `OPEN PAGE: "P" [${o.page || 'p1'}]`,
    'Cells on screen: [c1] "A"',
    '',
    'PAGE CONTENT (top to bottom, all cells):',
    [`### Cell [c1] "A - B" - ${o.state || 'ON SCREEN'}\nx=0 y=0 w=1 h=1 z=1\n${o.a}`, `### Cell [c2] "B" - off screen, below the view\nx=0 y=9 w=1 h=1 z=1\n${o.b}`].join('\n\n'),
    ...(o.mention ? ['', 'THE USER POINTED AT THESE WITH @:', '## Page "Q" [q1] (0 cells)'] : []),
    '',
    'NOTEBOOK TREE (notebook > section > page; ids in brackets):',
    o.tree || '- notebook "N" [n1]',
    'Total pages: 1.',
    'Look: theme dark',
  ].join('\n')

const it = (name: string, fn: () => void) => {
  fn()
  console.log('ok', name)
}

it('sends only the changed cell', () => {
  const d = contextDelta(ctx({ a: long('one'), b: long('two') }), ctx({ a: long('ONE'), b: long('two') }))!
  assert.ok(d.includes('(CHANGED) ### Cell [c1]'))
  assert.ok(!d.includes('Cell [c2]'))
  assert.ok(d.includes('NOTEBOOK TREE: unchanged'))
  assert.ok(d.includes('Look: theme dark'))
  assert.ok(d.includes('Cells on screen:'))
})
it('ignores a change of on screen state only', () => {
  const d = contextDelta(ctx({ a: long('one'), b: long('two') }), ctx({ a: long('one'), b: long('two'), state: 'PARTLY ON SCREEN (40% shown; top is scrolled off)' }))!
  assert.ok(d.includes('No cell content changed.'))
})
it('falls back to the full context on another page', () => {
  assert.equal(contextDelta(ctx({ a: long('one'), b: long('two') }), ctx({ page: 'p2', a: long('one'), b: long('two') })), null)
})
it('sends a changed tree and keeps mentions', () => {
  const d = contextDelta(ctx({ a: long('one'), b: long('two') }), ctx({ a: long('one'), b: long('two'), tree: '- notebook "M" [n2]', mention: true }))!
  assert.ok(d.includes('- notebook "M" [n2]'))
  assert.ok(d.includes('THE USER POINTED AT THESE WITH @:'))
})
it('skips cells exactly as the model last left them, not ones changed after', () => {
  const prev = ctx({ a: long('one'), b: long('two') })
  const left = ctx({ a: long('ONE'), b: long('two') })
  const mine = cellKeys(left)
  const d = contextDelta(prev, left, mine)!
  assert.ok(d.includes('not repeated): [c1]'))
  assert.ok(!d.includes('(CHANGED)'))
  const d2 = contextDelta(prev, ctx({ a: long('ONE!'), b: long('two') }), mine)!
  assert.ok(d2.includes('(CHANGED) ### Cell [c1]'))
})
