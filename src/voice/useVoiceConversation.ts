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
import { BACKCHANNEL, SentenceSplitter, askSpeech, endpointMs, isUndoCommand, speakable, wordCount } from './speechText'
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
    // Carry on the open chat if it is a spoken one or still empty; otherwise a fresh voice chat.
    if (!ag.chat || (!ag.chat.voice && ag.chat.messages.length)) ag.newChat()
    else if (!ag.chat.voice && !ag.chat.messages.length) useAgent.setState({ chat: { ...ag.chat, voice: true } })
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
        endpointMs: endpointMs(p.pause),
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
          handleFinal(text)
        },
        onDiscard: (utt) => {
          if (bargeRef.current === utt) {
            bargeRef.current = null
            sessionRef.current?.duck(false)
          }
          setHeard('')
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
  }, [handleFinal, silenceReply])

  // Settings changed while talking: apply at once.
  useEffect(() => {
    sessionRef.current?.configure({
      voice: prefs.voice,
      speed: prefs.speed,
      endpointMs: endpointMs(prefs.pause),
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

  const finishTurn = useCallback(() => sessionRef.current?.finishTurn(), [])
  const levels = useCallback(() => sessionRef.current?.levels() ?? { mic: 0, out: 0 }, [])

  return { active, phase, muted, heard, heardFinal, saying, error, done, start, stop, setMuted, interrupt, finishTurn, levels }
}
