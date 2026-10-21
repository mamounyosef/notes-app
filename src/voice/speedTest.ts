/**
 * Voice mode: how long each model takes to START TALKING, measured on this
 * computer on a real spoken request ("Hey, um, what's on this page?") with
 * the voice prompt, the real tools and the real open page. Read only: lookup
 * tools really run, nothing that changes notes is ever called.
 *
 * One request at a time: parallel requests queue behind each other on the
 * cloud and make every model look slow (learned in the planner). Each model
 * is timed twice per mode and the faster try counts (a cold model's first
 * call is often slow for reasons that are not the model's).
 *
 * Free OpenRouter models are skipped unless asked for: they allow 50 requests
 * a day, and a test would spend four of them per model. They are measured
 * anyway every time they answer in voice mode (see recordSpeed).
 */
import { nanoid } from 'nanoid'
import { create } from 'zustand'
import { agentApi } from '../agent/api'
import { buildContext } from '../agent/context'
import { MODELS, modelInfo, thinkValue } from '../agent/models'
import { SYSTEM_PROMPT, voicePrompt } from '../agent/prompt'
import { TOOL_DEFS, TurnRecorder, runTool } from '../agent/tools'
import { recordSpeed } from './voicePrefs'

const QUESTION = "Hey, um, what's on this page?"
const SAFE_TOOLS = new Set(['get_context', 'list_tree', 'read_page', 'read_cell', 'search_notes', 'recent_notes', 'get_settings'])
const TIMEOUT_MS = 60_000

interface TestState {
  running: boolean
  /** "Gemma 4 31B, quick (3 of 14)". */
  progress: string
  error: string | null
}

export const useSpeedTest = create<TestState>(() => ({ running: false, progress: '', error: null }))

let cancel = false

export function cancelSpeedTest() {
  cancel = true
}

/** First word time of one try, or null with the reason. */
async function timeOne(model: string, think: boolean): Promise<{ ms: number | null; error?: string }> {
  const ctx = buildContext({ ignoreSelection: true })
  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT + voicePrompt() },
    { role: 'user', content: `<app_context>\n${ctx.full}\n</app_context>\n\n${QUESTION}` },
  ]
  const t0 = Date.now()
  let first: number | null = null
  for (let step = 0; step < 3 && first === null; step++) {
    const reqId = nanoid()
    const calls: { name: string; arguments: any }[] = []
    let content = ''
    const off = agentApi.onChunk((id, chunk) => {
      if (id !== reqId) return
      const m = chunk.message || {}
      if (m.content) {
        content += m.content
        if (first === null && /\w/.test(content)) {
          first = Date.now() - t0
          agentApi.abort(reqId) // the rest of the answer is not needed
        }
      }
      for (const tc of m.tool_calls || []) calls.push({ name: tc.function?.name, arguments: tc.function?.arguments })
    })
    const timer = setTimeout(() => agentApi.abort(reqId), Math.max(1000, TIMEOUT_MS - (Date.now() - t0)))
    const res = await agentApi.chat(reqId, { model, messages, tools: TOOL_DEFS, think: thinkValue(model, think), options: { temperature: 0.4 } })
    clearTimeout(timer)
    off()
    if (first !== null) break
    if (!res.ok && !res.aborted) return { ms: null, error: res.error === 'NO_KEY' ? 'No API key for this service.' : (res.error || 'No answer').slice(0, 160) }
    if (res.aborted) return { ms: null, error: 'Took longer than a minute.' }
    if (!calls.length) return { ms: null, error: 'Answered with nothing.' }
    messages.push({ role: 'assistant', content, tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments || {} } })) })
    for (const c of calls) {
      const args = typeof c.arguments === 'string' ? JSON.parse(c.arguments || '{}') : c.arguments || {}
      const out = SAFE_TOOLS.has(c.name)
        ? await runTool(c.name, args, { rec: new TurnRecorder(), attachments: new Map(), model, ask: async () => '(No answer in a test.)' })
        : { content: 'Not available in this test.' }
      messages.push({ role: 'tool', tool_name: c.name, content: out.content })
    }
  }
  return first === null ? { ms: null, error: 'Did not answer in words.' } : { ms: first }
}

/** Times the models (Ollama ones, plus the free OpenRouter ones if asked), both with and without thinking. */
export async function runSpeedTest(opts: { includeFree?: boolean; only?: string[] } = {}) {
  if (useSpeedTest.getState().running) return
  cancel = false
  const models = MODELS.filter((m) => (opts.only ? opts.only.includes(m.id) : m.provider === 'ollama' || opts.includeFree))
  const jobs = models.flatMap((m) => [{ id: m.id, think: false }, { id: m.id, think: true }])
  useSpeedTest.setState({ running: true, error: null, progress: '' })
  try {
    for (let i = 0; i < jobs.length && !cancel; i++) {
      const { id, think } = jobs[i]
      useSpeedTest.setState({ progress: `${modelInfo(id).name}, ${think ? 'thinking' : 'quick'} (${i + 1} of ${jobs.length})` })
      const a = await timeOne(id, think)
      const b = a.ms === null || cancel ? a : await timeOne(id, think)
      const best = [a, b].filter((r) => r.ms !== null).sort((x, y) => x.ms! - y.ms!)[0]
      recordSpeed(id, think, best ? best.ms : null, { tested: true, error: best ? undefined : a.error })
    }
  } catch (e) {
    useSpeedTest.setState({ error: e instanceof Error ? e.message : String(e) })
  } finally {
    useSpeedTest.setState({ running: false, progress: '' })
  }
}
