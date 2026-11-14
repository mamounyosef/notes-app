/**
 * The phone's sync engine (mobile/src/sync/vault.ts + cloud.ts) against the
 * same in-memory cloud as scripts/test-cloud-sync.mjs, with the desktop
 * engine (shared/vault-sync.mjs + cloud-sync.mjs) as the other device. Proves
 * the phone and the computer converge and never lose each other's edits.
 *
 * The phone code is bundled with esbuild, its IndexedDB and picture storage
 * swapped for in-memory versions.
 * Run: node mobile/scripts/test-phone-sync.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { VaultSync } from '../../shared/vault-sync.mjs'
import { CloudSync as DesktopCloud } from '../../shared/cloud-sync.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const esbuild = createRequire(path.join(repo, 'package.json'))('esbuild')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-phone-sync-'))

/* ---------------- bundle the phone engine with memory stores ---------------- */

const memIdb = `
const stores = { docs: new Map(), trash: new Map(), meta: new Map() }
const clone = (v) => (v === undefined ? v : structuredClone(v))
export async function get(s, k) { return clone(stores[s].get(k)) }
export async function put(s, k, v) { stores[s].set(k, clone(v)) }
export async function del(s, k) { stores[s].delete(k) }
export async function keys(s) { return [...stores[s].keys()] }
export async function entries(s) { return [...stores[s].entries()].map(([k, v]) => [k, clone(v)]) }
export async function clearAll() { for (const s of Object.values(stores)) s.clear() }
export async function persist() { return true }
`
const memAssets = `
const files = new Map()
export async function has(n) { return files.has(n) }
export async function write(n, b) { files.set(n, b) }
export async function read(n) { return files.get(n) || null }
export const sizeHint = (n) => files.get(n)?.length || 0
export async function sha1(b) { const d = await crypto.subtle.digest('SHA-1', b); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('') }
export async function sha1Of(n) { const b = files.get(n); return b ? sha1(b) : null }
export function localBytes() { return { count: files.size, bytes: 0 } }
`
fs.writeFileSync(path.join(tmp, 'idb.mjs'), memIdb)
fs.writeFileSync(path.join(tmp, 'assets.mjs'), memAssets)
fs.writeFileSync(
  path.join(tmp, 'entry.ts'),
  `export { MobileVault } from ${JSON.stringify(path.join(repo, 'mobile/src/sync/vault.ts').replace(/\\/g, '/'))}
export { CloudSync } from ${JSON.stringify(path.join(repo, 'mobile/src/sync/cloud.ts').replace(/\\/g, '/'))}
export * as assets from './assets'
`,
)

