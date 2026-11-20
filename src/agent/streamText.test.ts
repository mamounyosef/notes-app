import assert from 'node:assert/strict'
import { splitBlocks, healTail, nextShown } from './streamText.ts'

const eq = (a: unknown, b: unknown, msg: string) => {
  assert.deepEqual(a, b, msg)
  console.log('ok', msg)
}

eq(splitBlocks('a\nb\n\nc'), ['a\nb', 'c'], 'splits paragraphs at blank lines')
eq(splitBlocks('```js\nx\n\ny\n```\n\nz'), ['```js\nx\n\ny\n```', 'z'], 'keeps code fences whole')
eq(splitBlocks('$$\na\n\nb\n$$\n\nz'), ['$$\na\n\nb\n$$', 'z'], 'keeps display math whole')
eq(splitBlocks('- a\n\n- b\n\n  more\n\nend'), ['- a\n\n- b\n\n  more', 'end'], 'keeps a loose list together')
eq(splitBlocks('1. a\n2. b\n\nText'), ['1. a\n2. b', 'Text'], 'list then paragraph')
eq(splitBlocks('a\n\n\n\nb\n\n'), ['a', 'b'], 'extra blank lines')
eq(splitBlocks(''), [], 'empty')

eq(healTail('This is **bo'), 'This is **bo**', 'closes open bold')
eq(healTail('This is **'), 'This is ', 'drops a bare opening bold')
eq(healTail('use `npm i'), 'use `npm i`', 'closes inline code')
eq(healTail('so $x^2 + '), 'so ', 'holds back an open formula')
eq(healTail('costs $5 and'), 'costs $5 and', 'keeps a price')
eq(healTail('done $x$ ok'), 'done $x$ ok', 'keeps a closed formula')
eq(healTail('see [the docs](http://exa'), 'see ', 'holds back an open link')
eq(healTail('see [the docs](http://x.y) ok'), 'see [the docs](http://x.y) ok', 'keeps a closed link')
eq(healTail('text\n\n$$\n\\frac{a'), 'text\n\n', 'holds back an open display formula')
eq(healTail('```\ncode **x'), '```\ncode **x', 'leaves open code fences alone')
eq(healTail('intro\n- '), 'intro\n', 'drops a lone list marker')
eq(healTail('~~old'), '~~old~~', 'closes strike')

let s = 0
for (let i = 0; i < 30; i++) s = nextShown(s, 500, 16.7)
assert.ok(s > 450 && s <= 500, `catches up a 500 char burst in half a second (got ${s})`)
console.log('ok catches up a burst')
assert.equal(nextShown(10, 10, 16), 10)
assert.ok(nextShown(0, 3, 16) >= 0.5, 'always moves')
console.log('ok all')
