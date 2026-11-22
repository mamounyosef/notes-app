// Run: npm run test:memory
import assert from 'node:assert/strict'
import { hideMemoryMarker, takeMemoryMarker } from './memoryMarker.ts'

// A finished reply: the line goes, its ids are kept.
let r = takeMemoryMarker('Done, I drew it inside a box.\n\n[[mem: m4k2, m9ab]]')
assert.equal(r.text, 'Done, I drew it inside a box.')
assert.deepEqual(r.ids, ['m4k2', 'm9ab'])

// Brackets around ids, other spellings, repeats.
r = takeMemoryMarker('Ok.\n[[memory: [m4k2], [M4K2] m77x]]\n')
assert.deepEqual(r.ids, ['m4k2', 'm77x'])
assert.equal(r.text, 'Ok.')

// No marker: untouched, and other [[ ]] text survives.
assert.deepEqual(takeMemoryMarker('See [[Wiki link]] here.'), { text: 'See [[Wiki link]] here.', ids: [] })
assert.deepEqual(takeMemoryMarker(''), { text: '', ids: [] })

// Streaming: a half written marker never flashes on screen.
assert.equal(hideMemoryMarker('Done.\n\n[['), 'Done.')
assert.equal(hideMemoryMarker('Done.\n\n[[me'), 'Done.')
assert.equal(hideMemoryMarker('Done.\n\n[[mem: m4'), 'Done.')
assert.equal(hideMemoryMarker('Done.\n\n[[mem: m4k2]]'), 'Done.')
assert.equal(hideMemoryMarker('Done.\n['), 'Done.')
// ...but a link being written is left alone.
assert.equal(hideMemoryMarker('See [[Wiki'), 'See [[Wiki')
assert.equal(hideMemoryMarker('A [link](x)'), 'A [link](x)')

console.log('memoryMarker: all passed')
