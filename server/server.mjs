/**
 * Optional browser mode: serves the built app and the same notes folder over
 * HTTP, so a browser tab shows exactly what the desktop window shows.
 *
 *   node server/server.mjs [--port 5299] [--vault "C:\\path\\to\\MyNotes"]
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { VaultSync } from '../shared/vault-sync.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const PORT = Number(argOf('port', 5299))
const VAULT = path.resolve(argOf('vault', readConfiguredVault() || path.join(os.homedir(), 'Documents', 'MyNotes')))

function readConfiguredVault() {
  // Reuse the desktop app's chosen folder when it has one.
  try {
    const cfg = path.join(process.env.APPDATA || '', 'notesapp', 'config.json')
    return JSON.parse(fs.readFileSync(cfg, 'utf8')).vault
  } catch {
    return null
  }
}

for (const d of ['pages', 'assets']) fs.mkdirSync(path.join(VAULT, d), { recursive: true })

// Browser tabs listening for changes (server sent events).
const clients = new Set()
const sync = new VaultSync({
  stateDir: path.join(process.env.APPDATA || os.homedir(), 'notesapp-server', 'sync'),
  emit: (ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`
    for (const c of clients) c.write(line)
  },
  log: (...a) => console.log(...a),
})
sync.setVault(VAULT)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '')
const pageFile = (id) => path.join(VAULT, 'pages', `${safeId(id)}.json`)

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, text, 'utf8')
  await fsp.rename(tmp, file)
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

function body(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || 'null'))
      } catch {
        resolve(null)
      }
    })
  })
}

function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
}

function lineSnippet(text, i, len) {
  const start = text.lastIndexOf('\n', i) + 1
  let end = text.indexOf('\n', i + len)
  if (end < 0) end = text.length
  return text.slice(Math.max(start, i - 40), Math.min(end, i + len + 60)).trim()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = decodeURIComponent(url.pathname)

  try {
    if (p === '/api/vault') return send(res, 200, JSON.stringify({ path: VAULT }))

    // Reads and writes go through the same sync service as the desktop app.
    if (p === '/api/workspace' || p === '/api/settings') {
      const kind = p.slice('/api/'.length)
      if (req.method === 'GET') return send(res, 200, JSON.stringify(await sync.read(kind)))
      const b = (await body(req)) || {}
      return send(res, 200, JSON.stringify(await sync.write(kind, undefined, b.data, b.base ?? null)))
    }

    if (p.startsWith('/api/page/')) {
      const id = p.slice('/api/page/'.length)
      if (req.method === 'GET') return send(res, 200, JSON.stringify(await sync.read('page', id)))
      if (req.method === 'DELETE') {
        await sync.deletePage(id)
        return send(res, 200, '{"ok":true}')
      }
      const b = (await body(req)) || {}
      if (!b.data) return send(res, 400, '{"error":"no page"}')
      return send(res, 200, JSON.stringify(await sync.write('page', id, b.data, b.base ?? null, b.touched ?? null)))
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }

    if (p === '/api/sync/conflicts') return send(res, 200, JSON.stringify(await sync.listConflicts()))
    if (p === '/api/sync/status') return send(res, 200, JSON.stringify(sync.status()))
    if (p === '/api/sync/scan') {
      await sync.scan()
      return send(res, 200, '{"ok":true}')
    }

    if (p === '/api/asset' && req.method === 'POST') {
      const { dataUrl } = (await body(req)) || {}
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '')
      if (!m) return send(res, 400, '{"error":"bad data url"}')
      const buf = Buffer.from(m[2], 'base64')
      const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5)
      const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`
      const file = path.join(VAULT, 'assets', name)
      if (!fs.existsSync(file)) await fsp.writeFile(file, buf)
      return send(res, 200, JSON.stringify({ url: `/media/${name}` }))
    }

    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase()
      if (!q) return send(res, 200, '[]')
      const dir = path.join(VAULT, 'pages')
      const names = await fsp.readdir(dir).catch(() => [])
      const out = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const raw = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => '')
        if (!raw.toLowerCase().includes(q)) continue
        let page
        try {
          page = JSON.parse(raw)
        } catch {
          continue
        }
        const hits = []
        for (const cell of page.cells || []) {
          const text = stripHtml(`${cell.title || ''}<br>${cell.html || ''}`)
          const i = text.toLowerCase().indexOf(q)
          if (i >= 0) {
            hits.push({
              cellId: cell.id,
              cellTitle: cell.title || '',
              snippet: lineSnippet(text, i, q.length),
            })
          }
          if (hits.length >= 4) break
        }
        if (hits.length || String(page.title || '').toLowerCase().includes(q)) {
          out.push({ pageId: page.id, title: page.title || 'Untitled', hits })
        }
      }
      return send(res, 200, JSON.stringify(out))
    }

    // Images saved by either client. Kept off /assets, which belongs to the
    // built app's own bundle.
    if (p.startsWith('/media/')) {
      const file = path.join(VAULT, 'assets', path.basename(p))
      const data = await fsp.readFile(file).catch(() => null)
      if (!data) return send(res, 404, 'not found', 'text/plain')
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
      return res.end(data)
    }

    // The built app.
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '')
    const file = path.join(DIST, rel)
    if (!file.startsWith(DIST)) return send(res, 403, 'no', 'text/plain')
    const data = await fsp.readFile(file).catch(() => null)
    if (data) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
      return res.end(data)
    }
    const index = await fsp.readFile(path.join(DIST, 'index.html')).catch(() => null)
    if (!index) return send(res, 404, 'Run "npm run build" first.', 'text/plain')
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    res.end(index)
  } catch (err) {
    send(res, 500, JSON.stringify({ error: String(err) }))
  }
})

server.listen(PORT, () => {
  console.log(`Notes is on http://localhost:${PORT}`)
  console.log(`Notes folder: ${VAULT}`)
})