async function loadPhoneEngine(n) {
  // A fresh bundle per phone, so each has its own memory stores.
  const out = path.join(tmp, `phone-${n}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(tmp, 'entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'error',
    plugins: [
      {
        name: 'memory-stores',
        setup(b) {
          b.onResolve({ filter: /^\.\/idb$/ }, () => ({ path: path.join(tmp, 'idb.mjs') }))
          b.onResolve({ filter: /^\.\/assets$/ }, () => ({ path: path.join(tmp, 'assets.mjs') }))
        },
      },
    ],
  })
  return import(pathToFileURL(out).href)
}

/* ---------------- fake cloud (same rules as supabase/schema.sql) ---------------- */

const server = { seq: 0, docs: new Map(), files: new Map(), blobs: new Map() }
const clone = (v) => (v == null ? v : structuredClone(v))
function push(table, key, fields, expectedRev) {
  const cur = table.get(key)
  if (expectedRev === 0 ? cur : !cur || cur.rev !== expectedRev) return { ok: false }
  const row = { ...clone(fields), rev: (cur?.rev || 0) + 1, change_seq: ++server.seq }
  table.set(key, row)
  return { ok: true, rev: row.rev, change_seq: row.change_seq }
}
function remote() {
  const net = { online: true }
  const g = async (fn) => {
    if (!net.online) throw new Error('fetch failed')
    return fn()
  }
  return {
    net,
    session: () => g(() => ({ email: 'me@test', userId: 'u1' })),
    docsSince: (seq) => g(() => [...server.docs.values()].filter((r) => r.change_seq > seq).sort((a, b) => a.change_seq - b.change_seq).map(clone)),
    docRevs: () => g(() => [...server.docs.values()].map((r) => ({ kind: r.kind, doc_id: r.doc_id, rev: r.rev, change_seq: r.change_seq }))),
    getDoc: (kind, docId) => g(() => clone(server.docs.get(`${kind}:${docId}`) || null)),
    pushDoc: ({ kind, docId, data, expectedRev, deleted, device }) => g(() => push(server.docs, `${kind}:${docId}`, { kind, doc_id: docId, data, deleted, device }, expectedRev)),
    filesSince: (seq) => g(() => [...server.files.values()].filter((r) => r.change_seq > seq).sort((a, b) => a.change_seq - b.change_seq).map(clone)),
    fileRevs: () => g(() => [...server.files.values()].map(clone)),
    getFile: (p) => g(() => clone(server.files.get(p) || null)),
    pushFile: ({ path: p, sha, size, expectedRev, deleted, device }) => g(() => push(server.files, p, { path: p, sha, size, deleted, device }, expectedRev)),
    hasBlob: (sha) => g(() => server.blobs.has(sha)),
    uploadBlob: (sha, buf) => g(() => void server.blobs.set(sha, Buffer.from(buf))),
    downloadBlob: (sha) => g(() => new Uint8Array(server.blobs.get(sha))),
    subscribe: () => () => {},
  }
}

/* ---------------- devices ---------------- */

function computer(name) {
  const dir = path.join(tmp, `vault-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  const stateDir = path.join(tmp, `state-${name}`)
  let cloud
  const vault = new VaultSync({ stateDir, emit: () => {}, onLocalChange: (k, id, info) => cloud?.markDirty(k, id, info) })
  vault.setVault(dir)
  cloud = new DesktopCloud({ vault, stateDir })
  cloud.setVaultDir(dir)
  const r = remote()
  cloud.setRemote(r)
  return { name, vault, cloud, net: r.net, read: async (kind, id) => (await vault.read(kind, id)).data, write: (kind, id, d, base, t) => vault.write(kind, id, d, base, t) }
}

async function phone(n) {
  const { MobileVault, CloudSync, assets } = await loadPhoneEngine(n)
  const vault = new MobileVault()
  const cloud = new CloudSync(vault)
  const events = []
  vault.on((e) => events.push(e))
  await vault.ready
  const r = remote()
  cloud.setRemote(r)
  return { name: `phone${n}`, assets, vault, cloud, net: r.net, events, read: async (kind, id) => (await vault.read(kind, id)).data, write: (kind, id, d, base, t) => vault.write(kind, id, d, base, t) }
}

const cell = (id, html, y = 0) => ({ id, kind: 'text', x: 0, y, w: 200, h: 100, z: 1, title: '', showTitle: true, html, createdAt: 1, updatedAt: 1 })
const page = (id, cells) => ({ id, title: 'Page', cells, strokes: [], gridSize: 20, createdAt: 1, updatedAt: 1 })
const html = (p, id) => p?.cells.find((c) => c.id === id)?.html
const settle = async (...ds) => {
  for (let i = 0; i < 3; i++) for (const d of ds) await d.cloud.syncNow()
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
await PC.vault.ready
const P1 = await phone(1)

await test('a page written on the computer reaches the phone, and the screen is told', async () => {
  await PC.write('page', 'p1', page('p1', [cell('c1', 'from pc')]), null, null)
  await PC.write('workspace', undefined, { version: 1, tree: [{ id: 'nb', kind: 'notebook', title: 'NB', children: [{ id: 'p1', kind: 'page', title: 'Page', children: [], createdAt: 1, updatedAt: 1 }], createdAt: 1, updatedAt: 1 }], favorites: [], recent: [] }, null, null)
  await settle(PC, P1)
  assert.equal(html(await P1.read('page', 'p1'), 'c1'), 'from pc')
  assert.ok((await P1.read('workspace')).tree[0].children[0].id === 'p1')
  assert.ok(P1.events.some((e) => e.type === 'page' && e.id === 'p1'))
})

await test('an edit on the phone reaches the computer', async () => {
  const base = await P1.read('page', 'p1')
  const next = { ...base, cells: base.cells.map((c) => (c.id === 'c1' ? { ...c, html: 'edited on phone' } : c)) }
  await P1.write('page', 'p1', next, base, { cells: ['c1'] })
  await settle(P1, PC)
  assert.equal(html(await PC.read('page', 'p1'), 'c1'), 'edited on phone')
})

await test('both edit different cells at once: both survive', async () => {
  const bp = await P1.read('page', 'p1')
  await P1.write('page', 'p1', { ...bp, cells: [...bp.cells, cell('c2', 'phone cell', 200)] }, bp, { cells: ['c2'] })
  const bc = await PC.read('page', 'p1')
  await PC.write('page', 'p1', { ...bc, cells: [...bc.cells, cell('c3', 'pc cell', 400)] }, bc, { cells: ['c3'] })
  await settle(P1, PC, P1, PC)
  for (const d of [P1, PC]) {
    const p = await d.read('page', 'p1')
    assert.equal(html(p, 'c2'), 'phone cell', `${d.name} has the phone cell`)
    assert.equal(html(p, 'c3'), 'pc cell', `${d.name} has the pc cell`)
  }
})

await test('both edit the SAME cell while one is offline: nothing is lost (a conflict copy is kept)', async () => {
  P1.net.online = false
  const bp = await P1.read('page', 'p1')
  await P1.write('page', 'p1', { ...bp, cells: bp.cells.map((c) => (c.id === 'c1' ? { ...c, html: 'phone offline text' } : c)) }, bp, { cells: ['c1'] })
  await P1.cloud.syncNow()
  const bc = await PC.read('page', 'p1')
  await PC.write('page', 'p1', { ...bc, cells: bc.cells.map((c) => (c.id === 'c1' ? { ...c, html: 'pc text' } : c)) }, bc, { cells: ['c1'] })
  await PC.cloud.syncNow()
  P1.net.online = true
  await settle(P1, PC, P1, PC)
  const a = await P1.read('page', 'p1')
  const b = await PC.read('page', 'p1')
  const texts = (p) => p.cells.map((c) => c.html).sort()
  assert.deepEqual(texts(a), texts(b), 'both devices hold the same page')
  assert.ok(texts(a).includes('phone offline text'), 'phone text kept')
  assert.ok(texts(a).includes('pc text'), 'pc text kept')
})

await test('the devices converge: no endless uploads after settling', async () => {
  await settle(P1, PC)
  const before = server.seq
  await settle(P1, PC, P1, PC)
  assert.equal(server.seq, before, 'nothing more was written to the cloud')
})

await test('a page deleted on the computer leaves the phone (kept in its trash)', async () => {
  await PC.write('page', 'p9', page('p9', [cell('x', 'temp')]), null, null)
  await settle(PC, P1)
  assert.ok(await P1.read('page', 'p9'))
  await PC.vault.deletePage('p9')
  await settle(PC, P1)
  assert.equal(await P1.read('page', 'p9'), null)
  assert.ok(P1.events.some((e) => e.type === 'page-removed' && e.id === 'p9'))
})

await test('a page deleted on the phone leaves the computer', async () => {
  await P1.write('page', 'p8', page('p8', [cell('y', 'phone page')]), null, null)
  await settle(P1, PC)
  assert.ok(await PC.read('page', 'p8'))
  await P1.vault.deletePage('p8')
  await settle(P1, PC)
  assert.equal(await PC.read('page', 'p8'), null)
})

await test('a picture added on the phone uploads and reaches the computer folder', async () => {
  const bytes = crypto.randomBytes(500)
  const sha = crypto.createHash('sha1').update(bytes).digest('hex')
  const name = `${sha.slice(0, 20)}.png`
  // What the app does when a picture is added: save it on the phone, then queue it.
  await P1.assets.write(name, new Uint8Array(bytes))
  P1.cloud.addOutgoingFile(`assets/${name}`, sha)
  await settle(P1, PC)
  assert.ok(server.blobs.has(sha), 'picture uploaded')
  assert.ok(server.files.get(`assets/${name}`)?.sha === sha, 'file row in the cloud')
  assert.ok(fs.existsSync(path.join(tmp, 'vault-pc', 'assets', name)), 'picture in the computer folder')
})

await test('a picture added on the computer downloads to the phone on demand', async () => {
  const bytes = crypto.randomBytes(800)
  const sha = crypto.createHash('sha1').update(bytes).digest('hex')
  const name = `${sha.slice(0, 20)}.jpg`
  fs.writeFileSync(path.join(tmp, 'vault-pc', 'assets', name), bytes)
  await settle(PC, P1)
  assert.ok(await P1.cloud.download(`assets/${name}`), 'downloaded')
  assert.ok(P1.events.some((e) => e.type === 'asset' && e.name === name), 'the screen was told')
  assert.equal(Buffer.from(await P1.assets.read(name)).compare(bytes), 0, 'same bytes')
})

await test('a second phone joining later gets everything and converges', async () => {
  const P2 = await phone(2)
  await settle(P2, P1, PC)
  const a = await P2.read('page', 'p1')
  const b = await PC.read('page', 'p1')
  assert.deepEqual(a.cells.map((c) => c.html).sort(), b.cells.map((c) => c.html).sort())
  const before = server.seq
  await settle(P2, P1, PC)
  assert.equal(server.seq, before, 'no extra writes with three devices')
})

for (const d of [PC, P1]) d.cloud.stop?.()
PC.vault.stop()
console.log(`\n${passed} passed`)
setTimeout(() => process.exit(process.exitCode || 0), 50)
