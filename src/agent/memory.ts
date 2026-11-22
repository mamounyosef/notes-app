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
  { kind: 'rule', label: 'Note rules', hint: 'How notes, diagrams and formulas should look', color: '#f0883e' },
  { kind: 'style', label: 'How to answer', hint: 'Tone, length, language of replies', color: '#61afef' },
  { kind: 'about', label: 'About you', hint: 'Who you are, what you study or work on', color: '#98c379' },
  { kind: 'fact', label: 'Facts', hint: 'Courses, projects, names, context worth knowing', color: '#56b6c2' },
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

/** Ids of every notebook and section above the open page: a memory scoped to any of them applies here. */
export function openScopeIds(): Set<string> {
  const st = useStore.getState()
  const id = st.page?.id || st.activePageId
  return new Set(id ? pathTo(st.workspace.tree, id).map((n) => n.id) : [])
}

/**
 * Where a memory for "here" goes: the section (subnotebook) the open page is
 * in, such as one course. Named notebook in the code for history; the user
 * sees the section's name.
 */
export function currentNotebook(): { id: string; title: string } | null {
  const st = useStore.getState()
  const id = st.page?.id || st.activePageId
  if (!id) return null
  const path = pathTo(st.workspace.tree, id)
  // The section right under the notebook (a course, a subject): its subsections and pages share its memories.
  // A page straight under a notebook uses the notebook.
  const top = path.find((n) => n.kind === 'section') || path.find((n) => n.kind === 'notebook') || null
  return top ? { id: top.id, title: top.title } : null
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
    const item: MemoryItem = { ...same, kind: input.kind || same.kind, updatedAt: Date.now(), off: false }
    // Saved again with another scope: the latest choice wins.
    if (input.notebook) Object.assign(item, { notebookId: input.notebook.id, notebookTitle: input.notebook.title })
    else {
      delete item.notebookId
      delete item.notebookTitle
    }
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
import { fullBlock, memoryTurn, type MemCtx, type MemNow } from './memoryDelta'
export { memoryKnown, type MemCtx } from './memoryDelta'

/* ------------------------------------------------------------------ *
 * What the model is told
 * ------------------------------------------------------------------ */

/** How the assistant uses and keeps its memory (no list: that comes with memoryBlock). */
export function memoryRules(): string {
  const st = memoryState()
  if (!st.on) return `\n\n# Memory\nThe user turned the assistant's memory off. Do not call remember, update_memory or forget, and do not claim to remember anything from other chats. If they ask you to remember something, tell them memory is off and that they can turn it on in Settings, Memory (or with the memory button in the panel header).\n`
  return `

# Memory
You have a long term memory of this user that lasts across chats. It comes with their messages: a <memory> block with the first one, then a short <memory_update> on a later message whenever something changed (they moved to another section, came back to one, or entries were added, changed or removed). Each update adds to what you were told before; an entry stays in force until an update says otherwise. Entries have ids like [m4k2]. The user can see and edit all of it in Settings, Memory and in the panel's Memory view.

It has two scopes:
- GENERAL memories apply to all their notes and every chat: who they are, how they like answers, formatting habits that hold whatever the subject.
- SECTION memories belong to one section (a subnotebook inside a notebook, usually one course or subject) and apply only while they work on a page inside it, at any depth: its notation and conventions, how its diagrams and notes should look, facts about that course. The block lists the general ones and those of the section open now; other sections' memories are left out.

Using it:
- Treat every listed entry as a standing instruction or a known fact. Apply the relevant ones on your own in every reply, without being reminded: rules shape how you write and draw in their notes, answer style shapes your replies, facts inform what you say. A section memory is more specific than a general one: when they conflict inside that section, the section one wins.
- What they ask now beats a memory. If it looks like a lasting change, update the memory (or offer to).
- When one or more memories shaped this reply (what you wrote, drew or said), end the reply with one final line listing exactly those ids, in this form: [[mem: m4k2, m9ab]]. Only entries you really applied, never all of them by default. No line when none applied. The app hides this line and shows the user a "used memory" badge instead, so never mention it or the ids in the text.

Keeping it:
- Call remember when the user asks you to remember something ("remember", "from now on", "always", "never", "next time", "keep in mind")${st.auto ? ', and also on your own when they state a lasting preference, correct how you did something in a way that clearly applies to the future, or share a lasting fact about themselves or their work. Do not save one-off details of the current task' : '. Only save when they ask; the user turned off saving on your own. When something looks worth remembering, you may offer it in one short sentence'}.
- Choose the scope yourself every time; never ask unless it is truly a coin flip. Ask: "would this still be right in a different course, on a different subject?" Yes: general. No, it is tied to this subject: section (the open page's section unless they name another). Their words decide first: "in this course", "for this subject", "in this notebook", "here" mean section; "always", "everywhere", "in all my notes", "in every course", "in every chat" mean general. Typical section memories: how diagrams, circuits, tables or formulas of that subject should look, notation, the professor's or course's conventions, what the course covers. Typical general ones: their name, what they study overall, language and tone, answer length, formatting they want everywhere. A habit first stated in one course but clearly about them, not the subject (like "answer shorter"), is general.
- One idea per memory, written as a short, self-contained, specific sentence that still makes sense in a new chat months later (say "Logic circuit diagrams are drawn inside a box: the gates inside, inputs entering on the left and outputs leaving on the right", not "do it like the picture"). Rules as instructions, facts as plain statements. A section memory does not need to repeat the section's name.
- Pick the kind: rule (how notes, diagrams, formulas should look), style (how to answer: tone, length, language), about (who they are, what they study or do), fact (courses, projects, people, other context).
- Before saving, look at the existing entries: update_memory one that covers the same thing (or contradicts it) instead of adding a near copy; update_memory can also move an entry between general and a section when they say it applies more widely or only here. Use forget when they ask you to forget something or an entry turned out wrong.
- Never save passwords, keys, codes or other secrets, and nothing they asked you not to keep.
- After saving or changing a memory, say so in a few words that name the scope ("Saved to memory for Embedded Systems." or "Saved to your general memory."). The app also shows a card for it.
`
}

/** A notebook's title as it is now (renamed since), falling back to the one saved with the memory. */
export function notebookTitle(id?: string, fallback?: string) {
  if (!id) return ''
  const n = findNodeIn(useStore.getState().workspace.tree, id)
  return n?.title || fallback || 'a section'
}

function findNodeIn(nodes: any[], id: string): any {
  for (const n of nodes || []) {
    if (n.id === id) return n
    const hit = findNodeIn(n.children || [], id)
    if (hit) return hit
  }
  return null
}

/** The entries the model gets now: the general ones and the open section's (or any section or notebook above the page). */
export function memoryInScope(items = memoryState().items, ids = openScopeIds()) {
  return items.filter((m) => !m.off && (!m.notebookId || ids.has(m.notebookId)))
}

/** Memory as it stands for the page open now. */
export function memoryNow(): MemNow {
  const st = memoryState()
  const ids = openScopeIds()
  const live = st.items.filter((m) => !m.off)
  const inScope = live.filter((m) => !m.notebookId || ids.has(m.notebookId)).map((m) => (m.notebookId ? { ...m, notebookTitle: notebookTitle(m.notebookId, m.notebookTitle) } : m))
  return { on: st.on, sec: currentNotebook(), inScope, elsewhere: live.length - inScope.length, crowded: live.length > MEMORY_SOFT_LIMIT }
}

/** What to append to the next message (and the state after it), given the state after the previous one. */
export const memoryTurnNow = (prev: MemCtx | null) => memoryTurn(prev, memoryNow())

/** The full list for a conversation that has not seen it (a new Claude session, or after compaction). */
export const memoryFullNow = () => fullBlock(memoryNow())

/** Rough size of what memory adds: its rules once, plus the list now in force. */
export const estimateMemoryTokens = () => Math.ceil(`${memoryRules()}${memoryFullNow()}`.length / 3.6)
