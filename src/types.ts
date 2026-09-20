/** Shapes of everything persisted to disk. Keep backwards-compatible. */

export type NodeKind = 'notebook' | 'section' | 'page'

export interface TreeNode {
  id: string
  kind: NodeKind
  title: string
  color?: string
  archived?: boolean
  /** Sections live inside notebooks, sections nest, pages nest under pages. */
  children: TreeNode[]
  collapsed?: boolean
  createdAt: number
  updatedAt: number
}

export interface Workspace {
  version: 1
  tree: TreeNode[]
  favorites: string[]
  recent: string[]
  lastOpenPageId?: string
}

export type CellKind = 'text' | 'ink'

export interface Stroke {
  color: string
  size: number
  eraser?: boolean
  /** Flat [x0,y0,x1,y1,...] in cell-local coordinates. */
  points: number[]
}

export interface Cell {
  id: string
  kind: CellKind
  x: number
  y: number
  w: number
  h: number
  z: number
  /** Bold heading line shown at the top of every cell. */
  title: string
  showTitle: boolean
  /** TipTap HTML for text cells. */
  html: string
  strokes?: Stroke[]
  bg?: string
  border?: string
  locked?: boolean
  collapsed?: boolean
  autoHeight?: boolean
  createdAt: number
  updatedAt: number
}

export interface Page {
  id: string
  title: string
  cells: Cell[]
  /**
   * Set by the OneNote importer. Cells grow to fit this app's fonts, which can
   * leave them overlapping, so the page is tidied once after the first render
   * and the flag is cleared.
   */
  needsReflow?: boolean
  /** Freehand ink drawn on the page itself, behind/above cells. */
  strokes: Stroke[]
  createdAt: number
  updatedAt: number
}

export interface Settings {
  version: 1
  theme: 'dark' | 'light' | 'sepia' | 'midnight' | 'nord' | 'system'
  accent: string
  pageBackground: 'none' | 'grid' | 'dots' | 'lines'
  showGrid: boolean
  gridSize: number
  snapToGrid: boolean

  bodyFont: string
  headingFont: string
  monoFont: string
  bodySize: number
  titleSize: number
  pageTitleSize: number
  lineHeight: number
  bodyColor: string
  titleColor: string

  defaultCellWidth: number
  defaultCellHeight: number
  cellPadding: number
  cellRadius: number
  cellBorder: boolean

  cellBg: string
  cellGap: number
  newCellAtClick: boolean
  cellAutoHeight: boolean

  markdownPaste: 'auto' | 'always' | 'never'
  autoMath: boolean
  autoLink: boolean
  smartQuotes: boolean

  penColor: string
  penSize: number
  highlighterColor: string
  highlighterSize: number

  autosaveMs: number
  thickLineShortcut: string
  spellcheck: boolean
  sidebarWidth: number
  pagelistWidth: number
  sidebarVisible: boolean
  pagelistVisible: boolean
  showStatusBar: boolean
  showPageDate: boolean
  confirmDelete: boolean
  zoomStep: number
  panButton: 'right' | 'middle' | 'space'
  recentColors: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: 'dark',
  accent: '#7c9cff',
  pageBackground: 'grid',
  showGrid: true,
  gridSize: 20,
  snapToGrid: true,

  bodyFont: 'Segoe UI, Calibri, system-ui, sans-serif',
  headingFont: 'Segoe UI Semibold, Segoe UI, system-ui, sans-serif',
  monoFont: 'Cascadia Code, Consolas, monospace',
  bodySize: 15,
  titleSize: 21,
  pageTitleSize: 30,
  lineHeight: 1.55,
  bodyColor: '#e6e6e6',
  titleColor: '#e8b0a0',

  defaultCellWidth: 560,
  defaultCellHeight: 180,
  cellPadding: 12,
  cellRadius: 8,
  cellBorder: true,

  cellBg: '',
  cellGap: 8,
  newCellAtClick: true,
  cellAutoHeight: true,

  markdownPaste: 'auto',
  autoMath: true,
  autoLink: true,
  smartQuotes: false,

  penColor: '#e06c75',
  penSize: 3,
  highlighterColor: '#ffd75e',
  highlighterSize: 16,

  autosaveMs: 700,
  thickLineShortcut: 'Alt-s',
  spellcheck: true,
  sidebarWidth: 230,
  pagelistWidth: 250,
  sidebarVisible: true,
  pagelistVisible: true,
  showStatusBar: true,
  showPageDate: true,
  confirmDelete: true,
  zoomStep: 0.1,
  panButton: 'right',
  recentColors: ['#e06c75', '#e5c07b', '#98c379', '#61afef', '#c678dd', '#ffffff'],
}
