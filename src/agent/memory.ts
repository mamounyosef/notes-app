/**
 * The assistant's long term memory: short standing facts and rules about the
 * user, kept across chats. Stored in the synced settings (assistantMemory), so
 * every computer shares it. How often each one is used is kept per computer
 * (localStorage), so using a memory never rewrites the synced settings.
 */
import { create } from 'zustand'
import { useStore, pathTo } from '../store'
import type { MemoryItem, MemoryKind, MemoryState } from '../types'

export type { MemoryItem, MemoryKind, MemoryState }

export const MEMORY_KINDS: { kind: MemoryKind; label: string; hint: string; color: string }[] = [
  { kind: 'rule', label: 'Note rules', hint: 'How notes, diagrams and formulas should look', color: '#c678dd' },
  { kind: 'style', label: 'How to answer', hint: 'Tone, length, language of replies', color: '#61afef' },
  { kind: 'about', label: 'About you', hint: 'Who you are, what you study or work on', color: '#98c379' },
  { kind: 'fact', label: 'Facts', hint: 'Courses, projects, names, context worth knowing', color: '#e5c07b' },
]
export const kindInfo = (k: MemoryKind | string | undefined) => MEMORY_KINDS.find((x) => x.kind === k) || MEMORY_KINDS[3]

export const DEFAULT_MEMORY: MemoryState = { on: true, auto: true, items: [] }
/** Past this many, the oldest unpinned unused ones are the first candidates to merge or drop (the assistant is told). */
export const MEMORY_SOFT_LIMIT = 80
const MAX_TEXT = 400

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

export function memoryState(): MemoryState {
  const m = (useStore.getState().settings as any).assistantMemory as MemoryState | undefined
  return { ...DEFAULT_MEMORY, ...(m || {}), items: Array.isArray(m?.items) ? m!.items : [] }
}

function save(next: MemoryState) {
  useStore.getState().setSettings({ assistantMemory: next } as any)
}

export function setMemoryPrefs(p: Partial<Pick<MemoryState, 'on' | 'auto'>>) {
  save({ ...memoryState(), ...p })
}

