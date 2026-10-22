/**
 * Voice mode: the conversation. Joins a VoiceSession (ears and mouth) to the
 * assistant store. Everything the assistant does still goes through the same
 * loop as a typed chat: the same tools, the same chips, the same Undo, the
 * same history. Voice only changes how the words get in and out:
 *
 *   heard a sentence    -> sent as a message (a reply in progress is cut
 *                          short first, so what was just said is never lost)
 *   reply streaming in  -> cut into sentences, each spoken the moment it is
 *                          complete, so the voice starts while the model is
 *                          still writing
 *   a question card     -> read out; the next thing said answers it
 *   "undo that"         -> the last change is put back at once, no model
 *   talked over         -> the voice ducks at once, and stops for good when
 *                          real words arrive (a "mm-hm" does not stop it)
 *
 * Ported from the weekly planner (src/lib/voice/useVoiceConversation.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgent } from '../agent/store'
import { activePath } from '../agent/branches'
import { canUndo } from '../agent/tools'
import { useStore, walk } from '../store'
import { BACKCHANNEL, SentenceSplitter, askSpeech, engineEndpointMs, isUndoCommand, speakable, turnWaitMs, wordCount } from './speechText'
import { VoiceSession, voiceApi, type VoicePhase } from './voiceSession'
import { readVoicePrefs, type VoicePrefs } from './voicePrefs'

export interface VoiceConversation {
  active: boolean
  phase: VoicePhase
  muted: boolean
  /** What the user is saying right now (live), or just said. */
  heard: string
  heardFinal: boolean
  /** The sentence the assistant is saying now. */
  saying: string
  error: string | null
  /** Bumped when a reply changed their notes: the orb flashes green. */
  done: number
  start: () => Promise<void>
  stop: () => void
  setMuted: (on: boolean) => void
  /** Stop the assistant talking (a tap on the orb). */
  interrupt: () => void
  /** End the user's turn now. */
  finishTurn: () => void
  /** 0..1 loudness, for the orb; cheap enough for every animation frame. */
  levels: () => { mic: number; out: number }
}

/** Whisper's opening line: what kind of talk to expect (instead of the planner's "Let's plan my day"). */
const WHISPER_PROMPT = 'Okay, so in my notes, on this page.'

/** Words from their own notes, so speech recognition spells them right. */
function notesHints(): string {
  const st = useStore.getState()
  const words: string[] = []
  const add = (t?: string) => {
    const w = String(t || '').replace(/\s+/g, ' ').trim()
    if (w && w.length <= 40 && !words.includes(w)) words.push(w)
  }
  for (const c of st.page?.cells || []) add((c as any).title)
  add(st.page?.title)
  walk(st.workspace.tree, (n) => {
    if (n.kind !== 'page' && !n.archived) add(n.title)
  })
  walk(st.workspace.tree, (n) => {
    if (n.kind === 'page' && !n.archived && words.length < 60) add(n.title)
  })
  return words.length ? `Words I use: ${words.join(', ')}.`.slice(0, 500) : ''
}

interface Track {
  id: string
  splitter: SentenceSplitter
  last: string
  /** When the message was started (its stamp). */
  at: number
}

