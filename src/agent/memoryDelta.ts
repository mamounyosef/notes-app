/**
 * Memory in the conversation, appended, never rewritten.
 *
 * The system prompt and earlier messages must stay byte for byte the same, or
 * the model's prompt cache breaks and the whole conversation is processed
 * again. So the memory list is not in the system prompt: the first message of
 * a chat carries the full <memory> block, and each later message carries a
 * small <memory_update> only when something changed since the message before:
 * the user moved to another section (course), came back to one, or memories
 * were added, changed or removed. The note is stored with the message, so
 * every later request repeats it exactly and the cache holds.
 *
 * Pure (no app imports), so it can be tested on its own.
 */
import type { MemoryItem } from '../types'

/** What the conversation knows about memory after a message (kept in that message's meta). */
export interface MemCtx {
  /** The section memories applied to at that message (null: none open). */
  sec: string | null
  secTitle?: string
  /** Every entry the conversation has been shown, by id, with a hash of what it was shown as. */
  seen: Record<string, string>
  /** Entries in force at that message. */
  active: string[]
  /** Of those, the ones that belong to a section (they leave when the user changes section). */
  scoped?: string[]
  /** Memory was off. */
  off?: boolean
}

export interface MemNow {
  on: boolean
  /** The open page's section (where new section memories go). */
  sec: { id: string; title: string } | null
  /** Entries in force now: general ones plus those of the open section (and anything above the page). */
  inScope: MemoryItem[]
  /** Entries of other sections, for the count in the full block. */
  elsewhere: number
  /** Too many entries: ask the model to merge when saving. */
  crowded?: boolean
}

const ORDER = ['rule', 'style', 'about', 'fact']

export function itemHash(m: MemoryItem) {
  const s = `${m.text}|${m.kind}|${m.notebookId || ''}|${m.pinned ? 1 : 0}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const sortItems = (l: MemoryItem[]) => [...l].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.updatedAt - a.updatedAt)

/** One entry as the model sees it. withScope: say where it applies (in updates, where there is no heading). */
export function memLine(m: MemoryItem, withScope = false) {
  const tags = [withScope ? (m.notebookId ? `section "${m.notebookTitle || m.notebookId}"` : 'general') : '', m.kind, m.pinned ? 'important' : ''].filter(Boolean).join(', ')
  return `[${m.id}] (${tags}) ${m.text}`
}

/** The full list, as the first message of a conversation carries it. */
export function fullBlock(now: MemNow): string {
  if (!now.on) return ''
  const general = sortItems(now.inScope.filter((m) => !m.notebookId))
  const here = sortItems(now.inScope.filter((m) => m.notebookId))
  const parts = [`## General (all notes)\n${general.length ? general.map((m) => memLine(m)).join('\n') : '(none yet)'}`]
  parts.push(
    now.sec
      ? `## Section "${now.sec.title}" [${now.sec.id}] (the section the open page is in)\n${here.length ? here.map((m) => memLine(m)).join('\n') : '(none yet)'}`
      : '## Section\n(No page is open, so no section memories apply. A section memory needs an open page or a section_id.)',
  )
  if (now.elsewhere) parts.push(`(${now.elsewhere} more belong to other sections and apply only there: you get them when the user works there.)`)
  if (now.crowded) parts.push('(Many entries: when saving, prefer merging into existing ones.)')
  return `<memory>\n${parts.join('\n\n')}\n</memory>`
}

function snapshot(now: MemNow, seen: Record<string, string> = {}): MemCtx {
  const next = { ...seen }
  for (const m of now.inScope) next[m.id] = itemHash(m)
  return { sec: now.sec?.id || null, secTitle: now.sec?.title, seen: next, active: now.on ? now.inScope.map((m) => m.id) : [], scoped: now.on ? now.inScope.filter((m) => m.notebookId).map((m) => m.id) : [], ...(now.on ? {} : { off: true }) }
}

/**
 * What to append to the next message, and what the conversation knows after it.
 * prev: the state after the previous message (null: none, start of the conversation).
 */
export function memoryTurn(prev: MemCtx | null, now: MemNow): { note: string; ctx: MemCtx } {
  if (!prev) return { note: fullBlock(now), ctx: snapshot(now) }
  if (!now.on) {
    if (prev.off) return { note: '', ctx: prev }
    return { note: '<memory_update>\nThe user turned memory off. None of the memories listed before apply anymore, and do not save new ones.\n</memory_update>', ctx: { ...snapshot(now, prev.seen), off: true } }
  }
  // Back from off: the whole list again.
  if (prev.off) return { note: fullBlock(now).replace('<memory>', '<memory>\n(Memory is on again. This is the whole current list.)'), ctx: snapshot(now, prev.seen) }

  const lines: string[] = []
  const active = new Set(prev.active)
  const nowIds = new Set(now.inScope.map((m) => m.id))
  const secId = now.sec?.id || null
  const moved = secId !== prev.sec
  if (moved) {
    const was = prev.sec ? `"${prev.secTitle || prev.sec}"` : 'no section'
    lines.push(now.sec ? `The user is now in section "${now.sec.title}" [${now.sec.id}] (was ${was}).${prev.sec ? ` The section memories of ${was} no longer apply.` : ''}` : `No page is open now (was ${was}): only general memories apply.`)
  }
  const fresh: MemoryItem[] = []
  const changed: MemoryItem[] = []
  const again: string[] = []
  for (const m of sortItems(now.inScope)) {
    const h = itemHash(m)
    if (prev.seen[m.id] === undefined) fresh.push(m)
    else if (prev.seen[m.id] !== h) changed.push(m)
    else if (!active.has(m.id)) again.push(m.id)
  }
  const gone = prev.active.filter((id) => !nowIds.has(id))
  // Left behind only because the user changed section: the line above already says so.
  const goneQuietly = new Set(moved && prev.sec ? prev.scoped || [] : [])

  if (fresh.length) lines.push(`${moved ? 'Apply from now on:' : 'New since your last message:'}\n${fresh.map((m) => memLine(m, true)).join('\n')}`)
  if (changed.length) lines.push(`Changed (this replaces what you were shown before):\n${changed.map((m) => memLine(m, true)).join('\n')}`)
  if (again.length) lines.push(`Apply again, as listed earlier in this conversation: ${again.map((id) => `[${id}]`).join(', ')}`)
  const removed = gone.filter((id) => !goneQuietly.has(id))
  if (removed.length) lines.push(`No longer apply (forgotten, paused or moved elsewhere): ${removed.map((id) => `[${id}]`).join(', ')}`)
  if (moved && now.sec && !now.inScope.some((m) => m.notebookId)) lines.push(`"${now.sec.title}" has no section memories yet.`)

  const ctx = snapshot(now, prev.seen)
  if (!lines.length) return { note: '', ctx }
  return { note: `<memory_update>\n${lines.join('\n')}\n</memory_update>`, ctx }
}

/** The conversation learned about an entry another way (its own remember, update_memory or forget): no need to tell it again. */
export function memoryKnown(ctx: MemCtx, item: MemoryItem | null, id: string, inForce: boolean): MemCtx {
  const seen = { ...ctx.seen }
  let active = ctx.active.filter((x) => x !== id)
  let scoped = (ctx.scoped || []).filter((x) => x !== id)
  if (item) {
    seen[id] = itemHash(item)
    if (inForce) {
      active = [...active, id]
      if (item.notebookId) scoped = [...scoped, id]
    }
  }
  return { ...ctx, seen, active, scoped }
}
