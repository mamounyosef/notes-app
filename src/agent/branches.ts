/**
 * Chats are trees: editing a message or regenerating a reply adds a sibling
 * instead of replacing anything, and chat.chosen remembers which sibling is
 * shown at each fork. Messages are never removed, so syncing (a union of
 * messages) keeps every branch on every computer.
 */
import type { Chat, ChatMessage } from './api'

const ROLE_ORDER: Record<string, number> = { user: 0, tool: 1, assistant: 2 }

/** Time, then the user's message, tool results, replies (same as shared/chat-store.mjs). */
export function messageOrder(x: ChatMessage, y: ChatMessage) {
  return (x.at || 0) - (y.at || 0) || (ROLE_ORDER[x.role] ?? 3) - (ROLE_ORDER[y.role] ?? 3) || x.id.localeCompare(y.id)
}

export const ROOT = 'root'
export const PENDING = 'pending'

interface Tree {
  parentOf: Map<string, string>
  children: Map<string, ChatMessage[]>
}

const trees = new WeakMap<ChatMessage[], Tree>()

/** Parent of every message (ROOT for the first) and the children of every message, oldest first. */
export function treeOf(messages: ChatMessage[]): Tree {
  const hit = trees.get(messages)
  if (hit) return hit
  const sorted = [...messages].sort(messageOrder)
  const parentOf = new Map<string, string>()
  const children = new Map<string, ChatMessage[]>()
  let prevLegacy: string | null = null
  for (const m of sorted) {
    // Older messages have no parent: they follow the one before them.
    const p = m.parent === undefined ? prevLegacy ?? ROOT : m.parent ?? ROOT
    if (m.parent === undefined) prevLegacy = m.id
    parentOf.set(m.id, p)
    const list = children.get(p)
    if (list) list.push(m)
    else children.set(p, [m])
  }
  const tree = { parentOf, children }
  trees.set(messages, tree)
  return tree
}

/** The conversation as shown: from the first message, following the chosen (or newest) branch at each fork. */
export function activePath(chat: Chat | null): ChatMessage[] {
  if (!chat) return []
  const { children } = treeOf(chat.messages)
  const out: ChatMessage[] = []
  let key = ROOT
  for (let guard = 0; guard < 100000; guard++) {
    const kids = children.get(key)
    if (!kids?.length) break
    const pick = chat.chosen?.[key]
    if (pick?.id === PENDING) break
    const next = kids.find((k) => k.id === pick?.id) ?? kids[kids.length - 1]
    out.push(next)
    key = next.id
  }
  return out
}

/** Where a new message goes: after the last shown one. */
export function tipOf(chat: Chat | null): string | null {
  const path = activePath(chat)
  return path.length ? path[path.length - 1].id : null
}

export function parentKey(chat: Chat, id: string) {
  return treeOf(chat.messages).parentOf.get(id) ?? ROOT
}

/**
 * The versions a message has: siblings of the same kind (edits of a message
 * of yours, or regenerations of a reply), oldest first, and which one this is.
 */
export function versionsOf(chat: Chat, m: ChatMessage): { list: ChatMessage[]; index: number; parent: string } {
  const parent = parentKey(chat, m.id)
  const same = (x: ChatMessage) => (x.role === 'user') === (m.role === 'user')
  const list = (treeOf(chat.messages).children.get(parent) || []).filter(same)
  return { list, index: Math.max(0, list.findIndex((x) => x.id === m.id)), parent }
}
