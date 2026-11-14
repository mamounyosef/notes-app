/** Touch helpers: long press that does not fight with scrolling. */
import { useRef } from 'react'
import type React from 'react'

const LONG_MS = 480
const SLOP = 10

/**
 * Props for an element that reacts to tap and long press. A finger that
 * moves (a scroll) cancels both, so lists scroll freely.
 */
export function usePress(onTap: (e: React.PointerEvent) => void, onLong?: (e: React.PointerEvent) => void) {
  const st = useRef<{ x: number; y: number; t: any; long: boolean; id: number } | null>(null)
  const cancel = () => {
    if (st.current) clearTimeout(st.current.t)
    st.current = null
  }
  return {
    onPointerDown(e: React.PointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      cancel()
      const ev = { ...e, currentTarget: e.currentTarget, target: e.target, clientX: e.clientX, clientY: e.clientY } as React.PointerEvent
      st.current = {
        x: e.clientX,
        y: e.clientY,
        long: false,
        id: e.pointerId,
        t: onLong
          ? setTimeout(() => {
              if (!st.current) return
              st.current.long = true
              onLong(ev)
            }, LONG_MS)
          : null,
      }
    },
    onPointerMove(e: React.PointerEvent) {
      const s = st.current
      if (s && s.id === e.pointerId && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) cancel()
    },
    onPointerUp(e: React.PointerEvent) {
      const s = st.current
      if (!s || s.id !== e.pointerId) return
      clearTimeout(s.t)
      st.current = null
      if (!s.long) onTap(e)
    },
    onPointerCancel: cancel,
    onContextMenu(e: React.MouseEvent) {
      e.preventDefault()
    },
  }
}
