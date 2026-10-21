/**
 * Settings, Voice: which voice speaks, how fast, how long a pause ends your
 * turn, whether you can talk over it, and which model answers in voice mode
 * (with how fast each one starts talking, measured on this computer).
 * Everything here belongs to this computer, like the chat's model pick.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { MODELS, PROVIDER_LABEL, paramsLabel } from '../../agent/models'
import { useAgent } from '../../agent/store'
import { agentApi } from '../../agent/api'
import { fmtSec, useSpeeds, useVoicePrefs, type ModelSpeed } from '../../voice/voicePrefs'
import { fetchVoices, previewVoice, stopPreview, voiceApi, type VoiceInfo, type VoiceStatus } from '../../voice/voiceSession'
import { cancelSpeedTest, runSpeedTest, useSpeedTest } from '../../voice/speedTest'
import type { PauseLength } from '../../voice/speechText'
import { Check, Play, StopI, Gauge, Folder, Power } from '../Icons'
import { formatVram } from './VoiceEngineChip'

const PAUSES: Array<{ id: PauseLength; label: string; desc: string }> = [
  { id: 'quick', label: 'Quick', desc: 'Answers half a second after you stop. Snappy, may cut in.' },
  { id: 'balanced', label: 'Balanced', desc: 'Three quarters of a second. Right for most people.' },
  { id: 'patient', label: 'Patient', desc: 'Over a second. For thinking out loud.' },
]

const SAMPLE = (name: string) => `Hi, I'm ${name}. I made the key terms on this page bold, and the formula reads x squared over two.`

export default function VoiceSettings() {
  const [prefs, update] = useVoicePrefs()
  const chatModel = useAgent((s) => s.prefs.model)
  const [voices, setVoices] = useState<VoiceInfo[]>([])
  const [voicesError, setVoicesError] = useState<string | null>(null)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [freeToo, setFreeToo] = useState(false)
  const [hasOpenRouter, setHasOpenRouter] = useState(false)
  const [folderMsg, setFolderMsg] = useState('')
  const speeds = useSpeeds()
  const test = useSpeedTest()
  const model = prefs.model || chatModel

  const loadVoices = () => {
    setVoicesError(null)
    fetchVoices()
      .then((v) => setVoices(v))
      .catch((e) => setVoicesError(e?.message ?? 'Could not load the voices.'))
  }
  useEffect(() => {
    voiceApi.status().then(setStatus)
    loadVoices()
    agentApi.keyStatus('openrouter').then((k) => setHasOpenRouter(k.hasKey))
    return () => stopPreview()
  }, [])
  // While the engine wakes up, keep the status line current.
  useEffect(() => {
    if (!status || status.ready || !status.available) return
    const id = setInterval(() => voiceApi.status().then(setStatus), 2500)
    return () => clearInterval(id)
  }, [status])

  const play = async (id: string) => {
    if (playing === id) {
      stopPreview()
      setPlaying(null)
      return
    }
    stopPreview()
    setPlaying(id)
    try {
      const v = voices.find((x) => x.id === id)
      await previewVoice(id, prefs.speed, prefs.volume, v ? SAMPLE(v.name) : undefined)
    } catch (e: any) {
      setVoicesError(e?.message ?? 'Could not play that voice.')
    } finally {
      setPlaying((p) => (p === id ? null : p))
      voiceApi.status().then(setStatus)
    }
  }

  const groups = useMemo(() => {
    const out: Array<{ title: string; items: VoiceInfo[] }> = []
    for (const accent of ['American', 'British'])
      for (const gender of ['female', 'male']) {
        const items = voices.filter((v) => v.accent === accent && v.gender === gender)
        if (items.length) out.push({ title: `${accent} ${gender === 'female' ? 'women' : 'men'}`, items })
      }
    return out
  }, [voices])

  const chooseFolder = async () => {
    setFolderMsg('')
    const r = await voiceApi.chooseEngine()
    if (r.canceled) return
    if (!r.ok) setFolderMsg(r.error || 'That folder has no speech engine.')
    else {
      setFolderMsg('Engine folder saved.')
      voiceApi.status().then(setStatus)
      loadVoices()
    }
  }

  return (
    <div className="set-group voice-settings">
      <h3>Voice mode</h3>
      <div className="empty-hint" style={{ padding: '0 0 10px' }}>
        Talk with the assistant out loud: the waveform button in the assistant, or Ctrl+Shift+Space from anywhere. Hearing and speaking run on this computer's graphics
        card (or its processor, more slowly, on a computer without one), free, with the same speech engine as the weekly planner. Nothing you say leaves the computer except the words sent to the model.
      </div>
      <div className={`vs-status ${status?.ready ? 'ok' : ''}`}>
        <span className="vs-dot" />
        <span>
          {!voiceApi.available
            ? 'Voice mode needs the desktop app.'
            : status === null
              ? 'Checking the speech engine...'
              : !status.available
                ? 'The speech engine was not found on this computer. Pick the weekly planner folder below.'
                : status.ready
                  ? `Speech engine ready on the ${status.device === 'cuda' ? 'GPU' : 'CPU'}.`
                  : status.loading
                    ? 'Loading the voice models...'
                    : status.running
                      ? 'Speech engine running; the models load on first use (a few seconds).'
                      : 'Speech engine off; it starts when you use voice mode.'}
          {status?.error && <span className="vs-err"> {status.error}</span>}
          {status?.running && formatVram(status.vramMb) && <span className="sub"> Using {formatVram(status.vramMb)} of graphics memory.</span>}
        </span>
        {status?.running && (
          <button
            className="btn"
            style={{ marginLeft: 'auto' }}
            title="The engine exits and frees all graphics memory (before gaming, say). Voice mode starts it again."
            onClick={async () => {
              await voiceApi.off().catch(() => {})
              setTimeout(() => voiceApi.status().then(setStatus), 900)
            }}
          >
            <Power size={13} /> Turn off
          </button>
        )}
      </div>
      <div className="set-row">
        <label>
          Speech engine folder
          <span className="sub">{status?.engineDir || 'Not found yet. It is the weekly planner folder (it holds speech-server.py).'}</span>
        </label>
        <button className="btn" onClick={chooseFolder}><Folder size={13} /> Change</button>
      </div>
      {folderMsg && <div className="empty-hint" style={{ padding: '0 0 8px' }}>{folderMsg}</div>}

      <h3>Voice</h3>
      <div className="empty-hint" style={{ padding: '0 0 8px' }}>Who you hear. Press play to listen to each one.</div>
      {voicesError && <div className="vs-err" style={{ paddingBottom: 8 }}>{voicesError}</div>}
      {!voices.length && !voicesError && <div className="empty-hint">Loading voices (starting the speech engine)...</div>}
      {groups.map((g) => (
        <div key={g.title} className="vs-group">
          <div className="vs-group-title">{g.title}</div>
          <div className="vs-voices">
            {g.items.map((v) => {
              const sel = prefs.voice === v.id
              return (
                <div
                  key={v.id}
                  role="button"
                  tabIndex={0}
                  className={`vs-voice ${sel ? 'sel' : ''}`}
                  onClick={() => update({ voice: v.id })}
                  onKeyDown={(e) => e.key === 'Enter' && update({ voice: v.id })}
                >
                  <button
                    className={`vs-play ${v.gender}`}
                    title={playing === v.id ? 'Stop' : `Listen to ${v.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void play(v.id)
                    }}
                  >
                    {playing === v.id ? <StopI size={12} /> : <Play size={12} />}
                  </button>
                  <div className="vs-voice-text">
                    <div className="vs-voice-name">
                      {v.name}
                      {v.id === 'af_heart' && <span className="vs-best">BEST</span>}
                    </div>
                    <div className="vs-voice-note">{v.note}</div>
                  </div>
                  {sel && <Check size={14} className="vs-check" />}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div className="set-row">
        <label>
          Speaking speed
          <span className="sub">{prefs.speed.toFixed(2)}x</span>
        </label>
        <input type="range" min={0.8} max={1.3} step={0.05} value={prefs.speed} onChange={(e) => update({ speed: Number(e.target.value) })} />
      </div>
      <div className="set-row">
        <label>
          Volume
          <span className="sub">{Math.round(prefs.volume * 100)}%</span>
        </label>
        <input type="range" min={0.1} max={1} step={0.05} value={prefs.volume} onChange={(e) => update({ volume: Number(e.target.value) })} />
      </div>

      <h3>Conversation</h3>
      <div className="set-row column">
        <label>
          Pause before it answers
          <span className="sub">When you trail off on "and", "um" or "so", it waits longer on its own.</span>
        </label>
        <div className="vs-pauses">
          {PAUSES.map((p) => (
            <button key={p.id} className={`vs-pause ${prefs.pause === p.id ? 'sel' : ''}`} onClick={() => update({ pause: p.id })}>
              <b>{p.label}</b>
              <span>{p.desc}</span>
            </button>
          ))}
        </div>
      </div>
      <Toggle on={prefs.interrupt} onChange={(v) => update({ interrupt: v })} title="Let me talk over it" desc="Start talking while it speaks and it stops to listen. A quick 'mm-hm' does not stop it. Turn off if your speakers echo into the mic." />
      <Toggle on={prefs.follow} onChange={(v) => update({ follow: v })} title="Follow along in the chat" desc="The sentence being spoken lights up in the chat, and the chat scrolls with it." />
      <Toggle on={prefs.sounds} onChange={(v) => update({ sounds: v })} title="Soft sounds" desc="A gentle tone when voice mode starts, when it has heard you, and when it ends." />

      <h3>Voice model</h3>
      <div className="empty-hint" style={{ padding: '0 0 8px' }}>
        Which model answers in voice mode: separate from the chat's model, and remembered on this computer. The seconds are how long each one takes to start talking,
        measured here by the speed test and by every voice reply. Times change with how busy the cloud is.
      </div>
      <Toggle on={prefs.think} onChange={(v) => update({ think: v })} title="Think before answering" desc="More careful answers, but a much longer silence before it speaks. Both times are shown; the highlighted column is what you will get." />
      <div className="vs-test">
        <button className="btn" disabled={test.running} onClick={() => runSpeedTest({ includeFree: freeToo })}>
          <Gauge size={13} /> {test.running ? 'Testing...' : 'Test speed'}
        </button>
        {test.running && <button className="btn" onClick={cancelSpeedTest}>Stop</button>}
        <span className="empty-hint">{test.running ? test.progress : 'Asks each model a real question about the open page, one at a time. Nothing is changed.'}</span>
      </div>
      {hasOpenRouter && (
        <label className="vs-free">
          <input type="checkbox" checked={freeToo} onChange={(e) => setFreeToo(e.target.checked)} /> Also test the free OpenRouter models (uses 4 of the 50 free requests a day per model)
        </label>
      )}
      {test.error && <div className="vs-err">{test.error}</div>}
      <div className="vs-models">
        <div className="vs-model head">
          <span className="grow">Model</span>
          <span className={`vs-col ${prefs.think ? 'dim' : ''}`}>Quick</span>
          <span className={`vs-col ${prefs.think ? '' : 'dim'}`}>Thinking</span>
          <span className="vs-tick" />
        </div>
        {MODELS.map((m) => {
          const sel = m.id === model
          return (
            <button key={m.id} className={`vs-model ${sel ? 'sel' : ''}`} onClick={() => update({ model: m.id })}>
              <span className="grow">
                <b>{m.name}</b> <em className={`mp-prov ${m.provider}`}>{PROVIDER_LABEL[m.provider]}</em>
                <small>{paramsLabel(m)}{m.note ? ` · ${m.note}` : ''}</small>
              </span>
              <SpeedCell s={speeds.quick[m.id]} active={!prefs.think} />
              <SpeedCell s={speeds.thinking[m.id]} active={prefs.think} />
              <span className="vs-tick">{sel && <Check size={14} />}</span>
            </button>
          )
        })}
      </div>
      {!prefs.model && <div className="empty-hint" style={{ paddingTop: 6 }}>No voice model picked yet: voice mode uses the chat's model until you pick one.</div>}
    </div>
  )
}

function SpeedCell({ s, active }: { s?: ModelSpeed; active: boolean }) {
  if (!s) return <span className={`vs-col ${active ? '' : 'dim'}`}><span className="vs-none">not measured</span></span>
  if (s.error) return <span className={`vs-col ${active ? '' : 'dim'}`}><span className="vs-warn" title={s.error}>no answer</span></span>
  const tone = s.ms < 2500 ? 'fast' : s.ms < 5000 ? 'mid' : 'slow'
  return (
    <span className={`vs-col ${active ? '' : 'dim'}`} title={s.tested ? 'From the speed test' : `Average of ${s.n} real voice ${s.n === 1 ? 'reply' : 'replies'}`}>
      <b className={`vs-sec ${tone}`}>{fmtSec(s.ms)}</b>
      <small>{s.tested ? 'tested' : `${s.n} ${s.n === 1 ? 'reply' : 'replies'}`}</small>
    </span>
  )
}

function Toggle({ on, onChange, title, desc }: { on: boolean; onChange(v: boolean): void; title: string; desc: string }) {
  return (
    <div className="set-row">
      <label>
        {title}
        <span className="sub">{desc}</span>
      </label>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </div>
  )
}
