/** Phone-only screen state (never synced). */
import { create } from 'zustand'

export type ViewMode = 'flow' | 'canvas'
export type Screen = null | 'search' | 'settings'

interface Prefs {
  /** How pages open by default. */
  defaultView: ViewMode
  /** Pages switched to the other view, remembered per page. */
  pageViews: Record<string, ViewMode>
  /** Text size on the phone, as a factor of the computer's size. */
  textScale: number
  keepImagesOffline: boolean
  swipePages: boolean
  showArchived: boolean
  recentSearches: string[]
  /** This phone's own theme; empty follows the computer's. */
  theme: string
}

const PREFS_KEY = 'notes:mobile:prefs'
const DEFAULTS: Prefs = {
  defaultView: 'flow',
  pageViews: {},
  textScale: 1,
  keepImagesOffline: true,
  swipePages: true,
  showArchived: false,
  recentSearches: [],
  theme: '',
}

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }
  } catch {
    return DEFAULTS
  }
}

interface UiState extends Prefs {
  drawer: boolean
  screen: Screen
  drawing: boolean
  /** Cell picked up to move (canvas view). */
  movingCell: string | null
  /** Search words to flash on the page just opened from search. */
  flash: { pageId: string; cellId: string; query: string } | null
  setPrefs(p: Partial<Prefs>): void
  viewOf(pageId: string | null): ViewMode
  setView(pageId: string, v: ViewMode): void
}

export const useUi = create<UiState>((set, get) => ({
  ...loadPrefs(),
  drawer: false,
  screen: null,
  drawing: false,
  movingCell: null,
  flash: null,
  setPrefs(p) {
    set(p)
    const { defaultView, pageViews, textScale, keepImagesOffline, swipePages, showArchived, recentSearches, theme } = get()
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ defaultView, pageViews, textScale, keepImagesOffline, swipePages, showArchived, recentSearches, theme }))
    } catch {
      /* ignore */
    }
  },
  viewOf(pageId) {
    return (pageId && get().pageViews[pageId]) || get().defaultView
  },
  setView(pageId, v) {
    const pageViews = { ...get().pageViews }
    if (v === get().defaultView) delete pageViews[pageId]
    else pageViews[pageId] = v
    get().setPrefs({ pageViews })
  },
}))
