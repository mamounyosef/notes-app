/**
 * End to end tests for shared/chat-store.mjs: two computers, each with its
 * own chat folder, syncing through an in-memory copy of the agent_chats table
 * (same rules as supabase/schema.sql: rev compare and swap, change_seq, and
 * jsonb handing rows back with their keys reordered).
 * Run: node scripts/test-chat-sync.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatStore } from '../shared/chat-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-chat-test-'))

/* ---------------- fake cloud ---------------- */

const server = { seq: 0, rows: new Map(), pushes: 0, blobs: new Map(), hidden: new Set() }
const clone = (v) => (v == null ? v : structuredClone(v))
// What Postgres jsonb does to an object: keys sorted by length, then bytes.
const jsonb = (v) =>
  Array.isArray(v)
    ? v.map(jsonb)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
            .map((k) => [k, jsonb(v[k])]),
        )
      : v

function remoteFor() {
  const net = { online: true, failPush: new Set() }
  const guard = async (fn) => {
    if (!net.online) throw new Error('fetch failed')
    return fn()
  }
  // Rows in `hidden` committed late: a cursor read does not see them.
  const visible = () => [...server.rows.values()].filter((r) => !server.hidden.has(r.id))
  const remote = {
    session: () => guard(() => ({ email: 'me@test', userId: 'u1' })),
    chatsSince: (seq) => guard(() => visible().filter((r) => r.change_seq > seq).sort((a, b) => a.change_seq - b.change_seq).map(clone)),
    chatRevs: () => guard(() => [...server.rows.values()].map((r) => ({ id: r.id, rev: r.rev, change_seq: r.change_seq }))),
    getChat: (id) => guard(() => clone(server.rows.get(id) || null)),
    pushChat: ({ id, data, expectedRev, deleted, device }) =>
      guard(() => {
        if (net.failPush.has(id)) throw new Error('payload too large')
        // Same text as the database's loop limit in supabase/schema.sql.
        if (net.refuse?.has(id)) throw new Error('Sync limit (item): uploaded more than 1200 times in the last hour, so the cloud refuses it for now')
        const cur = server.rows.get(id)
        if (expectedRev === 0 ? cur : !cur || cur.rev !== expectedRev) return { ok: false }
        server.pushes++
        const row = { id, data: jsonb(clone(data)), deleted, device, rev: (cur?.rev || 0) + 1, change_seq: ++server.seq }
        server.rows.set(id, row)
        return { ok: true, rev: row.rev, change_seq: row.change_seq }
      }),
    hasBlob: (sha) => guard(() => server.blobs.has(sha)),
    uploadBlob: (sha, buf) => guard(() => void server.blobs.set(sha, Buffer.from(buf))),
    downloadBlob: (sha) => guard(() => Buffer.from(server.blobs.get(sha))),
  }
  return { remote, net }
}

/* ---------------- two computers ---------------- */

async function computer(name) {
  const store = new ChatStore({ dir: path.join(root, name), device: name })
  const { remote, net } = remoteFor()
  await store.setRemote(remote)
  return { name, store, net }
}

