// Serves the built app (dist/) with the bench's desktop bridge put in first,
// next to the fake speech engine. Build first (npx vite build), then:
//   node scripts/voice-bench/serve.mjs        app on http://127.0.0.1:5198
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, '../../dist')
const PORT = 5198
const ENGINE = 5189
const engine = spawn(process.execPath, [path.join(HERE, 'fake-engine.mjs'), '--port', String(ENGINE)], { stdio: 'inherit' })
process.on('exit', () => engine.kill())
process.on('SIGINT', () => process.exit())
process.on('SIGTERM', () => process.exit())

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' }
http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0])
    if (url === '/bench-shim.js') {
      res.setHeader('Content-Type', 'text/javascript')
      return res.end(`window.__ENGINE_PORT = ${ENGINE};\n${fs.readFileSync(path.join(HERE, 'shim.js'), 'utf8')}`)
    }
    const file = path.join(DIST, url === '/' ? 'index.html' : url)
    if (!file.startsWith(DIST) || !fs.existsSync(file)) {
      res.statusCode = 404
      return res.end()
    }
    let body = fs.readFileSync(file)
    if (file.endsWith('index.html')) body = Buffer.from(String(body).replace('<head>', '<head><script src="/bench-shim.js"></script>'))
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream')
    res.end(body)
  })
  .listen(PORT, '127.0.0.1', () => console.log(`voice bench on http://127.0.0.1:${PORT}`))
