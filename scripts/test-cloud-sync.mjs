/**
 * End to end tests for shared/cloud-sync.mjs: two computers, each with its
 * own notes folder, syncing through an in-memory copy of the Supabase tables
 * (same rules as supabase/schema.sql: rev compare and swap, change_seq).
 * Run: node scripts/test-cloud-sync.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VaultSync } from '../shared/vault-sync.mjs'
import { CloudSync } from '../shared/cloud-sync.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cloud-test-'))

/* ---------------- fake cloud ---------------- */

const server = { seq: 0, docs: new Map(), files: new Map(), blobs: new Map(), rejected: 0 }
const clone = (v) => (v == null ? v : structuredClone(v))

function push(table, key, fields, expectedRev) {
  const cur = table.get(key)
  if (expectedRev === 0 ? cur : !cur || cur.rev !== expectedRev) {
    server.rejected++
    return { ok: false }
  }
  const row = { ...clone(fields), rev: (cur?.rev || 0) + 1, change_seq: ++server.seq }
  table.set(key, row)
  return { ok: true, rev: row.rev, change_seq: row.change_seq }
}

function remoteFor(name) {
  const net = { online: true }
  const guard = async (fn) => {
    if (!net.online) throw new Error('fetch failed')
    return fn()
  }
  const remote = {
    session: () => guard(() => ({ email: 'me@test', userId: 'u1' })),
    docsSince: (seq) => guard(() => [...server.docs.values()].filter((r) => r.change_seq > seq).sort((a, b) => a.change_seq - b.change_seq).map(clone)),
    docRevs: () => guard(() => [...server.docs.values()].map((r) => ({ kind: r.kind, doc_id: r.doc_id, rev: r.rev, change_seq: r.change_seq }))),
    getDoc: (kind, docId) => guard(() => clone(server.docs.get(`${kind}:${docId}`) || null)),
    pushDoc: ({ kind, docId, data, expectedRev, deleted, device }) =>
      guard(() => push(server.docs, `${kind}:${docId}`, { kind, doc_id: docId, data, deleted, device }, expectedRev)),
    filesSince: (seq) => guard(() => [...server.files.values()].filter((r) => r.change_seq > seq).sort((a, b) => a.change_seq - b.change_seq).map(clone)),
    fileRevs: () => guard(() => [...server.files.values()].map(clone)),
    getFile: (p) => guard(() => clone(server.files.get(p) || null)),
    pushFile: ({ path: p, sha, size, expectedRev, deleted, device }) =>
      guard(() => push(server.files, p, { path: p, sha, size, deleted, device }, expectedRev)),
    hasBlob: (sha) => guard(() => server.blobs.has(sha)),
    uploadBlob: (sha, buf) => guard(() => void server.blobs.set(sha, Buffer.from(buf))),
    downloadBlob: (sha) => guard(() => Buffer.from(server.blobs.get(sha))),
    subscribe: () => () => {},
  }
  return { remote, net, name }
}

/* ---------------- two computers ---------------- */

function computer(name) {
  const vaultDir = path.join(root, `vault-${name}`)
  fs.mkdirSync(vaultDir, { recursive: true })
  const stateDir = path.join(root, `state-${name}`)
  let cloud
  const events = []
  const vault = new VaultSync({
    stateDir,
    emit: (ev) => events.push(ev),
    onLocalChange: (kind, id, info) => cloud?.markDirty(kind, id, info),
  })
  vault.setVault(vaultDir)
  cloud = new CloudSync({ vault, stateDir })
  cloud.setVaultDir(vaultDir)
  const { remote, net } = remoteFor(name)
  cloud.setRemote(remote)
  return { name, vault, cloud, net, events, dir: vaultDir }
}

const cell = (id, html) => ({ id, kind: 'text', x: 0, y: 0, w: 200, h: 100, z: 1, title: '', showTitle: true, html, createdAt: 1, updatedAt: 1 })
const page = (id, cells) => ({ id, title: 'Page', cells, strokes: [], gridSize: 20, createdAt: 1, updatedAt: 1 })
const html = (p, id) => p?.cells.find((c) => c.id === id)?.html
const readPage = async (c, id) => (await c.vault.read('page', id)).data
const sync = async (...cs) => {
  for (const c of cs) await c.cloud.syncNow()
}

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.log(`FAIL ${name}`)
    console.log(e)
    process.exitCode = 1
  }
}

const PC = computer('pc')
const LT = computer('laptop')
await PC.vault.ready
await LT.vault.ready

