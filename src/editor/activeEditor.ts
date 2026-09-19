import { create } from 'zustand'
import type { Editor } from '@tiptap/react'

/** Whichever cell editor currently has focus; the format toolbar acts on it. */
interface ActiveEditorState {
  editor: Editor | null
  /** Bumped on every selection/transaction so toolbars re-render. */
  tick: number
  setEditor(e: Editor | null): void
  bump(): void
}

export const useActiveEditor = create<ActiveEditorState>((set) => ({
  editor: null,
  tick: 0,
  setEditor: (editor) => set({ editor, tick: Date.now() }),
  bump: () => set({ tick: Date.now() }),
}))
