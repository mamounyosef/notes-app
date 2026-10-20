/**
 * Models the assistant can use, strongest first (by total, then active,
 * parameters). Two services run them:
 *  - Ollama Cloud: facts from Ollama's /api/show and prices from
 *    ollama.com/pricing (US dollars per million tokens), checked 19 October 2026.
 *  - OpenRouter (free models): context and date added from openrouter.ai's
 *    model list, architecture from each model's Hugging Face config.json or
 *    model card, checked 20 October 2026. Free models allow 50 requests a day
 *    on a key without credits.
 */

export type Provider = 'ollama' | 'openrouter'

export interface ModelInfo {
  id: string
  name: string
  provider: Provider
  /** Total parameters. */
  params: string
  /** Active parameters per token for mixture-of-experts models; absent means dense. */
  active?: string
  context: number
  /** When the model was published on the service. */
  released: string
  /** Architecture facts from the model's config or technical report. */
  arch?: string[]
  vision: boolean
  /** gpt-oss takes a level instead of on/off. */
  thinkLevels?: boolean
  /** Per million tokens; null when the service does not list a price. Zero for free models. */
  price: { input: number; cached: number | null; output: number | null } | null
  note?: string
}

const FREE = { input: 0, cached: 0, output: 0 }

const GEMMA_31B_ARCH = ['60 layers', 'dim 5376', 'GQA: 32 query heads, 16 KV heads', 'sliding window 1024, 10 full-attention layers']
const ULTRA_ARCH = ['108 layers (48 Mamba-2, 48 MoE, 12 attention)', 'dim 8192', '512 experts + 1 shared, 22 per token', 'LatentMoE (latent 2048)', 'GQA: 64 query heads, 2 KV heads', 'multi-token prediction']
const SUPER_ARCH = ['88 layers (40 Mamba-2, 40 MoE, 8 attention)', 'dim 4096', '512 experts + 1 shared, 22 per token', 'LatentMoE (latent 1024)', 'GQA: 32 query heads, 2 KV heads', 'multi-token prediction']
const NANO_ARCH = ['52 layers (23 Mamba-2, 23 MoE, 6 attention)', 'dim 2688', '128 experts + 1 shared, 6 per token', 'GQA: 32 query heads, 2 KV heads']

