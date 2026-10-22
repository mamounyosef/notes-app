/**
 * Randomized check that two computers always settle on one copy.
 *
 * Every sync loop so far had the same cause: two copies that differed in
 * something small (a save time, a measured size, a setting nobody changed),
 * and a merge rule that let each computer keep its own. They then sent the
 * note to each other forever. This builds thousands of random pairs of
 * copies, including the "same version, different content" pairs an old or
 * buggy copy of the app makes, and checks for every pair that:
 *
 *  - the merge rules give the same result in either order (what sync compares);
 *  - two computers exchanging through the cloud stop uploading within a few rounds.
 *
 * Run: node scripts/test-sync-converge.mjs [rounds] [seed]
 */
import assert from 'node:assert/strict'
import * as S from '../shared/sync-core.mjs'
import { mergeChats } from '../shared/chat-store.mjs'

const ROUNDS = Number(process.argv[2]) || 3000
const SEED = Number(process.argv[3]) || 1

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let rand = rng(SEED)
const int = (n) => Math.floor(rand() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => rand() < p
const clone = (v) => JSON.parse(JSON.stringify(v))
// Small pools on purpose: ties are where the bugs were.
const TIMES = [0, 100, 100, 200, 300]

/* ---------------- random copies ---------------- */

function randomCell(id) {
  const c = {
    id, kind: pick(['text', 'image']), x: pick([0, 20]), y: pick([0, 40]), w: pick([200, 240]), h: pick([100, 120]), z: pick([1, 2]),
    title: pick(['', 'T']), showTitle: chance(0.5), html: pick(['<p>a</p>', '<p>b</p>', '<p>c</p>']), autoHeight: chance(0.5),
    createdAt: 1, updatedAt: pick(TIMES),
  }
  if (chance(0.3)) c.collapsed = true
  if (chance(0.3)) c.locked = true
  return c
}

function randomPage() {
  const cells = Array.from({ length: 1 + int(4) }, (_, i) => randomCell(`c${i}`))
  const p = { id: 'p1', title: pick(['A', 'B']), cells, strokes: [], gridSize: pick([20, 24]), createdAt: pick([0, 5, 9]), updatedAt: pick(TIMES) }
  if (chance(0.3)) p.needsReflow = true
  return S.stampPage(null, p, 'base', null, 50).page
}

/** One computer's edits: proper (stamped) ones and unversioned drift. */
function editPage(page, device) {
  let cur = clone(page)
  const touched = { cells: [] }
  for (let n = int(4); n > 0; n--) {
    const cs = cur.cells
    const c = cs.length ? pick(cs) : null
    switch (int(6)) {
      case 0: if (c) { c.html = pick(['<p>x</p>', '<p>y</p>']); } break
      case 1: if (c) { c.x = pick([0, 60]); touched.cells.push(c.id) } break
      case 2: cs.push(randomCell(`n${int(3)}`)); break
      case 3: if (c) cur.cells = cs.filter((x) => x !== c); break
      case 4: cur.title = pick(['A', 'B', 'C']); break
      default: if (c) c.locked = !c.locked
    }
  }
  if (chance(0.7)) cur = S.stampPage(page, cur, device, touched, pick(TIMES) + 1000).page
  return driftPage(cur)
}

/** Changes without a version bump: what an old copy of the app or a bug does. */
function driftPage(p) {
  for (let n = int(3); n > 0; n--) {
    const c = p.cells.length ? pick(p.cells) : null
    switch (int(7)) {
      case 0: if (c) c.updatedAt = pick(TIMES); break
      case 1: if (c) c.h = pick([100, 130]); break
      case 2: if (c) c.collapsed = !c.collapsed; break
      case 3: p.gridSize = pick([20, 24]); break
      case 4: p.needsReflow = chance(0.5) || undefined; break
      case 5: p.updatedAt = pick(TIMES); break
      default: if (c) c.html = pick(['<p>a</p>', '<p>q</p>'])
    }
  }
  return p
}

function randomWorkspace() {
  const node = (id, kind, children = []) => ({ id, kind, title: pick(['N', 'M']), children, createdAt: 1, updatedAt: pick(TIMES) })
  const tree = [node('nb1', 'notebook', [node('s1', 'section', [node('p1', 'page'), node('p2', 'page')]), node('s2', 'section', [node('p3', 'page')])]), node('nb2', 'notebook')]
  return S.stampWorkspace(null, { version: 1, tree, favorites: chance(0.5) ? ['p1'] : [] }, 'base', 50).workspace
}

function editWorkspace(ws, device) {
  let cur = clone(ws)
  const all = () => [...S.flattenTree(cur.tree).values()]
  const find = (id, nodes = cur.tree) => {
    for (const n of nodes) {
      if (n.id === id) return n
      const f = find(id, n.children || [])
      if (f) return f
    }
    return null
  }
  for (let n = int(4); n > 0; n--) {
    const r = pick(all())
    const node = find(r.id)
    switch (int(6)) {
      case 0: node.title = pick(['X', 'Y']); break
      case 1: node.children?.reverse(); break
      case 2: { const s = find(pick(['s1', 's2'])); if (s) s.children.push({ id: `q${int(3)}`, kind: 'page', title: 'q', children: [], createdAt: 1, updatedAt: pick(TIMES) }) } break
      case 3: { const s = find(pick(['s1', 's2'])); if (s?.children.length) s.children.pop() } break
      case 4: cur.favorites = chance(0.5) ? ['p1', 'p2'] : ['p2']; break
      default: node.updatedAt = pick(TIMES)
    }
  }
  if (chance(0.7)) cur = S.stampWorkspace(ws, cur, device, pick(TIMES) + 1000).workspace
  // Drift: a save time or an order changed without a version bump.
  for (let n = int(2); n > 0; n--) {
    const node = find(pick(all()).id)
    if (chance(0.5)) node.updatedAt = pick(TIMES)
    else node.children?.reverse()
  }
  return cur
}

function randomSettings() {
  const s = { _t: {} }
  for (const k of ['theme', 'gridSize', 'penColor', 'font']) {
    if (chance(0.8)) s[k] = pick(['a', 'b', 1, 2])
    s._t[k] = pick([0, 0, 5, 9])
  }
  return s
}

function editSettings(s) {
  const out = clone(s)
  for (let n = int(3); n > 0; n--) {
    const k = pick(['theme', 'gridSize', 'penColor', 'font', 'extra'])
    if (chance(0.2)) delete out[k]
    else out[k] = pick(['a', 'b', 'c', 1, 2])
    out._t[k] = pick([0, 0, 5, 9, 12])
  }
  return out
}

function randomChat() {
  const msg = (i) => ({ id: `m${i}`, role: pick(['user', 'assistant', 'tool']), text: pick(['hi', 'yo']), at: pick([1, 1, 2]), v: pick([0, 1]) })
  return {
    id: 'c1', title: pick(['T', 'U']), titleAt: pick([0, 0, 5]), createdAt: pick([0, 3]), updatedAt: pick(TIMES),
    messages: Array.from({ length: 1 + int(3) }, (_, i) => msg(i)), chosen: chance(0.5) ? { f: { pick: pick([0, 1]), at: pick([0, 4]) } } : {},
  }
}

function editChat(c) {
  const out = clone(c)
  for (let n = int(3); n > 0; n--) {
    switch (int(4)) {
      case 0: out.title = pick(['T', 'U', 'V']); out.titleAt = pick([0, 5, 7]); break
      case 1: {
        const m = { id: `m${3 + int(3)}`, role: 'assistant', text: pick(['a', 'b']), at: pick([2, 3]), v: 0 }
        if (!out.messages.some((x) => x.id === m.id)) out.messages.push(m)
        break
      }
      case 2: { const m = pick(out.messages); m.text = pick(['e', 'f']); m.v = pick([0, 1, 2]) } break
      default: out.chosen = { ...out.chosen, f: { pick: pick([0, 1, 2]), at: pick([0, 4]) } }
    }
  }
  return out
}

/* ---------------- the checks ---------------- */

const KINDS = {
  page: { make: randomPage, edit: editPage, merge: (a, b) => S.mergePages(a, b, 'a'), view: (d) => S.stable(S.syncView('page', d)) },
  workspace: { make: randomWorkspace, edit: editWorkspace, merge: (a, b) => S.mergeWorkspaces(a, b, 'a'), view: (d) => S.stable(d) },
  settings: { make: randomSettings, edit: editSettings, merge: (a, b) => S.mergeSettings(a, b, 'a'), view: (d) => S.stable(d) },
  chat: { make: randomChat, edit: editChat, merge: mergeChats, view: (d) => S.stable(d), settle: (a, b) => mergeChats(a, b) },
}
const settle = (kind, a, b) => (kind === 'chat' ? mergeChats(a, b) : S.mergeSettled(kind, a, b))

/**
 * Two computers and the cloud, like shared/cloud-sync.mjs: pull the cloud
 * copy, merge it in, upload when the result differs from the cloud.
 * Returns how many uploads happened in the last rounds (0 when settled).
 */
function exchange(kind, pc, laptop) {
  const k = KINDS[kind]
  let cloud = pc
  const sides = [pc, laptop]
  let late = 0
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < 2; i++) {
      sides[i] = settle(kind, sides[i], cloud)
      if (k.view(sides[i]) !== k.view(cloud)) {
        cloud = sides[i]
        if (round >= 6) late++
      }
    }
  }
  assert.equal(k.view(sides[0]), k.view(sides[1]), 'the two computers ended with different copies')
  return late
}