const newId = (taken: Set<string>) => {
  for (;;) {
    const id = `m${Math.random().toString(36).slice(2, 6)}`
    if (!taken.has(id)) return id
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Clean text for a memory: one line of plain prose, not too long. */
export function cleanText(t: string) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
}

/** The notebook the open page is in, for scoping a memory to it. */
export function currentNotebook(): { id: string; title: string } | null {
  const st = useStore.getState()
  const id = st.page?.id || st.activePageId
  if (!id) return null
  const path = pathTo(st.workspace.tree, id)
  const nb = path.find((n) => n.kind === 'notebook') || path[0]
  return nb ? { id: nb.id, title: nb.title } : null
}

export function findMemory(id: string) {
  const key = String(id || '').trim().replace(/^\[|\]$/g, '')
  return memoryState().items.find((m) => m.id === key) || null
}

/** An entry with the same words (case and punctuation aside). */
export function similarMemory(text: string) {
  const n = norm(cleanText(text))
  return memoryState().items.find((m) => norm(m.text) === n) || null
}

/** Adds a memory. A near copy of an existing one updates that one instead. */
export function addMemory(input: { text: string; kind?: MemoryKind; notebook?: { id: string; title: string } | null; by: 'assistant' | 'you'; chatId?: string; chatTitle?: string; pinned?: boolean }): { item: MemoryItem; merged: boolean } {
  const st = memoryState()
  const text = cleanText(input.text)
  const same = similarMemory(text)
  if (same) {
    const item = { ...same, kind: input.kind || same.kind, updatedAt: Date.now(), off: false }
    save({ ...st, items: st.items.map((m) => (m.id === same.id ? item : m)) })
    emit({ type: 'saved', id: item.id })
    return { item, merged: true }
  }
  const now = Date.now()
  const item: MemoryItem = {
    id: newId(new Set(st.items.map((m) => m.id))),
    text,
    kind: input.kind || 'fact',
    createdAt: now,
    updatedAt: now,
    by: input.by,
    ...(input.notebook ? { notebookId: input.notebook.id, notebookTitle: input.notebook.title } : {}),
    ...(input.chatId ? { chatId: input.chatId, chatTitle: input.chatTitle } : {}),
    ...(input.pinned ? { pinned: true } : {}),
  }
  save({ ...st, items: [item, ...st.items] })
  emit({ type: 'saved', id: item.id })
  return { item, merged: false }
}

export function updateMemory(id: string, patch: Partial<Omit<MemoryItem, 'id' | 'createdAt'>>) {
  const st = memoryState()
  const old = st.items.find((m) => m.id === id)
  if (!old) return null
  const item: MemoryItem = { ...old, ...patch, ...(patch.text !== undefined ? { text: cleanText(patch.text) } : {}), updatedAt: Date.now() }
  if (patch.notebookId === null) {
    delete item.notebookId
    delete item.notebookTitle
  }
  save({ ...st, items: st.items.map((m) => (m.id === id ? item : m)) })
  emit({ type: 'saved', id })
  return item
}

export function removeMemory(id: string) {
  const st = memoryState()
  const old = st.items.find((m) => m.id === id) || null
  if (!old) return null
  save({ ...st, items: st.items.filter((m) => m.id !== id) })
  emit({ type: 'removed', id })
  return old
}

/** Puts a memory back exactly as it was (undo), in its old place by date. */
export function restoreMemory(item: MemoryItem) {
  const st = memoryState()
  const rest = st.items.filter((m) => m.id !== item.id)
  const items = [...rest, item].sort((a, b) => b.createdAt - a.createdAt)
  save({ ...st, items })
  emit({ type: 'saved', id: item.id })
}

export function replaceAllMemories(items: MemoryItem[]) {
  save({ ...memoryState(), items })
}

/* ------------------------------------------------------------------ *
 * Use counts (this computer only)
 * ------------------------------------------------------------------ */

const STATS_KEY = 'agent-memory-stats-v1'
type Stats = Record<string, { uses: number; last: number }>

interface MemUi {
  stats: Stats
  /** The memory view in the assistant panel, and the memory to show in it. */
  open: boolean
  focus: string | null
  /** Bumped when a memory is saved or used, for the header glow. */
  pulse: { n: number; kind: 'saved' | 'used' | 'removed' }
  show(focus?: string | null): void
  hide(): void
}

function loadStats(): Stats {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

export const useMemoryUi = create<MemUi>((set) => ({
  stats: loadStats(),
  open: false,
  focus: null,
  pulse: { n: 0, kind: 'saved' },
  show: (focus = null) => set({ open: true, focus }),
  hide: () => set({ open: false, focus: null }),
}))

function emit(e: { type: 'saved' | 'used' | 'removed'; id?: string }) {
  const p = useMemoryUi.getState().pulse
  useMemoryUi.setState({ pulse: { n: p.n + 1, kind: e.type } })
}

/** The assistant said it applied these memories in a reply. */
export function markUsed(ids: string[]) {
  const known = new Set(memoryState().items.map((m) => m.id))
  const real = ids.filter((id) => known.has(id))
  if (!real.length) return
  const stats = { ...useMemoryUi.getState().stats }
  for (const id of real) stats[id] = { uses: (stats[id]?.uses || 0) + 1, last: Date.now() }
  useMemoryUi.setState({ stats })
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats))
  } catch {
    /* full */
  }
  emit({ type: 'used' })
}

export { takeMemoryMarker, hideMemoryMarker } from './memoryMarker'

/* ------------------------------------------------------------------ *
 * What the model is told
 * ------------------------------------------------------------------ */