export const MODELS: ModelInfo[] = [
  {
    id: 'nemotron-3-ultra',
    name: 'Nemotron 3 Ultra',
    provider: 'ollama',
    params: '550B',
    active: '55B',
    context: 262_144,
    released: '2026-06-04',
    arch: ULTRA_ARCH,
    vision: false,
    price: { input: 0.1, cached: 0.1, output: 3.0 },
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    name: 'Nemotron 3 Ultra',
    provider: 'openrouter',
    params: '550B',
    active: '55B',
    context: 1_000_000,
    released: '2026-06-04',
    arch: ULTRA_ARCH,
    vision: false,
    price: FREE,
    note: '1M context here, 256K on Ollama.',
  },
  {
    id: 'beam',
    name: 'Beam',
    provider: 'ollama',
    params: '501B',
    active: '23B',
    context: 1_048_576,
    released: '2026-10-16',
    arch: ['52 layers (3 dense, 49 MoE)', 'dim 5120', '256 experts, 8 per token', 'GQA: 48 query heads, 8 KV heads', 'sliding window 512, 9 global layers'],
    vision: false,
    price: null,
    note: 'Price not listed on Ollama yet.',
  },
  {
    id: 'minimax/minimax-m3.1-flash:free',
    name: 'MiniMax M3.1 Flash',
    provider: 'openrouter',
    params: '~428B',
    active: '~23B',
    context: 1_000_000,
    released: '2026-10-19',
    arch: ['sparse attention', 'built-in vision encoder', 'always reasons'],
    vision: true,
    price: FREE,
    note: 'Newest. Size reported, not confirmed by MiniMax. Also sees video.',
  },
  {
    id: 'dots-studio/dots-3-note-preview:free',
    name: 'Dots3-Note Preview',
    provider: 'openrouter',
    params: '280B',
    active: '16B',
    context: 512_000,
    released: '2026-08-14',
    arch: ['46 layers (1 dense, 45 MoE)', 'dim 5120', '256 experts + 1 shared, 8 per token', '13 sparse (DSA) + 33 sliding-window attention layers', 'multi-token prediction', 'MoE vision encoder (7B, 1.2B active)'],
    vision: true,
    price: FREE,
    note: 'Preview.',
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl:free',
    name: 'Nemotron 3.5 Super VL',
    provider: 'openrouter',
    params: '120B',
    active: '12B',
    context: 1_000_000,
    released: '2026-10-15',
    arch: ['Nemotron-H hybrid (Mamba-2, MoE, attention)', 'RADIO vision encoder', 'multi-token prediction'],
    vision: true,
    price: FREE,
    note: 'Reads documents, screenshots and video.',
  },
  {
    id: 'nemotron-3-super',
    name: 'Nemotron 3 Super',
    provider: 'ollama',
    params: '120B',
    active: '12B',
    context: 262_144,
    released: '2026-03-11',
    arch: SUPER_ARCH,
    vision: false,
    price: { input: 0.015, cached: 0.015, output: 0.6 },
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    name: 'Nemotron 3 Super',
    provider: 'openrouter',
    params: '120B',
    active: '12B',
    context: 262_144,
    released: '2026-03-11',
    arch: SUPER_ARCH,
    vision: false,
    price: FREE,
  },
  {
    id: 'poolside/laguna-s-2.1:free',
    name: 'Laguna S 2.1',
    provider: 'openrouter',
    params: '118B',
    active: '8B',
    context: 262_144,
    released: '2026-07-21',
    arch: ['48 layers (36 sliding, 12 full)', 'dim 3072', '256 experts, 10 per token', 'GQA: 48 to 72 query heads, 8 KV heads', 'sliding window 512'],
    vision: false,
    price: FREE,
    note: 'Built for coding agents.',
  },
  {
    id: 'gpt-oss:120b',
    name: 'gpt-oss 120B',
    provider: 'ollama',
    params: '117B',
    active: '5.1B',
    context: 131_072,
    released: '2025-08-05',
    arch: ['36 layers (18 sliding, 18 full)', 'dim 2880', '128 experts, 4 per token', 'GQA: 64 query heads, 8 KV heads', 'sliding window 128'],
    vision: false,
    thinkLevels: true,
    price: { input: 0.15, cached: 0.014, output: 0.6 },
  },
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B',
    provider: 'ollama',
    params: '32.7B',
    context: 262_144,
    released: '2026-04-02',
    arch: GEMMA_31B_ARCH,
    vision: true,
    price: { input: 0.14, cached: 0.05, output: 0.4 },
    note: 'Default. Reads images for the models that cannot see.',
  },
  {
    id: 'google/gemma-4-31b-it:free',
    name: 'Gemma 4 31B',
    provider: 'openrouter',
    params: '32.7B',
    context: 262_144,
    released: '2026-04-02',
    arch: GEMMA_31B_ARCH,
    vision: true,
    price: FREE,
  },
  {
    id: 'xingchen-agi/xing4.0-29b-a4b:free',
    name: 'Xing4.0 29B',
    provider: 'openrouter',
    params: '29B',
    active: '4B',
    context: 262_144,
    released: '2026-10-16',
    arch: ['40 layers', 'dim 3584', '64 experts + 1 shared, 4 per token', 'latent attention (MLA style), 32 heads', 'multi-token prediction'],
    vision: false,
    price: FREE,
    note: 'From China Telecom (TeleAI).',
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    name: 'Gemma 4 26B',
    provider: 'openrouter',
    params: '25.2B',
    active: '3.8B',
    context: 262_144,
    released: '2026-04-03',
    arch: ['30 layers (25 sliding, 5 full)', 'dim 2816', '128 experts, 8 per token', 'GQA: 16 query heads, 8 KV heads', 'sliding window 1024'],
    vision: true,
    price: FREE,
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    name: 'Nemotron 3.5 Lightning',
    provider: 'openrouter',
    params: '30B',
    active: '3B',
    context: 1_000_000,
    released: '2026-08-11',
    arch: [...NANO_ARCH, 'multi-token prediction'],
    vision: false,
    price: FREE,
    note: 'Built for speed.',
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    name: 'Nemotron 3 Nano Omni',
    provider: 'openrouter',
    params: '30B',
    active: '3B',
    context: 256_000,
    released: '2026-04-28',
    arch: [...NANO_ARCH, 'vision and audio encoders'],
    vision: true,
    price: FREE,
    note: 'Also hears audio and sees video.',
  },
  {
    id: 'nemotron-3-nano:30b',
    name: 'Nemotron 3 Nano 30B',
    provider: 'ollama',
    params: '32B',
    active: '3.2B',
    context: 262_144,
    released: '2025-12-15',
    arch: NANO_ARCH,
    vision: false,
    price: { input: 0.06, cached: null, output: 0.24 },
  },
  {
    id: 'gpt-oss:20b',
    name: 'gpt-oss 20B',
    provider: 'ollama',
    params: '20.9B',
    active: '3.6B',
    context: 131_072,
    released: '2025-08-05',
    arch: ['24 layers (12 sliding, 12 full)', 'dim 2880', '32 experts, 4 per token', 'GQA: 64 query heads, 8 KV heads', 'sliding window 128'],
    vision: false,
    thinkLevels: true,
    price: { input: 0.07, cached: 0.035, output: 0.3 },
  },
]

export const DEFAULT_MODEL = 'gemma4:31b'

/** Reads images for models that cannot see: Gemma on Ollama (paid, so no daily cap). */
export const VISION_MODEL = 'gemma4:31b'

export const PROVIDER_LABEL: Record<Provider, string> = { ollama: 'Ollama', openrouter: 'OpenRouter' }

export function modelInfo(id: string): ModelInfo {
  return (
    MODELS.find((m) => m.id === id) || {
      id,
      name: id,
      provider: String(id || '').includes('/') ? 'openrouter' : 'ollama',
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

/** Dollar cost of one request from the reported token counts. */
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