export function useVoiceConversation(prefs: VoicePrefs): VoiceConversation {
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<VoicePhase>('ended')
  const [muted, setMutedState] = useState(false)
  const [heard, setHeard] = useState('')
  const [heardFinal, setHeardFinal] = useState(false)
  const [saying, setSaying] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(0)

  const sessionRef = useRef<VoiceSession | null>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const bargeRef = useRef<number | null>(null)
  const interruptedRef = useRef(false)
  /**
   * Talked over at this moment: nothing written before it is said any more.
   * (A time, not a flag: the cut reply may still flush a last update after
   * the next message has gone out.)
   */
  const silencedAt = useRef(0)
  /** ...and the reply being written then, in case its stamp runs ahead of this clock. */
  const silencedIds = useRef(new Set<string>())
  const heardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * What was heard but not sent yet: the engine stops listening after at most
   * 2 s of silence, and the rest of the pause (longer after "and", a comma or
   * an unfinished sentence) is waited here. Speaking again adds to it.
   */
  const held = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null } | null>(null)
  const [holding, setHolding] = useState(false)
  /** Done was pressed while still speaking: send as soon as that is written down. */
  const sendNext = useRef(false)
  const sendingRef = useRef<Promise<void>>(Promise.resolve())

  const say = useCallback((text: string) => {
    const s = sessionRef.current
    const t = speakable(text)
    if (!s || !t) return
    s.say(t)
  }, [])

  const silenceReply = useCallback(() => {
    silencedAt.current = Date.now() + 1
    const live = useAgent.getState().live
    if (live) silencedIds.current.add(live.id)
    interruptedRef.current = true
    sessionRef.current?.cancelSpeech()
    setSaying('')
  }, [])

  // ---- what was heard becomes a message ----
  const handleFinal = useCallback(
    (text: string) => {
      const s = sessionRef.current
      if (!s) return
      const ag = useAgent.getState()
      const wasBarge = bargeRef.current !== null
      bargeRef.current = null
      // "Mm-hm" while it is still answering: keep going.
      if (wasBarge && ag.busy && BACKCHANNEL.test(text.trim()) && (ag.live?.at ?? Infinity) > silencedAt.current) {
        s.duck(false)
        return
      }
      if (s.isPlaying()) silenceReply()

      // "Undo that": put the last change back right away.
      if (isUndoCommand(text) && !ag.pendingAsk) {
        sendingRef.current = sendingRef.current.then(async () => {
          const st = useAgent.getState()
          if (st.busy) st.stop()
          const turn = [...activePath(st.chat)].reverse().find((m) => m.meta?.turnId && !m.meta.undone && canUndo(m.meta.turnId))
          if (!turn?.meta?.turnId) return say("There's nothing here for me to undo.")
          await useAgent.getState().undo(turn.meta.turnId)
          say(useAgent.getState().error ? "Sorry, I couldn't undo that one." : 'Done, I put it back.')
        })
        return
      }

      s.setThinking(true)
      // An answer to the question it asked goes straight in: the reply is waiting on it.
      if (ag.pendingAsk) {
        interruptedRef.current = false
        ag.answerAsk(text)
        return
      }
      const prefix = interruptedRef.current ? '(You were interrupted.) ' : ''
      interruptedRef.current = false
      // One at a time, in the order they were said (each waits only for the one before to go out).
      sendingRef.current = sendingRef.current.then(async () => {
        try {
          await useAgent.getState().sendVoice(prefix + text)
        } catch (err: any) {
          sessionRef.current?.setThinking(false)
          setError(err?.message ?? 'Could not send that.')
          say('Sorry, I could not send that to the assistant.')
        }
      })
    },
    [say, silenceReply],
  )

  /** Sends what is held now. */
  const flushHeld = useCallback(() => {
    const h = held.current
    if (!h) return
    if (h.timer) clearTimeout(h.timer)
    held.current = null
    setHolding(false)
    handleFinal(h.text)
  }, [handleFinal])

  /** Waits out the rest of the pause for what is held (from the end of the engine's own wait). */
  const armHeld = useCallback(
    (fullWait: boolean) => {
      const h = held.current
      if (!h) return
      if (h.timer) clearTimeout(h.timer)
      const p = prefsRef.current
      const wait = turnWaitMs(h.text, p) - (fullWait ? 0 : engineEndpointMs(p.pauseMs))
      if (wait <= 0) return flushHeld()
      h.timer = setTimeout(flushHeld, wait)
    },
    [flushHeld],
  )

  /** Something was written down: hold it for the rest of the pause, unless it must go now. */
  const onHeard = useCallback(
    (text: string) => {
      const ag = useAgent.getState()
      // "Mm-hm" over a reply is handled at once (it keeps the reply going).
      if (bargeRef.current !== null && ag.busy && BACKCHANNEL.test(text.trim())) return handleFinal(text)
      held.current = { text: held.current ? `${held.current.text} ${text}` : text, timer: held.current?.timer ?? null }
      setHolding(true)
      if (sendNext.current) {
        sendNext.current = false
        return flushHeld()
      }
      armHeld(false)
    },
    [handleFinal, flushHeld, armHeld],
  )

  // ---- the reply, spoken as it streams ----
  useEffect(() => {
    if (!active) return
    const tracks = new Map<string, Track>()
    let liveId: string | null = null
    let askId: string | null = null
    let lastError: string | null = useAgent.getState().error
    let wasBusy = useAgent.getState().busy
    const speakAll = (tr: Track, parts: string[]) => {
      if (tr.at > silencedAt.current && !silencedIds.current.has(tr.id)) parts.forEach(say)
    }
    const finishTrack = (id: string, fallback: string) => {
      const tr = tracks.get(id)
      if (!tr) return
      const saved = useAgent.getState().chat?.messages.find((m) => m.id === id)
      speakAll(tr, tr.splitter.finish(saved?.content ?? fallback))
      tracks.delete(id)
    }
    const off = useAgent.subscribe((st) => {
      const live = st.live
      if (liveId && live?.id !== liveId) finishTrack(liveId, tracks.get(liveId)?.last ?? '')
      liveId = live?.id ?? null
      if (live && live.content) {
        let tr = tracks.get(live.id)
        if (!tr) tracks.set(live.id, (tr = { id: live.id, splitter: new SentenceSplitter(), last: '', at: live.at }))
        tr.last = live.content
        speakAll(tr, tr.splitter.push(live.content))
      }
      // A question card: read it out; the next thing said answers it.
      const ask = st.pendingAsk?.messageId ?? null
      if (ask && ask !== askId) {
        const m = st.chat?.messages.find((x) => x.id === ask)
        if (m?.meta?.ask) say(askSpeech(m.meta.ask))
        sessionRef.current?.setThinking(false)
      }
      askId = ask
      if (st.error && st.error !== lastError) say(`Sorry. ${st.error.split(/(?<=[.!?])\s/)[0]}`)
      lastError = st.error
      if (wasBusy && !st.busy) {
        sessionRef.current?.setThinking(false)
        // The reply changed their notes: a green flash on the orb.
        const turn = activePath(st.chat)
        const lastUser = turn.map((m) => m.role).lastIndexOf('user')
        if (turn.slice(lastUser + 1).some((m) => m.meta?.turnId && !m.meta.undone)) setDone((n) => n + 1)
      }
      if (!wasBusy && st.busy) sessionRef.current?.setThinking(true)
      wasBusy = st.busy
    })
    return off
  }, [active, say])

  // ---- start and stop ----
  const stop = useCallback(() => {
    sessionRef.current?.stop()
    sessionRef.current = null
    setActive(false)
    setPhase('ended')
    setSaying('')
    setHeard('')
    bargeRef.current = null
    // Voice mode ended mid pause: what was held is dropped with it.
    if (held.current?.timer) clearTimeout(held.current.timer)
    held.current = null
    sendNext.current = false
    setHolding(false)
    useAgent.getState().setVoiceOn(false)
  }, [])

  const start = useCallback(async () => {
    if (sessionRef.current) {
      // "Try again" after an error: start over with a fresh session.
      if (sessionRef.current.currentPhase !== 'error') return
      sessionRef.current.stop()
      sessionRef.current = null
    }
    setError(null)
    setHeard('')
    setSaying('')
    const ag = useAgent.getState()
    ag.setVoiceOn(true)
    // Carry on the open chat, typed or spoken: voice just continues the conversation. A new chat only if none is open.
    if (!ag.chat) ag.newChat()
    interruptedRef.current = false
    silencedAt.current = 0
    if (!voiceApi.available) {
      setError('Voice mode needs the desktop app.')
      setPhase('error')
      return
    }
    const p = readVoicePrefs()
    const session = new VoiceSession(
      {
        voice: p.voice,
        speed: p.speed,
        endpointMs: engineEndpointMs(p.pauseMs),
        interrupt: p.interrupt,
        volume: p.volume,
        sounds: p.sounds,
        hints: notesHints(),
        prompt: WHISPER_PROMPT,
        livePrefs: () => {
          const f = readVoicePrefs()
          return { voice: f.voice, speed: f.speed }
        },
      },
      {
        onPhase: setPhase,
        onSpeechStart: (utt, whilePlaying) => {
          // Talking again: keep what is held and wait for the rest.
          if (held.current?.timer) {
            clearTimeout(held.current.timer)
            held.current.timer = null
          }
          setHeard('')
          setHeardFinal(false)
          if (heardTimer.current) clearTimeout(heardTimer.current)
          if (whilePlaying && prefsRef.current.interrupt) {
            bargeRef.current = utt
            sessionRef.current?.duck(true)
          }
        },
        onPartial: (text, utt) => {
          setHeard(text)
          setHeardFinal(false)
          if (bargeRef.current === utt && wordCount(text) >= 2 && !BACKCHANNEL.test(text.trim())) silenceReply()
        },
        onFinal: (text) => {
          setHeard(text)
          setHeardFinal(true)
          if (heardTimer.current) clearTimeout(heardTimer.current)
          heardTimer.current = setTimeout(() => setHeard(''), 6000)
          onHeard(text)
        },
        onDiscard: (utt) => {
          if (bargeRef.current === utt) {
            bargeRef.current = null
            sessionRef.current?.duck(false)
          }
          setHeard('')
          // Only noise: wait the whole pause again for what is held.
          if (held.current && !held.current.timer) armHeld(true)
          if (sendNext.current && held.current) {
            sendNext.current = false
            flushHeld()
          }
        },
        onSaying: (_id, text) => setSaying(text),
        onQuiet: () => setSaying(''),
        onError: (msg) => setError(msg),
      },
    )
    sessionRef.current = session
    setActive(true)
    setPhase('connecting')
    try {
      await session.start()
    } catch (err: any) {
      const msg =
        err?.name === 'NotAllowedError'
          ? 'The microphone is blocked for Notes. Allow it in Windows privacy settings and try again.'
          : err?.name === 'NotFoundError'
            ? 'No microphone was found.'
            : (err?.message ?? 'Voice mode could not start.')
      setError(msg)
      session.stop()
      sessionRef.current = null
      setActive(false)
      setPhase('error')
    }
  }, [onHeard, armHeld, flushHeld, silenceReply])

  // Settings changed while talking: apply at once.
  useEffect(() => {
    sessionRef.current?.configure({
      voice: prefs.voice,
      speed: prefs.speed,
      endpointMs: engineEndpointMs(prefs.pauseMs),
      interrupt: prefs.interrupt,
      volume: prefs.volume,
      sounds: prefs.sounds,
    })
  }, [prefs])

  useEffect(
    () => () => {
      sessionRef.current?.stop()
      sessionRef.current = null
      useAgent.getState().setVoiceOn(false)
    },
    [],
  )

  const setMuted = useCallback((on: boolean) => {
    sessionRef.current?.setMuted(on)
    setMutedState(on)
  }, [])

  const interrupt = useCallback(() => {
    const s = sessionRef.current
    if (s?.isPlaying()) silenceReply()
  }, [silenceReply])

  /** Done: what is held goes now; if still speaking, it goes as soon as that is written down. */
  const finishTurn = useCallback(() => {
    if (phase === 'hearing') {
      sendNext.current = true
      sessionRef.current?.finishTurn()
    } else flushHeld()
  }, [phase, flushHeld])
  const levels = useCallback(() => sessionRef.current?.levels() ?? { mic: 0, out: 0 }, [])

  // Still the user's turn while the rest of the pause runs: the orb and the done button say so.
  const shownPhase = holding && phase === 'listening' ? 'hearing' : phase
  return { active, phase: shownPhase, muted, heard, heardFinal, saying, error, done, start, stop, setMuted, interrupt, finishTurn, levels }
}