/** How the assistant uses and keeps its memory (no list: that comes with memoryBlock). */
export function memoryRules(): string {
  const st = memoryState()
  if (!st.on) return `\n\n# Memory\nThe user turned the assistant's memory off in Settings. Do not call remember, update_memory or forget, and do not claim to remember anything from other chats. If they ask you to remember something, tell them memory is off and that they can turn it on in Settings, AI, Memory (or with the brain button in the panel header).\n`
  return `

# Memory
You have a long term memory of this user that lasts across chats. Its entries come in a <memory> block (in this prompt or with their message), each with an id like [m4k2]. The user can see and edit all of it in Settings and in the panel's Memory view.

Using it:
- Treat every entry as a standing instruction or a known fact. Apply the relevant ones on your own in every reply, without being reminded: note rules shape how you write and draw in their notes, answer rules shape your replies, facts and "about you" inform what you say.
- An entry limited to a notebook only applies while they work in that notebook.
- What they ask now beats a memory. If it looks like a lasting change, update the memory (or offer to).
- When one or more memories shaped this reply (what you wrote, drew or said), end the reply with one final line listing exactly those ids, in this form: [[mem: m4k2, m9ab]]. Only entries you really applied, never all of them by default. No line when none applied. The app hides this line and shows the user a "used memory" badge instead, so never mention it or the ids in the text.

Keeping it:
- Call remember when the user asks you to remember something ("remember", "from now on", "always", "never", "next time", "keep in mind")${st.auto ? ', and also on your own when they state a lasting preference, correct how you did something in a way that clearly applies to the future, or share a lasting fact about themselves or their work. Do not save one-off details of the current task' : '. Only save when they ask; the user turned off saving on your own. When something looks worth remembering, you may offer it in one short sentence'}.
- One idea per memory, written as a short, self-contained, specific sentence that still makes sense in a new chat months later (say "Logic circuit diagrams are drawn inside a box: the gates inside, inputs entering on the left and outputs leaving on the right", not "do it like the picture"). Rules as instructions, facts as plain statements.
- Pick the kind: rule (how notes, diagrams, formulas should look), style (how to answer: tone, length, language), about (who they are, what they study or do), fact (courses, projects, people, other context).
- Limit it to a notebook (notebook_id) only when they say it is for that notebook or subject.
- Before saving, look at the existing entries: update_memory one that covers the same thing (or contradicts it) instead of adding a near copy. Use forget when they ask you to forget something or an entry turned out wrong.
- Never save passwords, keys, codes or other secrets, and nothing they asked you not to keep.
- After saving or changing a memory, say so in a few words ("Saved to memory."). The app also shows a card for it.
`
}

/** The entries themselves, for the model. Empty string when memory is off. */
export function memoryBlock(): string {
  const st = memoryState()
  if (!st.on) return ''
  const items = st.items.filter((m) => !m.off)
  if (!items.length) return '<memory>\n(empty: nothing remembered yet)\n</memory>'
  const order = MEMORY_KINDS.map((k) => k.kind)
  const sorted = [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || order.indexOf(a.kind) - order.indexOf(b.kind) || b.updatedAt - a.updatedAt)
  const lines = sorted.map((m) => {
    const tags = [m.kind, m.pinned ? 'important' : '', m.notebookId ? `only in notebook "${m.notebookTitle || m.notebookId}" [${m.notebookId}]` : ''].filter(Boolean).join(', ')
    return `[${m.id}] (${tags}) ${m.text}`
  })
  const over = items.length > MEMORY_SOFT_LIMIT ? `\n(${items.length} entries: when saving, prefer merging into existing ones.)` : ''
  return `<memory>\n${lines.join('\n')}${over}\n</memory>`
}

/** A short fingerprint of what the model would be told, to know when to send the list again. */
export function memoryRev(): string {
  const s = `${memoryRules()}\n${memoryBlock()}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export const estimateMemoryTokens = () => Math.ceil(`${memoryRules()}${memoryBlock()}`.length / 3.6)
