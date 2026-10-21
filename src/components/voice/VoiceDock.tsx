/**
 * Voice mode in the assistant panel: the orb, what is being said right now,
 * and the few controls a conversation needs. It takes the composer's place;
 * the chat above keeps the full back-and-forth in text, with the same tool
 * chips and Undo as a typed chat, and the sentence being spoken lit up.
 *
 * Ported from the weekly planner (src/components/voice/VoiceDock.tsx).
 */
import React, { useEffect, useState } from 'react'
import ModelPicker from '../agent/ModelPicker'
import VoiceOrbCanvas from './VoiceOrbCanvas'
import { Brain, Check, Mic, MicOff, PhoneOff, Retry, StopI, Gear } from '../Icons'
import type { VoiceConversation } from '../../voice/useVoiceConversation'
import { useVoicePrefs } from '../../voice/voicePrefs'
import { useAgent } from '../../agent/store'

export const PHASE_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  loading: 'Waking up the voice engine',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Something went wrong',
  ended: 'Voice mode ended',
}

const PHASE_TINT: Record<string, string> = {
  listening: '#60a5fa',
  hearing: '#38bdf8',
  thinking: '#a78bfa',
  speaking: '#fb923c',
  connecting: '#94a3b8',
  loading: '#94a3b8',
  error: '#f87171',
  ended: '#94a3b8',
}

