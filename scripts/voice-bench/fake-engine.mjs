// A stand-in for speech-server.py with no GPU, no models and no microphone:
// the same WebSocket protocol, but what is "heard" is typed in by the bench
// ({ type: 'fake_say', text }) and what is "said" comes back as a soft tone
// as long as the sentence would take to say. Everything said is logged at
// GET /log, so a test can check exactly what the voice spoke.
//   node scripts/voice-bench/fake-engine.mjs --port 5189
import http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 5189
const said = []
const heard = []
const VOICES = [
  { id: 'af_heart', name: 'Heart', accent: 'American', gender: 'female', note: 'Warm and natural. The best Kokoro voice.' },
  { id: 'am_michael', name: 'Michael', accent: 'American', gender: 'male', note: 'Deep and steady.' },
  { id: 'bf_emma', name: 'Emma', accent: 'British', gender: 'female', note: 'Polished and warm.' },
  { id: 'bm_george', name: 'George', accent: 'British', gender: 'male', note: 'Classic and composed.' },
]

function tone(seconds) {
  const n = Math.round(24000 * seconds)
  const pcm = new Int16Array(n)
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((i / 24000) * 2 * Math.PI * 220) * 6000 * Math.min(1, i / 800, (n - i) / 800))
  return pcm
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
  if (req.url === '/health') return json({ ok: true, ready: true, loading: false, device: 'cuda', error: null, sessions: wss.clients.size })
  if (req.url === '/voices') return json({ voices: VOICES, default: 'af_heart' })
  if (req.url === '/log') return json({ said, heard })
  if (req.url === '/reset') { said.length = 0; heard.length = 0; return json({ ok: true }) }
  if (req.url === '/warm') return json({ ok: true, ready: true })
  res.statusCode = 404
  res.end()
})
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws) => {
  let gen = 0
  let utt = 0
  let config = {}
  const queue = []
  let busy = false
  const pump = async () => {
    if (busy) return
    busy = true
    while (queue.length) {
      const job = queue.shift()
      if (job.gen !== gen) continue
      said.push({ text: job.text, voice: job.voice, at: Date.now() })
      // About 15 characters a second, like a real voice; half-second chunks.
      const pcm = tone(Math.max(0.4, job.text.length / 15))
      await new Promise((r) => setTimeout(r, 60))
      for (let i = 0; i < pcm.length && job.gen === gen; i += 12000) {
        const part = pcm.subarray(i, i + 12000)
        const buf = Buffer.alloc(4 + part.byteLength)
        buf.writeUInt32LE(job.id >>> 0, 0)
        Buffer.from(part.buffer, part.byteOffset, part.byteLength).copy(buf, 4)
        ws.send(buf)
        await new Promise((r) => setTimeout(r, 120))
      }
      if (job.gen === gen) ws.send(JSON.stringify({ type: 'tts_done', id: job.id }))
    }
    busy = false
  }
  ws.on('message', async (data, isBinary) => {
    if (isBinary) return
    const m = JSON.parse(String(data))
    if (m.type === 'start') {
      config = m
      ws.send(JSON.stringify({ type: 'status', stage: 'loading' }))
      setTimeout(() => ws.send(JSON.stringify({ type: 'status', stage: 'ready', device: 'cuda' })), 300)
    } else if (m.type === 'config') config = { ...config, ...m }
    else if (m.type === 'speak') {
      queue.push({ gen, id: m.id, text: m.text, voice: m.voice })
      pump()
    } else if (m.type === 'cancel') {
      gen++
      queue.length = 0
    } else if (m.type === 'fake_say') {
      // The fake microphone: speech starts, partials grow word by word, then the final.
      const u = ++utt
      heard.push({ text: m.text, prompt: config.prompt, hints: config.hints })
      ws.send(JSON.stringify({ type: 'speech_start', utt: u }))
      const words = String(m.text).split(' ')
      for (let i = 2; i < words.length; i += 2) {
        await new Promise((r) => setTimeout(r, 200))
        ws.send(JSON.stringify({ type: 'partial', utt: u, text: words.slice(0, i).join(' ') }))
      }
      await new Promise((r) => setTimeout(r, 500))
      ws.send(JSON.stringify({ type: 'final', utt: u, text: m.text, seconds: 1.5 }))
    }
  })
})
server.listen(port, '127.0.0.1', () => console.log(`fake speech engine on 127.0.0.1:${port}`))
