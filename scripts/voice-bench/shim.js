// The desktop bridge (window.notes) for the voice bench, in a plain browser:
// a scripted model instead of Ollama, chats in memory, and voice mode pointed
// at the fake speech engine. Notes themselves use the browser backend
// (localStorage), so nothing real is ever touched.
;(() => {
  const ENGINE = window.__ENGINE_PORT || 5189
  const listeners = new Set()
  const running = new Map()
  const chats = new Map()
  window.__requests = []

  // The fake microphone: window.__fakeMic("what is on this page")
  const sockets = []
  const RealWS = window.WebSocket
  window.WebSocket = function (url, p) {
    const ws = new RealWS(url, p)
    if (String(url).includes(':' + ENGINE)) sockets.push(ws)
    return ws
  }
  window.WebSocket.prototype = RealWS.prototype
  Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 })
  window.__fakeMic = (text) => {
    const ws = sockets.filter((s) => s.readyState === 1).pop()
    if (!ws) throw new Error('voice mode is not connected')
    ws.send(JSON.stringify({ type: 'fake_say', text }))
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // What the user said: the last paragraph (context and selection come first).
  const textOf = (m) => String(m?.content || '').trim().split(/\n\n/).pop().toLowerCase()

  /** What the scripted model answers, from the conversation so far. */
  function script(messages) {
    const last = messages[messages.length - 1]
    if (last.role === 'tool') {
      if (last.tool_name === 'create_cells') return { text: 'Done, I added a cell saying the exam is on Thursday.' }
      if (last.tool_name === 'ask_user') return { text: `Okay, I will use ${String(last.content).replace(/^.*?:\s*/, '').slice(0, 60)}.` }
      return { text: 'Done.' }
    }
    const t = textOf(last)
    if (t.includes('write down')) return { text: 'On it. ', tools: [{ name: 'create_cells', arguments: { cells: [{ title: 'Exam', content: 'The exam is on **Thursday**.' }] } }] }
    if (t.includes('which')) return { tools: [{ name: 'ask_user', arguments: { question: 'Which cell should I use?', options: ['The summary cell (Recommended)', 'The definitions cell'] } }] }
    if (t.includes('formula')) return { text: 'The formula is $\\frac{x^2}{2}$, so it grows quickly. Want me to add it?' }
    if (t.includes('week') || t.includes('everything')) return {
      slow: true,
      text: 'Here is the whole picture. Monday is about gradient descent and the learning rate. Tuesday covers backpropagation, with the chain rule worked out step by step. Wednesday is regularization, mostly dropout and weight decay. Thursday is the exam. Friday is free for revision, and the weekend too.',
    }
    return { text: `Sure. You said ${t.replace(/^\(you were interrupted\.\)\s*/, '')}.` }
  }

  async function chat(reqId, body) {
    const ctrl = { aborted: false }
    running.set(reqId, ctrl)
    window.__requests.push({ model: body.model, think: body.think, voice: /Voice mode \(this conversation is SPOKEN\)/.test(body.messages[0].content), last: body.messages[body.messages.length - 1] })
    const send = (chunk) => listeners.forEach((cb) => cb(reqId, chunk))
    try {
      await sleep(350) // time to first token
      const s = script(body.messages)
      const text = s.text || ''
      for (let i = 0; i < text.length; i += 4) {
        if (ctrl.aborted) return { ok: false, aborted: true }
        send({ message: { content: text.slice(i, i + 4) } })
        await sleep(s.slow ? 110 : 18)
      }
      if (ctrl.aborted) return { ok: false, aborted: true }
      if (s.tools) send({ message: { tool_calls: s.tools.map((t) => ({ function: { name: t.name, arguments: t.arguments } })) } })
      send({ done: true, prompt_eval_count: 1200, eval_count: 40, total_duration: 9e8 })
      return { ok: true }
    } finally {
      running.delete(reqId)
    }
  }

  const engine = (p, init) => fetch(`http://127.0.0.1:${ENGINE}${p}`, init).then((r) => r.json())

  window.notes = {
    agent: {
      keyStatus: async () => ({ hasKey: true, masked: 'test...key' }),
      setKey: async () => ({ ok: true }),
      openrouterLimits: async () => ({ ok: false }),
      chat,
      abort: (reqId) => { const c = running.get(reqId); if (c) c.aborted = true },
      dictate: async () => false,
      web: async () => ({ ok: false, error: 'No web in the bench.' }),
      complete: async () => ({ ok: true, content: 'Voice bench chat' }),
      renderWidget: async () => ({ ok: false, error: 'No drawings in the bench.' }),
      onChunk: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    },
    chats: {
      list: async () => [...chats.values()].map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.filter((m) => m.role === 'user').length, preview: '', ...(c.voice ? { voice: true } : {}) })),
      get: async (id) => (chats.has(id) ? structuredClone(chats.get(id)) : null),
      put: async (c) => { chats.set(c.id, structuredClone(c)); return c },
      remove: async (id) => { chats.delete(id) },
      status: async () => ({ phase: 'off', error: null, lastSync: 0 }),
      syncNow: async () => {},
      saveBlob: async () => 'none',
      getBlob: async () => null,
      blobToAsset: async () => null,
      onEvent: () => () => {},
      onStatus: () => () => {},
    },
    voice: {
      status: async () => ({ available: true, engineDir: '(the voice bench)', running: true, ready: true, loading: false, device: 'cuda', error: null, port: ENGINE }),
      ensure: async () => ({ ok: true, port: ENGINE }),
      voices: async () => ({ ok: true, ...(await engine('/voices')) }),
      warm: async () => ({ ok: true }),
      preview: async () => ({ ok: false, error: 'No previews in the bench.' }),
      chooseEngine: async () => ({ ok: false, canceled: true }),
    },
  }
})()
