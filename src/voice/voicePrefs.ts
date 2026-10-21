/**
 * Voice mode: this computer's choices. Kept per device (localStorage), like
 * the chat's model pick, so the laptop and the desktop each keep their own.
 */
import { useCallback, useEffect, useState } from 'react'
import { MODELS } from '../agent/models'
import type { PauseLength } from './speechText'

export interface VoicePrefs {
  /** A Kokoro voice id, e.g. "af_heart". */
  voice: string
  /** 0.8 to 1.3. */
  speed: number
  /** How long a pause ends your turn. */
  pause: PauseLength
  /** Talking over the assistant stops it. */
  interrupt: boolean
  /** Soft tones when voice mode starts, hears you out, and ends. */
  sounds: boolean
  /** 0 to 1. */
  volume: number
  /** The model thinks before answering: more careful, but a much longer silence. */
  think: boolean
  /** The model that answers in voice mode; empty means "the same as the chat". */
  model: string
  /** Highlight, in the chat, the sentence being spoken right now. */
  follow: boolean
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  voice: 'af_heart',
  speed: 1.0,
  pause: 'balanced',
  interrupt: true,
  sounds: true,
  volume: 0.9,
  think: false,
  model: '',
  follow: true,
}

const KEY = 'notes-voice-prefs'
const EVENT = 'notes-voice-prefs'

export function coerceVoicePrefs(raw: unknown): VoicePrefs {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
  }
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const d = DEFAULT_VOICE_PREFS
  return {
    voice: typeof r.voice === 'string' && /^[a-z]{2}_[a-z]+$/.test(r.voice) ? r.voice : d.voice,
    speed: Math.round(num(r.speed, 0.8, 1.3, d.speed) * 100) / 100,
    pause: r.pause === 'quick' || r.pause === 'patient' || r.pause === 'balanced' ? r.pause : d.pause,
    interrupt: bool(r.interrupt, d.interrupt),
    sounds: bool(r.sounds, d.sounds),
    volume: Math.round(num(r.volume, 0, 1, d.volume) * 100) / 100,
    think: bool(r.think, d.think),
    model: typeof r.model === 'string' && MODELS.some((m) => m.id === r.model) ? r.model : '',
    follow: bool(r.follow, d.follow),
  }
}

export function readVoicePrefs(): VoicePrefs {
  try {
    return coerceVoicePrefs(JSON.parse(localStorage.getItem(KEY) || 'null'))
  } catch {
    return { ...DEFAULT_VOICE_PREFS }
  }
}

export function writeVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  const next = coerceVoicePrefs({ ...readVoicePrefs(), ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(EVENT))
  return next
}

/** The prefs, live: a change in Settings shows up in the voice dock at once. */
export function useVoicePrefs(): [VoicePrefs, (patch: Partial<VoicePrefs>) => void] {
  const [prefs, setPrefs] = useState<VoicePrefs>(readVoicePrefs)
  useEffect(() => {
    const reload = () => setPrefs(readVoicePrefs())
    const onStorage = (e: StorageEvent) => e.key === KEY && reload()
    window.addEventListener('storage', onStorage)
    window.addEventListener(EVENT, reload)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(EVENT, reload)
    }
  }, [])
  const update = useCallback((patch: Partial<VoicePrefs>) => setPrefs(writeVoicePrefs(patch)), [])
  return [prefs, update]
}

// ---------------------------------------------------------------- how fast each model starts talking

/**
 * Seconds to the first spoken word, per model, on this computer. Filled two
 * ways: the speed test in Settings, and every real voice reply (a running
 * average of the last few), so models are measured just by being used, and
 * free models with a daily cap never have to spend requests on a test.
 */
export interface ModelSpeed {
  /** Milliseconds from sending to the first word, averaged. */
  ms: number
  /** How many measurements the average holds. */
  n: number
  at: number
  /** From the speed test (true) or from real use. */
  tested?: boolean
  error?: string
}

export type ModelSpeeds = { quick: Record<string, ModelSpeed>; thinking: Record<string, ModelSpeed> }

const SPEED_KEY = 'notes-voice-speeds'
const SPEED_EVENT = 'notes-voice-speeds'

export function readSpeeds(): ModelSpeeds {
  try {
    const j = JSON.parse(localStorage.getItem(SPEED_KEY) || 'null')
    return { quick: j?.quick || {}, thinking: j?.thinking || {} }
  } catch {
    return { quick: {}, thinking: {} }
  }
}

function writeSpeeds(s: ModelSpeeds) {
  try {
    localStorage.setItem(SPEED_KEY, JSON.stringify(s))
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(SPEED_EVENT))
}

/** One measurement. Real use blends into the average; a test result replaces it. */
export function recordSpeed(model: string, think: boolean, ms: number | null, opts: { tested?: boolean; error?: string } = {}) {
  const all = readSpeeds()
  const book = think ? all.thinking : all.quick
  const old = book[model]
  if (ms === null) {
    if (opts.tested) book[model] = { ms: old?.ms ?? 0, n: old?.n ?? 0, at: Date.now(), tested: true, error: opts.error || 'No answer' }
  } else if (opts.tested || !old || old.error) {
    book[model] = { ms, n: 1, at: Date.now(), ...(opts.tested ? { tested: true } : {}) }
  } else {
    const n = Math.min(5, old.n + 1)
    book[model] = { ms: Math.round(old.ms + (ms - old.ms) / n), n, at: Date.now(), tested: old.tested }
  }
  writeSpeeds(all)
}

export function useSpeeds(): ModelSpeeds {
  const [s, setS] = useState(readSpeeds)
  useEffect(() => {
    const reload = () => setS(readSpeeds())
    window.addEventListener(SPEED_EVENT, reload)
    return () => window.removeEventListener(SPEED_EVENT, reload)
  }, [])
  return s
}

export const fmtSec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
