// Run: npm run test:memory
import assert from 'node:assert/strict'
import { memoryKnown, memoryTurn, type MemNow } from './memoryDelta.ts'
import type { MemoryItem } from '../types.ts'

const item = (id: string, text: string, sec?: string): MemoryItem => ({ id, text, kind: 'rule', createdAt: 1, updatedAt: 1, by: 'you', ...(sec ? { notebookId: sec, notebookTitle: sec.toUpperCase() } : {}) })
const g1 = item('mg01', 'Answer briefly.')
const es = item('mes1', 'Logic diagrams in a box.', 'es')
const dl = item('mdl1', 'Use PyTorch notation.', 'dl')
const now = (sec: string | null, inScope: MemoryItem[], on = true): MemNow => ({ on, sec: sec ? { id: sec, title: sec.toUpperCase() } : null, inScope, elsewhere: 0 })

// First message: the full block, general and the open section.
let t = memoryTurn(null, now('es', [g1, es]))
assert.match(t.note, /^<memory>/)
assert.match(t.note, /## General[\s\S]*\[mg01\]/)
assert.match(t.note, /## Section "ES"[\s\S]*\[mes1\]/)
let ctx = t.ctx

// Same place, nothing changed: nothing appended (the conversation stays as it was).
t = memoryTurn(ctx, now('es', [g1, es]))
assert.equal(t.note, '')
ctx = t.ctx

// Moved to another course: only the new section's entries, and the old one's are dropped by one line.
t = memoryTurn(ctx, now('dl', [g1, dl]))
assert.match(t.note, /^<memory_update>/)
assert.match(t.note, /now in section "DL"/)
assert.match(t.note, /section memories of "ES" no longer apply/)
assert.match(t.note, /\[mdl1\].*PyTorch/)
assert.doesNotMatch(t.note, /\[mg01\]/, 'general entries are not repeated')
assert.doesNotMatch(t.note, /No longer apply/, 'leaving a section is said once, not per entry')
ctx = t.ctx

// Back to the first course: ids only, no text again.
t = memoryTurn(ctx, now('es', [g1, es]))
assert.match(t.note, /Apply again, as listed earlier in this conversation: \[mes1\]/)
assert.doesNotMatch(t.note, /Logic diagrams/)
ctx = t.ctx

// Edited in Settings: the new text, once.
const es2 = { ...es, text: 'Logic diagrams in a dashed box.' }
t = memoryTurn(ctx, now('es', [g1, es2]))
assert.match(t.note, /Changed[\s\S]*dashed box/)
ctx = t.ctx

// Forgotten: listed as no longer applying.
t = memoryTurn(ctx, now('es', [es2]))
assert.match(t.note, /No longer apply[^\n]*\[mg01\]/)
ctx = t.ctx

// Saved by the model itself: it already knows, so the next message says nothing.
const g2 = item('mg02', 'Use metric units.')
ctx = memoryKnown(ctx, g2, g2.id, true)
t = memoryTurn(ctx, now('es', [es2, g2]))
assert.equal(t.note, '')
ctx = t.ctx

// Memory turned off, then on again.
t = memoryTurn(ctx, now('es', [], false))
assert.match(t.note, /turned memory off/)
ctx = t.ctx
t = memoryTurn(ctx, now('es', [es2, g2], false))
assert.equal(t.note, '')
t = memoryTurn(ctx, now('es', [es2, g2]))
assert.match(t.note, /Memory is on again/)

console.log('memoryDelta: all passed')