let failed = 0
const shown = {}
const fail = (kind, what, a, b, e) => {
  failed++
  shown[kind] = (shown[kind] || 0) + 1
  if (shown[kind] <= 2) console.log(`FAIL ${kind}: ${what}\n  ${e?.message || e}\n  A ${JSON.stringify(a)}\n  B ${JSON.stringify(b)}`)
}

for (const kind of Object.keys(KINDS)) {
  const k = KINDS[kind]
  rand = rng(SEED * 7919 + kind.length)
  let n = 0
  for (let i = 0; i < ROUNDS; i++) {
    const base = k.make()
    const a = k.edit(base, 'PC')
    const b = k.edit(base, 'LT')
    try {
      assert.equal(k.view(k.merge(a, b)), k.view(k.merge(b, a)))
    } catch (e) {
      fail(kind, 'merge result depends on the order', a, b, e)
      continue
    }
    try {
      const m = k.merge(a, b)
      assert.equal(k.view(k.merge(m, m)), k.view(m), 'merging a copy with itself changed it')
      assert.equal(exchange(kind, a, b), 0, 'still uploading after 6 rounds (a sync loop)')
    } catch (e) {
      fail(kind, 'did not settle', a, b, e)
      continue
    }
    n++
  }
  console.log(`${n === ROUNDS ? 'ok  ' : 'FAIL'} ${kind}: ${n}/${ROUNDS} random pairs settle on one copy`)
}
if (failed) process.exitCode = 1