const msg = (id, role, content, at) => ({ id, role, content, at })
const chat = (id, title, messages) => ({ id, title, createdAt: 1, updatedAt: 1, messages })
const ids = async (c, id) => ((await c.store.read(id))?.messages || []).map((m) => m.id)
const titles = async (c) => (await c.store.list()).map((x) => x.title).sort()
const sync = async (...cs) => {
  for (const c of cs) await c.store.syncNow()
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

const LT = await computer('laptop')
const PC = await computer('pc')

await test('a chat made on the laptop shows on the PC', async () => {
  await LT.store.put(chat('c1', 'From laptop', [msg('m1', 'user', 'hello', 1)]))
  await sync(LT, PC)
  assert.deepEqual(await titles(PC), ['From laptop'])
})

await test('reordered keys from the cloud do not make the computers push forever', async () => {
  // Settle, then count: more rounds must add no pushes.
  await sync(LT, PC, LT, PC)
  const before = server.pushes
  await sync(LT, PC, LT, PC, LT, PC)
  assert.equal(server.pushes, before)
})

await test('both computers add to the same chat, nothing is lost', async () => {
  const lt = await LT.store.read('c1')
  const pc = await PC.store.read('c1')
  await LT.store.put({ ...lt, messages: [...lt.messages, msg('m2', 'assistant', 'from laptop', 2)] })
  await PC.store.put({ ...pc, messages: [...pc.messages, msg('m3', 'user', 'from pc', 3)] })
  await sync(LT, PC, LT)
  for (const c of [LT, PC]) assert.deepEqual(await ids(c, 'c1'), ['m1', 'm2', 'm3'], c.name)
})

await test('a chat the cursor skipped (committed out of order) still arrives', async () => {
  await LT.store.put(chat('late', 'Committed late', [msg('x', 'user', 'hi', 5)]))
  server.hidden.add('late')
  await sync(LT)
  // Some other chat moves the PC cursor past the late one.
  await LT.store.put(chat('after', 'After it', [msg('y', 'user', 'hi', 6)]))
  await sync(LT, PC)
  server.hidden.delete('late')
  assert.ok(!(await titles(PC)).includes('Committed late'), 'cursor alone missed it')
  PC.store.lastFullAt = 0 // the periodic full check is due
  await sync(PC)
  assert.ok((await titles(PC)).includes('Committed late'))
})

await test('one chat that fails to upload does not hold back the others', async () => {
  LT.net.failPush.add('broken')
  await LT.store.put(chat('broken', 'Broken', [msg('b', 'user', 'big', 7)]))
  await LT.store.put(chat('fine', 'Fine', [msg('f', 'user', 'ok', 8)]))
  await sync(LT, PC)
  assert.equal(LT.store.status().phase, 'error')
  assert.ok((await titles(PC)).includes('Fine'))
  LT.net.failPush.delete('broken')
  await sync(LT, PC)
  assert.equal(LT.store.status().phase, 'idle')
  assert.ok((await titles(PC)).includes('Broken'))
})

await test('chats made offline go up once the network is back', async () => {
  LT.net.online = false
  await LT.store.put(chat('off', 'Made offline', [msg('o', 'user', 'plane', 9)]))
  await sync(LT)
  assert.equal(LT.store.status().phase, 'error')
  LT.net.online = true
  await sync(LT, PC)
  assert.ok((await titles(PC)).includes('Made offline'))
})

await test('local chats still go up when pulling fails', async () => {
  const pull = LT.store.pull
  LT.store.pull = async () => {
    throw new Error('pull broke')
  }
  try {
    await LT.store.put(chat('pushed', 'Pushed anyway', [msg('p', 'user', 'x', 10)]))
    await sync(LT)
  } finally {
    LT.store.pull = pull
  }
  await sync(PC)
  assert.ok((await titles(PC)).includes('Pushed anyway'))
})

await test('a chat deleted on one computer goes away on the other', async () => {
  await PC.store.remove('fine')
  await sync(PC, LT)
  assert.ok(!(await titles(LT)).includes('Fine'))
})

await test('attachments made on one computer open on the other', async () => {
  const sha = await LT.store.saveBlob(Buffer.from('image bytes'))
  await LT.store.put(chat('att', 'With image', [{ ...msg('a', 'user', 'see', 11), attachments: [{ sha, name: 'x.png', mime: 'image/png' }] }]))
  await sync(LT, PC)
  assert.equal(String(await PC.store.readBlob(sha)), 'image bytes')
})

await test('a chat sync loop is paused, shown, and the chat stays saved here', async () => {
  // Force the loop seen for real: the PC keeps thinking its unchanged chat is new.
  const before = server.pushes
  for (let i = 0; i < 40; i++) {
    PC.store.state.pushed.c1 = 'stale'
    await sync(PC)
  }
  assert.ok(server.pushes - before <= 20, `kept pushing: ${server.pushes - before}`)
  assert.equal(PC.store.status().phase, 'error')
  assert.match(PC.store.status().error, /sync loop/)
  assert.deepEqual(await ids(PC, 'c1'), ['m1', 'm2', 'm3'], 'nothing lost')
})

await test('a chat the database refuses waits here, and the other chats still sync', async () => {
  LT.net.refuse = new Set(['r1'])
  await LT.store.put(chat('r1', 'Refused for now', [msg('a', 'user', 'wait', 7)]))
  await LT.store.put(chat('g1', 'Goes up', [msg('b', 'user', 'go', 8)]))
  await sync(LT, LT, LT, PC)
  assert.ok((await titles(PC)).includes('Goes up'))
  assert.ok(!(await titles(PC)).includes('Refused for now'))
  assert.equal(LT.store.status().phase, 'error')
  assert.match(LT.store.status().error, /cloud refused/)
  assert.deepEqual(await ids(LT, 'r1'), ['a'], 'kept here')
  LT.net.refuse = null
})

for (const c of [LT, PC]) c.store.stop()
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed`)
process.exit(process.exitCode || 0)
