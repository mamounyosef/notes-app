export type VV = Record<string, number>
export interface Touched {
  all?: boolean
  cells?: string[]
  meta?: boolean
}

export const RECOVERED_NOTEBOOK: string
export const RECOVERED_SECTION: string

export function stable(value: unknown): string
export function hash(str: string): string
export function vvCompare(a?: VV, b?: VV): 'equal' | 'a' | 'b' | 'concurrent'
export function vvJoin(a?: VV, b?: VV): VV
export function vvBump(vv: VV | undefined, device: string): VV

export function sameCell(a: any, b: any): boolean
export function conflictCopy<C>(loser: C, winner: C): C
export function samePageContent(a: any, b: any): boolean
export function stampPage<P>(base: P | null, cur: P, device: string, touched: Touched | null, now: number): { page: P; bumped: boolean }
export function mergePages<P>(a: P | null, b: P | null, primary?: 'a' | 'b'): P
export function adoptLegacyPage<P>(disk: P, ref: P | null, now: number): P
export function rebasePage<P>(cur: P, sent: P, result: P): P

export function flattenTree(tree: any[]): Map<string, any>
export function buildTree(records: Map<string, any>): any[]
export function stampWorkspace<W>(base: W | null, cur: W, device: string, now: number): { workspace: W; bumped: boolean }
export function mergeWorkspaces<W>(a: W | null, b: W | null, primary?: 'a' | 'b'): W
export function adoptLegacyWorkspace<W>(disk: W, ref: W | null, now: number): W
export function sameWorkspaceContent(a: any, b: any): boolean
export function rebaseWorkspace<W>(cur: W, sent: W, result: W): W

export function stampSettings<S>(base: S | null, cur: S, now: number): { settings: S; bumped: boolean }
export function mergeSettings<S>(a: S | null, b: S | null, primary?: 'a' | 'b'): S
export function rebaseSettings<S>(cur: S, sent: S, result: S): S