export default function VoiceDock({ voice, onSettings }: { voice: VoiceConversation; onSettings(): void }) {
  const [prefs, setPrefs] = useVoicePrefs()
  const chatModel = useAgent((s) => s.prefs.model)
  const activity = useAgent((s) => s.activity)
  const busy = useAgent((s) => s.busy)
  const { phase, muted } = voice
  const waiting = phase === 'connecting' || phase === 'loading' || phase === 'thinking'
  const tint = muted && phase !== 'speaking' ? '#9ca3af' : PHASE_TINT[phase] ?? '#94a3b8'
  const label = muted && (phase === 'listening' || phase === 'hearing') ? 'Muted' : phase === 'thinking' && busy && activity && activity !== 'Thinking' ? activity : PHASE_LABEL[phase] ?? ''
  const [compact, setCompact] = useState(() => window.innerHeight < 700)
  useEffect(() => {
    const fit = () => setCompact(window.innerHeight < 700)
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  // The last thing said stays readable for a moment after it is done.
  const [caption, setCaption] = useState<{ who: 'you' | 'ai'; text: string; live: boolean } | null>(null)
  useEffect(() => {
    if (voice.saying) setCaption({ who: 'ai', text: voice.saying, live: true })
    else if (voice.heard) setCaption({ who: 'you', text: voice.heard, live: !voice.heardFinal })
  }, [voice.saying, voice.heard, voice.heardFinal])
  useEffect(() => {
    if (voice.saying || voice.heard) return
    const t = setTimeout(() => setCaption(null), 2500)
    return () => clearTimeout(t)
  }, [voice.saying, voice.heard])

  // Keys while talking: Esc ends, M mutes, Enter = "I'm done", Space stops it talking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.ctrlKey || e.altKey || e.metaKey) return
      // A menu or dialog is open: its own keys come first (Esc closes it, not voice mode).
      if (document.querySelector('.mp-pop, .overlay, .lb')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        voice.stop()
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        e.stopImmediatePropagation()
        voice.setMuted(!voice.muted)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        voice.finishTurn()
      } else if (e.key === ' ') {
        e.preventDefault()
        e.stopImmediatePropagation()
        voice.interrupt()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [voice])

  const onOrb = () => {
    if (phase === 'error') voice.start()
    else if (phase === 'speaking') voice.interrupt()
    else if (phase === 'hearing') voice.finishTurn()
    else voice.setMuted(!muted)
  }
  const orbTitle =
    phase === 'error' ? 'Tap to try again' : phase === 'speaking' ? 'Tap to stop it talking (Space)' : phase === 'hearing' ? "Tap when you're done (Enter)" : muted ? 'Tap to unmute (M)' : 'Tap to mute (M)'

  return (
    <div className="vd" style={{ ['--vd-tint' as any]: tint }}>
      <div className="vd-card">
        <div className="vd-top">
          <ModelPicker label="Voice" value={prefs.model || chatModel} onPick={(id) => setPrefs({ model: id })} voiceThink={prefs.think} />
          <button
            className={`vd-chip ${prefs.think ? 'on' : ''}`}
            onClick={() => setPrefs({ think: !prefs.think })}
            title={prefs.think ? 'Thinks before answering: more careful, slower to start. Click for quick answers.' : 'Quick answers. Click to let it think before answering (more careful, slower to start).'}
          >
            <Brain size={12} /> {prefs.think ? 'Thinks first' : 'Quick'}
          </button>
          <div className="spacer" />
          <button className="ag-icon-btn" title="Voice settings" onClick={onSettings}><Gear size={14} /></button>
        </div>

        <div className="vd-stage">
          <VoiceOrbCanvas size={compact ? 150 : 196} phase={phase} muted={muted} levels={voice.levels} onClick={onOrb} title={orbTitle} done={voice.done} />
          <div className="vd-label">
            {label}
            {waiting && <span className="vd-dots"><i /><i /><i /></span>}
          </div>
          <div className="vd-caption-box">
            {voice.error ? (
              <div className="vd-caption err">{voice.error}</div>
            ) : caption ? (
              <div key={`${caption.who}:${caption.who === 'ai' ? caption.text : ''}`} className={`vd-caption ${caption.who} ${caption.live ? 'live' : ''}`}>
                <b>{caption.who === 'you' ? 'You' : 'Assistant'}</b> {caption.text}
              </div>
            ) : (
              <div className="vd-caption hint">
                {phase === 'loading'
                  ? 'First start takes a few seconds while the voice models load on your GPU.'
                  : phase === 'connecting'
                    ? 'Starting the speech engine...'
                    : phase === 'listening' && !muted
                      ? 'Just talk. Pause when you are done. Say "undo that" to take a change back.'
                      : ''}
              </div>
            )}
          </div>
        </div>

        <div className="vd-buttons">
          {phase === 'error' ? (
            <button className="vd-btn wide" onClick={() => voice.start()} title="Try again"><Retry size={15} /> Try again</button>
          ) : (
            <>
              <button className={`vd-btn ${muted ? 'on' : ''}`} title={muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => voice.setMuted(!muted)}>
                {muted ? <MicOff size={17} /> : <Mic size={17} />}
              </button>
              {phase === 'speaking' ? (
                <button className="vd-btn" title="Stop talking (Space)" onClick={voice.interrupt}><StopI size={15} /></button>
              ) : (
                <button className="vd-btn" title="I'm done talking (Enter)" onClick={voice.finishTurn} disabled={phase !== 'hearing'}><Check size={17} /></button>
              )}
            </>
          )}
          <button className="vd-end" onClick={voice.stop} title="End voice mode (Esc)"><PhoneOff size={16} /> End</button>
        </div>
        <div className="vd-keys">Esc ends · M mutes · Space stops it · Enter sends now</div>
      </div>
    </div>
  )
}

/** What you are saying right now, as a bubble taking shape at the end of the chat. */
export function HearingBubble({ text }: { text: string }) {
  return (
    <div className="ag-turn vd-hearing">
      <div className="ag-user">
        <div className="ag-user-text">
          <span className="vd-hearing-dot" />
          {text || <span className="vd-dots"><i /><i /><i /></span>}
        </div>
      </div>
    </div>
  )
}

/** The empty chat in voice mode. */
export function VoiceEmpty() {
  const h = new Date().getHours()
  const hello = h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  const tips = ["What's on this page, in a sentence?", 'Make the key terms bold and the definitions blue', 'Write down that the exam is on Thursday', 'Where did I write about gradient descent?', 'Read me the summary cell']
  return (
    <div className="ag-empty vd-empty">
      <div className="ag-empty-title">{hello}.<br /><span>I'm listening.</span></div>
      <div className="ag-empty-sub">Talk naturally, even fast or messy; I'll ask if something is unclear. Cut in while I'm talking, say "undo that" to take a change back. Everything we say is written down here.</div>
      <div className="vd-tips">
        {tips.map((t) => (
          <div key={t} className="vd-tip"><span>Try</span> "{t}"</div>
        ))}
      </div>
    </div>
  )
}
