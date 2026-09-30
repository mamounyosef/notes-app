/**
 * User configurable editor shortcuts. They are read from the settings on every
 * key press, so a change in Settings applies straight away without a reload.
 *
 * Shortcut strings look like "Alt-n", "Ctrl-Shift-l" or "Mod-Alt-7" ("+" works
 * as a separator too). Letters and digits are matched by physical key, so they
 * keep working with a non English keyboard layout active.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import { useStore } from '../store'
import type { Settings } from '../types'

export type ShortcutKey =
  | 'bulletListShortcut'
  | 'numberedListShortcut'
  | 'horizontalLineShortcut'
  | 'thickLineShortcut'
  | 'verticalLineShortcut'

export const SHORTCUTS: { key: ShortcutKey; label: string; run(editor: Editor): boolean }[] = [
  { key: 'bulletListShortcut', label: 'Bullet list', run: (e) => e.commands.toggleBulletList() },
  { key: 'numberedListShortcut', label: 'Numbered list', run: (e) => e.commands.toggleOrderedList() },
  { key: 'horizontalLineShortcut', label: 'Horizontal line', run: (e) => e.commands.setHorizontalRule() },
  { key: 'thickLineShortcut', label: 'Thick horizontal line', run: (e) => (e.commands as any).setThickHorizontalRule() },
  { key: 'verticalLineShortcut', label: 'Thick vertical line (columns)', run: (e) => (e.commands as any).setThickVerticalRule() },
]

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

interface Combo { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }

export function parseShortcut(raw: string): Combo | null {
  const parts = String(raw || '').trim().split(/[-+](?!$)/).map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null
  const combo: Combo = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
  for (const p of parts.slice(0, -1)) {
    const m = p.toLowerCase()
    if (m === 'ctrl' || m === 'control') combo.ctrl = true
    else if (m === 'alt' || m === 'option') combo.alt = true
    else if (m === 'shift') combo.shift = true
    else if (m === 'meta' || m === 'cmd' || m === 'win') combo.meta = true
    else if (m === 'mod') isMac ? (combo.meta = true) : (combo.ctrl = true)
    else return null
  }
  combo.key = parts[parts.length - 1].toLowerCase()
  return combo
}

export function matchesShortcut(e: KeyboardEvent, raw: string): boolean {
  const c = parseShortcut(raw)
  if (!c) return false
  if (e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.shiftKey !== c.shift || e.metaKey !== c.meta) return false
  if (/^[a-z]$/.test(c.key)) return e.code === `Key${c.key.toUpperCase()}`
  if (/^[0-9]$/.test(c.key)) return e.code === `Digit${c.key}` || e.code === `Numpad${c.key}`
  return e.key.toLowerCase() === c.key
}

/** Turns a key press into a shortcut string, or null while only modifiers are held. */
export function shortcutFromEvent(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null
  let key = e.key
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  const mods = [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
  return [...mods, key].join('-')
}

/** Readable form for tooltips and the settings page, e.g. "Alt+N". */
export function prettyShortcut(raw: string): string {
  const c = parseShortcut(raw)
  if (!c) return raw || 'None'
  const mods = [c.ctrl && 'Ctrl', c.meta && (isMac ? 'Cmd' : 'Win'), c.alt && 'Alt', c.shift && 'Shift'].filter(Boolean)
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1)
  return [...mods, key].join('+')
}

export function shortcutFor(settings: Settings, key: ShortcutKey): string {
  return (settings[key] as string) || ''
}

export const ConfigurableShortcuts = Extension.create({
  name: 'configurableShortcuts',
  // Run before the built in keymaps so a user binding always wins.
  priority: 1000,
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('configurableShortcuts'),
        props: {
          handleKeyDown: (_view, event) => {
            const settings = useStore.getState().settings
            for (const s of SHORTCUTS) {
              const raw = shortcutFor(settings, s.key)
              if (raw && matchesShortcut(event, raw)) {
                event.preventDefault()
                s.run(editor)
                return true
              }
            }
            return false
          },
        },
      }),
    ]
  },
})