await test('a page made on the PC reaches the laptop', async () => {
  await PC.vault.write('page', 'p1', page('p1', [cell('c1', 'one')]), null, null)
  await sync(PC, LT)
  assert.equal(html(await readPage(LT, 'p1'), 'c1'), 'one')
  assert.ok(LT.events.some((e) => e.type === 'page' && e.id === 'p1'), 'the laptop app was told')
})

await test('THE BUG: laptop starts offline with an old copy, edits it, and the PC note survives', async () => {
  LT.net.online = false
  const base = await readPage(PC, 'p1')
  await PC.vault.write('page', 'p1', { ...base, cells: [...base.cells, cell('c2', 'made on PC')] }, base, null)
  await sync(PC)

  const stale = await readPage(LT, 'p1') // only c1: it has not seen c2
  assert.equal(html(stale, 'c2'), undefined)
  await LT.vault.write('page', 'p1', { ...stale, cells: [...stale.cells, cell('c3', 'made on laptop offline')] }, stale, null)
  await sync(LT) // fails quietly, offline
  assert.equal(LT.cloud.status().phase, 'offline')

  const rejectedBefore = server.rejected
  LT.net.online = true
  await sync(LT, PC)
  for (const c of [PC, LT]) {
    const p = await readPage(c, 'p1')
    assert.equal(html(p, 'c1'), 'one', c.name)
    assert.equal(html(p, 'c2'), 'made on PC', c.name)
    assert.equal(html(p, 'c3'), 'made on laptop offline', c.name)
  }
  assert.equal(server.rejected, rejectedBefore, 'pulled before pushing, so no stale push was even tried')
})

await test('an empty copy on the laptop never wipes the cloud page', async () => {
  await PC.vault.write('page', 'p2', page('p2', [cell('k', 'keep me')]), null, null)
  await sync(PC)
  LT.net.online = false
  // The laptop saves an empty page with no history at all.
  await LT.vault.write('page', 'p2', page('p2', []), null, null)
  LT.net.online = true
  await sync(LT, PC)
  assert.equal(html(await readPage(PC, 'p2'), 'k'), 'keep me')
  assert.equal(html(await readPage(LT, 'p2'), 'k'), 'keep me')
})

await test('a push that loses the race is merged and retried', async () => {
  const a = await readPage(PC, 'p1')
  const b = await readPage(LT, 'p1')
  await PC.vault.write('page', 'p1', { ...a, cells: [...a.cells, cell('r1', 'PC race')] }, a, null)
  await LT.vault.write('page', 'p1', { ...b, cells: [...b.cells, cell('r2', 'laptop race')] }, b, null)
  await sync(PC)
  // Make the laptop push without pulling first, as if both sent at the same moment.
  const rejectedBefore = server.rejected
  await LT.cloud.pushDocs(LT.cloud.remote)
  assert.ok(server.rejected > rejectedBefore, 'the stale push was refused')
  await sync(LT, PC)
  for (const c of [PC, LT]) {
    const p = await readPage(c, 'p1')
    assert.equal(html(p, 'r1'), 'PC race', c.name)
    assert.equal(html(p, 'r2'), 'laptop race', c.name)
  }
})

await test('same cell edited on both: both versions are kept', async () => {
  const a = await readPage(PC, 'p1')
  const b = await readPage(LT, 'p1')
  await PC.vault.write('page', 'p1', { ...a, cells: a.cells.map((c) => (c.id === 'c1' ? { ...c, html: 'PC wins?' } : c)) }, a, null)
  await LT.vault.write('page', 'p1', { ...b, cells: b.cells.map((c) => (c.id === 'c1' ? { ...c, html: 'laptop wins?' } : c)) }, b, null)
  await sync(PC, LT, PC)
  for (const c of [PC, LT]) {
    const htmls = (await readPage(c, 'p1')).cells.map((x) => x.html)
    assert.ok(htmls.includes('PC wins?') && htmls.includes('laptop wins?'), c.name)
  }
})

await test('a page deleted on the PC goes away on the laptop', async () => {
  await PC.vault.write('page', 'p3', page('p3', [cell('d', 'bye')]), null, null)
  await sync(PC, LT)
  assert.ok(fs.existsSync(path.join(LT.dir, 'pages', 'p3.json')))
  await PC.vault.deletePage('p3')
  await sync(PC, LT)
  assert.ok(!fs.existsSync(path.join(LT.dir, 'pages', 'p3.json')))
  assert.ok(LT.events.some((e) => e.type === 'page-removed' && e.id === 'p3'))
  assert.equal(server.docs.get('page:p3').deleted, true)
})

