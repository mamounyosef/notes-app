export interface PausedItem {
  key: string
  reason: string
  until: number
}

export function pausedMessage(paused: PausedItem[]): string

export class PushGuard {
  constructor(opts?: { windowMs?: number; maxRepeats?: number; maxPerItem?: number; maxTotal?: number; now?: () => number })
  check(key: string, hash: string | null): string | null
  record(key: string, hash: string | null): void
  pausedItems(): PausedItem[]
}
