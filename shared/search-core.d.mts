export type Mark = [number, number]

/** A query word that only matched approximately, and the word it matched. */
export interface NearMatch {
  term: string
  word: string
}

export interface SearchCellHit {
  cellId: string
  cellTitle: string
  snippet: string
  marks: Mark[]
  titleMarks: Mark[]
  near: NearMatch[]
}

export interface SearchResult {
  pageId: string
  title: string
  score: number
  titleMarks: Mark[]
  /** Not every query word was found on this page. */
  partial: boolean
  near: NearMatch[]
  /** Query words (or "phrases") not found on this page. */
  missing: string[]
  matchedIn: ('title' | 'notebook' | 'text')[]
  hits: SearchCellHit[]
}

export interface SearchablePage {
  id: string
  title: string
  path?: string[]
  updatedAt?: number
  cells?: { id: string; title?: string; html?: string }[]
}

export function fold(s: string): string
export function stripHtml(html: string): string
export function parseQuery(q: string): { terms: string[]; phrases: string[]; raw: string }
export function searchPages(query: string, pages: SearchablePage[], now?: number): SearchResult[]
export function suggestion(query: string, results: SearchResult[]): string | null
export function pageIndex(tree: any[]): Map<string, { path: string[]; archived: boolean }>
