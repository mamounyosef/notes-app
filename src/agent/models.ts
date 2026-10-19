/**
 * Ollama Cloud models the assistant can use, in the order the user chose
 * (Gemma 4 first, and the default).
 * Facts from Ollama's /api/show (context, parameters, capabilities, date
 * added) and prices from ollama.com/pricing (US dollars per million tokens),
 * checked 19 October 2026.
 */

export interface ModelInfo {
  id: string
  name: string
  /** Total parameters, as Ollama reports them. */
  params: string
  /** Active parameters per token for mixture-of-experts models; absent means dense. */
  active?: string
  context: number
  /** When the model was published on Ollama. */
  released: string
  vision: boolean
  /** gpt-oss takes a level instead of on/off. */
  thinkLevels?: boolean
  /** Per million tokens; null when Ollama does not list a price. */
  price: { input: number; cached: number | null; output: number | null } | null
  note?: string
}

export const MODELS: ModelInfo[] = [
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B',
    params: '32.7B',
    context: 262_144,
    released: '2026-04-02',
    vision: true,
    price: { input: 0.14, cached: 0.05, output: 0.4 },
    note: 'The only one here that can see images.',
  },
  {
    id: 'beam',
    name: 'Beam',
    params: '501B',
    active: '23B',
    context: 1_048_576,
    released: '2026-10-16',
    vision: false,
    price: null,
    note: 'Newest. Price not listed on Ollama yet.',
  },
  {
    id: 'nemotron-3-nano:30b',
    name: 'Nemotron 3 Nano 30B',
    params: '32B',
    active: '3.2B',
    context: 262_144,
    released: '2025-12-15',
    vision: false,
    price: { input: 0.06, cached: null, output: 0.24 },
  },
  {
    id: 'nemotron-3-super',
    name: 'Nemotron 3 Super',
    params: '120B',
    active: '12B',
    context: 262_144,
    released: '2026-03-11',
    vision: false,
    price: { input: 0.015, cached: 0.015, output: 0.6 },
  },
  {
    id: 'nemotron-3-ultra',
    name: 'Nemotron 3 Ultra',
    params: '550B',
    active: '55B',
    context: 262_144,
    released: '2026-06-04',
    vision: false,
    price: { input: 0.1, cached: 0.1, output: 3.0 },
  },
  {
    id: 'gpt-oss:120b',
    name: 'gpt-oss 120B',
    params: '117B',
    active: '5.1B',
    context: 131_072,
    released: '2025-08-05',
    vision: false,
    thinkLevels: true,
    price: { input: 0.15, cached: 0.014, output: 0.6 },
  },
  {
    id: 'gpt-oss:20b',
    name: 'gpt-oss 20B',
    params: '20.9B',
    active: '3.6B',
    context: 131_072,
    released: '2025-08-05',
    vision: false,
    thinkLevels: true,
    price: { input: 0.07, cached: 0.035, output: 0.3 },
  },
]

export const DEFAULT_MODEL = 'gemma4:31b'

export function modelInfo(id: string): ModelInfo {
  return (
    MODELS.find((m) => m.id === id) || {
      id,
      name: id,
      params: '?',
      context: 131_072,
      released: '',
      vision: false,
      price: null,
    }
  )
}

/** The think switch, as each model expects it. */
export function thinkValue(id: string, on: boolean): boolean | string {
  return modelInfo(id).thinkLevels ? (on ? 'high' : 'low') : on
}

/** Dollar cost of one request from Ollama's token counts. */
export function costOf(id: string, u: { prompt: number; output: number; cached?: number }): number | null {
  const p = modelInfo(id).price
  if (!p) return null
  const cached = Math.min(u.cached || 0, u.prompt)
  const fresh = u.prompt - cached
  return (fresh * p.input + cached * (p.cached ?? p.input) + u.output * (p.output ?? 0)) / 1e6
}

export const fmtCtx = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 104857.6) / 10}M` : `${Math.round(n / 1024)}K`)

export function fmtDate(iso: string) {
  if (!iso) return ''
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function fmtMoney(n: number) {
  if (n === 0) return '$0'
  if (n < 0.0001) return '<$0.0001'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(n < 1 ? 3 : 2)}`
}

/** "Dense, 32.7B" or "MoE, 501B total, 23B active". */
export function paramsLabel(m: Pick<ModelInfo, 'params' | 'active'>) {
  return m.active ? `MoE, ${m.params} total, ${m.active} active` : `Dense, ${m.params}`
}
