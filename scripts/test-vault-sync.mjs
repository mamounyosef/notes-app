/**
 * End to end tests for shared/vault-sync.mjs: two "laptops" (two sync
 * services with their own private state) sharing one notes folder, the way
 * Google Drive makes them share it.
 * Run: node scripts/test-vault-sync.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VaultSync } from '../shared/vault-sync.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-sync-test-'))
const vault = path.join(root, 'vault')
fs.mkdirSync(vault)

function laptop(name) {
  const events = []
  const s = new VaultSync({ stateDir: path.join(root, `state-${name}`), emit: (ev) => events.push(ev) })
  s.setVault(vault)
  return { s, events, name }
}

const cell = (id, html) => ({ id, kind: 'text', x: 0, y: 0, w: 200, h: 100, z: 1, title: '', showTitle: true, html, createdAt: 1, updatedAt: 1 })
const page = (cells) => ({ id: 'p1', title: 'Page', cells, strokes: [], gridSize: 20, createdAt: 1, updatedAt: 1 })
const html = (p, id) => p.cells.find((c) => c.id === id)?.html
const readDisk = async () => JSON.parse(await fsp.readFile(path.join(vault, 'pages', 'p1.json'), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const A = laptop('A')
const B = laptop('B')
await A.s.ready
await B.s.ready

await test('a save on one laptop reaches the other as an event', async () => {
  const r = await A.s.write('page', 'p1', page([cell('c1', 'one'), cell('c2', 'two')]), null, null)
  assert.equal(html(r.data, 'c1'), 'one')
  await sleep(20)
  await B.s.scan()
  const ev = B.events.find((e) => e.type === 'page' && e.id === 'p1')
  assert.ok(ev, 'B got an event')
  assert.equal(html(ev.data, 'c2'), 'two')
})

await test('our own saves do not come back as events', async () => {
  A.events.length = 0
  await A.s.scan()
  assert.equal(A.events.filter((e) => e.type === 'page').length, 0)
})

await test('both laptops edit from the same version: nothing is lost', async () => {
  const base = (await A.s.read('page', 'p1')).data
  const a = structuredClone(base)
  a.cells[0].html = 'A edit'
  const b = structuredClone(base)
  b.cells[1].html = 'B edit'
  await A.s.write('page', 'p1', a, base, null)
  await sleep(20)
  const r = await B.s.write('page', 'p1', b, base, null) // B has not seen A's save yet
  assert.equal(html(r.data, 'c1'), 'A edit')
  assert.equal(html(r.data, 'c2'), 'B edit')
  const disk = await readDisk()
  assert.equal(html(disk, 'c1'), 'A edit')
  assert.equal(html(disk, 'c2'), 'B edit')
})

await test('an old copy of the file put back by the cloud drive is repaired', async () => {
  const before = await readDisk()
  const base = structuredClone(before)
  const a = structuredClone(before)
  a.cells[0].html = 'A important'
  await A.s.write('page', 'p1', a, base, null)
  // The cloud drive replaces the file with the older version.
  await sleep(20)
  await fsp.writeFile(path.join(vault, 'pages', 'p1.json'), JSON.stringify(before, null, 2))
  await A.s.scan()
  const disk = await readDisk()
  assert.equal(html(disk, 'c1'), 'A important')
})

await test('a duplicate "p1 (1).json" from the cloud drive is merged and trashed', async () => {
  const cur = await readDisk()
  const dup = structuredClone(cur)
  dup.cells.push({ ...cell('c9', 'from duplicate'), vv: { X: 1 } })
  await fsp.writeFile(path.join(vault, 'pages', 'p1 (1).json'), JSON.stringify(dup))
  await A.s.scan()
  const disk = await readDisk()
  assert.equal(html(disk, 'c9'), 'from duplicate')
  assert.ok(!fs.existsSync(path.join(vault, 'pages', 'p1 (1).json')))
  const trash = await fsp.readdir(path.join(vault, '.trash'))
  assert.ok(trash.some((n) => n.includes('p1 (1).json')))
})

await test('a damaged file is reported, never overwritten by a read', async () => {
  const file = path.join(vault, 'pages', 'bad.json')
  await fsp.writeFile(file, '{ not json')
  const r = await A.s.read('page', 'bad')
  assert.equal(r.damaged, true)
  assert.equal(await fsp.readFile(file, 'utf8'), '{ not json')
})

await test('same cell edited on both laptops: both versions kept and listed as a conflict', async () => {
  const base = (await A.s.read('page', 'p1')).data
  const a = structuredClone(base)
  a.cells.find((c) => c.id === 'c2').html = 'A wins?'
  const b = structuredClone(base)
  b.cells.find((c) => c.id === 'c2').html = 'B wins?'
  await A.s.write('page', 'p1', a, base, null)
  const r = await B.s.write('page', 'p1', b, base, null)
  const htmls = r.data.cells.map((c) => c.html)
  assert.ok(htmls.includes('A wins?') && htmls.includes('B wins?'))
  // The tree must know the page for it to be listed.
  await A.s.write('workspace', undefined, { version: 1, favorites: [], tree: [{ id: 'nb', kind: 'notebook', title: 'NB', createdAt: 1, updatedAt: 1, children: [{ id: 's', kind: 'section', title: 'S', createdAt: 1, updatedAt: 1, children: [{ id: 'p1', kind: 'page', title: 'Page', createdAt: 1, updatedAt: 1, children: [] }] }] }] }, null)
  await B.s.scan()
  const list = await B.s.listConflicts()
  assert.equal(list.cells.filter((c) => c.pageId === 'p1').length, 1)
})

await test('a deleted page whose file is in .trash comes back when opened', async () => {
  await A.s.write('page', 'p2', { ...page([cell('z', 'keep me')]), id: 'p2' }, null, null)
  await A.s.deletePage('p2')
  assert.ok(!fs.existsSync(path.join(vault, 'pages', 'p2.json')))
  const r = await B.s.read('page', 'p2')
  assert.equal(html(r.data, 'z'), 'keep me')
})

await test('a write while a half written file sits on disk does not lose it', async () => {
  const file = path.join(vault, 'pages', 'p3.json')
  await fsp.writeFile(file, '{"id":"p3","cel')
  const r = await A.s.write('page', 'p3', { ...page([cell('q', 'new')]), id: 'p3' }, null, null)
  assert.equal(html(r.data, 'q'), 'new')
  const trash = await fsp.readdir(path.join(vault, '.trash'))
  assert.ok(trash.some((n) => n.startsWith('p3-damaged-')), 'the damaged file was set aside')
})

A.s.stop()
B.s.stop()
await fsp.rm(root, { recursive: true, force: true })
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
process.exit(process.exitCode || 0)