await test('deleted on the PC while edited on the laptop: the edit is kept', async () => {
  await PC.vault.write('page', 'p4', page('p4', [cell('e', 'v1')]), null, null)
  await sync(PC, LT)
  LT.net.online = false
  const b = await readPage(LT, 'p4')
  await LT.vault.write('page', 'p4', { ...b, cells: [cell('e', 'edited offline')] }, b, null)
  await PC.vault.deletePage('p4')
  await sync(PC)
  LT.net.online = true
  await sync(LT, PC)
  assert.equal(html(await readPage(LT, 'p4'), 'e'), 'edited offline')
  assert.equal(server.docs.get('page:p4').deleted, false)
  assert.equal(html(await readPage(PC, 'p4'), 'e'), 'edited offline')
})

await test('the tree and settings sync too', async () => {
  const ws = { version: 1, favorites: [], tree: [{ id: 'nb', kind: 'notebook', title: 'NB', createdAt: 1, updatedAt: 1, children: [] }] }
  await PC.vault.write('workspace', undefined, ws, null)
  await sync(PC, LT)
  const got = (await LT.vault.read('workspace')).data
  assert.equal(got.tree[0].title, 'NB')
})

await test('images and artifacts sync, deletes follow', async () => {
  await fsp.mkdir(path.join(PC.dir, 'artifacts', 'docs'), { recursive: true })
  await fsp.writeFile(path.join(PC.dir, 'assets', 'a.png'), 'png bytes')
  await fsp.writeFile(path.join(PC.dir, 'artifacts', 'docs', 'y.txt'), 'v1')
  await sync(PC, LT)
  assert.equal(await fsp.readFile(path.join(LT.dir, 'assets', 'a.png'), 'utf8'), 'png bytes')
  assert.equal(await fsp.readFile(path.join(LT.dir, 'artifacts', 'docs', 'y.txt'), 'utf8'), 'v1')

  await fsp.rm(path.join(PC.dir, 'assets', 'a.png'))
  await sync(PC, LT)
  assert.ok(!fs.existsSync(path.join(LT.dir, 'assets', 'a.png')))
})

await test('a file changed on both computers: both copies are kept', async () => {
  const f = (c) => path.join(c.dir, 'artifacts', 'docs', 'y.txt')
  await fsp.writeFile(f(PC), 'PC version')
  LT.net.online = false
  await fsp.writeFile(f(LT), 'laptop version')
  await sync(PC)
  LT.net.online = true
  await sync(LT, PC)
  for (const c of [PC, LT]) {
    const names = await fsp.readdir(path.join(c.dir, 'artifacts', 'docs'))
    const texts = await Promise.all(names.map((n) => fsp.readFile(path.join(c.dir, 'artifacts', 'docs', n), 'utf8')))
    assert.ok(texts.includes('PC version') && texts.includes('laptop version'), `${c.name}: ${names}`)
  }
})

await test('a restart with no changes pushes nothing', async () => {
  await sync(PC, LT, PC, LT)
  const seq = server.seq
  for (const c of [PC, LT]) {
    c.cloud.lastFullAt = 0
    await c.cloud.syncNow()
  }
  assert.equal(server.seq, seq)
})

await test('copies that differ only in save time or measured size do not bounce back and forth', async () => {
  // Seen for real: the same cell version, stamped a few hundred ms apart on each computer.
  for (const [c, h, at] of [[PC, 111, 5], [LT, 222, 6]]) {
    const file = path.join(c.dir, 'pages', 'p1.json')
    const p = JSON.parse(fs.readFileSync(file, 'utf8'))
    p.cells = p.cells.map((x) => (x.id === 'c1' ? { ...x, h, updatedAt: at } : x))
    fs.writeFileSync(file, JSON.stringify(p, null, 2))
    c.cloud.lastFullAt = 0 // the periodic full check looks at every note
  }
  await sync(PC, LT, PC, LT)
  const seq = server.seq
  for (let i = 0; i < 4; i++) await sync(PC, LT)
  assert.equal(server.seq, seq, `kept pushing: ${server.seq - seq} more writes`)
  assert.equal(html(await readPage(PC, 'p1'), 'c1'), html(await readPage(LT, 'p1'), 'c1'))
})

for (const c of [PC, LT]) {
  c.cloud.stop()
  c.vault.stop()
}
await fsp.rm(root, { recursive: true, force: true })
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
process.exit(process.exitCode || 0)
