/**
 * Phone integration (Android back button, keyboard, status bar, haptics),
 * every call safe in a plain browser too (where it does nothing).
 */
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Keyboard } from '@capacitor/keyboard'
import { StatusBar, Style } from '@capacitor/status-bar'
import { Haptics, ImpactStyle } from '@capacitor/haptics'

export const native = Capacitor.isNativePlatform()

/* ---------------- back button: a stack of things to close ---------------- */

type BackHandler = () => boolean
const backStack: BackHandler[] = []

/** Registers a handler; the newest one runs first. Returns the remover. */
export function onBack(fn: BackHandler) {
  backStack.push(fn)
  return () => {
    const i = backStack.lastIndexOf(fn)
    if (i >= 0) backStack.splice(i, 1)
  }
}

export function initPlatform(opts: { onPause(): void; onResume(): void; fallbackBack(): boolean }) {
  if (!native) {
    document.addEventListener('visibilitychange', () => (document.hidden ? opts.onPause() : opts.onResume()))
    return
  }
  App.addListener('backButton', () => {
    for (let i = backStack.length - 1; i >= 0; i--) if (backStack[i]()) return
    if (opts.fallbackBack()) return
    App.minimizeApp()
  })
  App.addListener('pause', () => opts.onPause())
  App.addListener('resume', () => opts.onResume())
}

/* ---------------- keyboard height, as a CSS variable ---------------- */

/** Keeps --kb (the keyboard's height over the page) and body.kb-open current. */
export function trackKeyboard(onChange?: (open: boolean) => void) {
  const root = document.documentElement
  let pluginHeight = 0
  // The window height with the keyboard down (to tell whether the window shrank for it).
  let baseH = window.innerHeight
  const apply = () => {
    const vv = window.visualViewport
    // With adjustResize the window itself shrinks; otherwise the visual viewport does.
    const overlap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    if (pluginHeight === 0 && overlap < 80) baseH = window.innerHeight
    const shrunk = baseH - window.innerHeight
    // Edge to edge (Android 15 and later) may not shrink anything: then the
    // keyboard covers the page and its reported height is the gap to leave.
    const covered = pluginHeight > 0 && shrunk < pluginHeight * 0.5 && overlap < pluginHeight * 0.5 ? pluginHeight : 0
    const kb = Math.max(overlap, covered)
    root.style.setProperty('--kb', `${kb}px`)
    const open = pluginHeight > 0 || kb > 80
    if (document.body.classList.contains('kb-open') !== open) {
      document.body.classList.toggle('kb-open', open)
      onChange?.(open)
    }
  }
  window.visualViewport?.addEventListener('resize', apply)
  window.visualViewport?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply)
  if (native) {
    Keyboard.addListener('keyboardWillShow', (info) => {
      pluginHeight = info.keyboardHeight
      apply()
    })
    Keyboard.addListener('keyboardDidShow', (info) => {
      pluginHeight = info.keyboardHeight
      apply()
    })
    Keyboard.addListener('keyboardWillHide', () => {
      pluginHeight = 0
      apply()
    })
    Keyboard.addListener('keyboardDidHide', () => {
      pluginHeight = 0
      apply()
    })
  }
  apply()
}

export function hideKeyboard() {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  if (native) Keyboard.hide().catch(() => {})
}

/* ---------------- status bar follows the theme ---------------- */

export function themeStatusBar(dark: boolean, color: string) {
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', color)
  if (!native) return
  StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {})
  StatusBar.setBackgroundColor({ color }).catch(() => {})
}

/* ---------------- a small tap feel ---------------- */

export function tick(strong = false) {
  if (!native) return
  Haptics.impact({ style: strong ? ImpactStyle.Medium : ImpactStyle.Light }).catch(() => {})
}
