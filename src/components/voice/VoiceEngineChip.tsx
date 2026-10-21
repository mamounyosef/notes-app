/**
 * The speech engine's on-switch, for the title bar: shown only while the engine
 * runs (Whisper and Kokoro on the graphics card), with the memory it holds. A
 * click turns it off, e.g. before gaming: the engine exits and frees all of it,
 * whichever app (Notes or the planner) started it, and the next voice session
 * starts it again.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { voiceApi, type VoiceStatus } from '../../voice/voiceSession'
import { Power } from '../Icons'

const POLL_MS = 10_000

export function formatVram(mb: number | null | undefined): string {
  if (typeof mb !== 'number' || !Number.isFinite(mb)) return ''
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

export default function VoiceEngineChip() {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => {
    voiceApi.status().then(setStatus).catch(() => setStatus(null))
  }, [])
  useEffect(() => {
    if (!voiceApi.available) return
    refresh()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, POLL_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refresh])

  if (!status?.running) return null
  const what = status.loading ? 'Loading' : status.ready ? (status.device === 'cuda' ? 'GPU' : 'CPU') : 'Idle'
  const mem = formatVram(status.vramMb)
  const off = async () => {
    setBusy(true)
    await voiceApi.off().catch(() => {})
    setTimeout(() => {
      refresh()
      setBusy(false)
    }, 900)
  }
  return (
    <button
      className={`tb-btn voice-engine-chip ${status.ready ? 'ready' : ''}`}
      disabled={busy}
      onClick={off}
      title={`Voice engine is on${mem ? `, using ${mem} of graphics memory` : ''}${status.ready ? '' : ' (models not loaded yet)'}. Click to turn it off and free the GPU; voice mode starts it again.`}
    >
      <span className="vec-dot" />
      Voice {what}
      {mem ? ` · ${mem}` : ''}
      <Power size={13} />
    </button>
  )
}
