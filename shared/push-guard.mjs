/**
 * Stops a sync loop before it burns the cloud quota.
 *
 * Two computers that disagree about a note (or a chat) can keep sending it to
 * each other forever: every upload is downloaded by the other one, which
 * uploads again. That once made ~180,000 writes and ~19 GB of downloads in two
 * days without anyone noticing. A loop shows up as the same content uploaded
 * again and again, so:
 *
 *  - the same content of one item uploaded more than MAX_REPEATS times in an
 *    hour pauses that item for an hour;
 *  - more than MAX_PER_ITEM uploads of one item, or MAX_TOTAL uploads overall,
 *    in an hour pauses it (or everything) too, for loops whose content keeps
 *    changing a little.
 *
 * Paused items stay saved locally and are retried after the pause, so nothing
 * is lost; the status shows the problem instead of it going on silently.
 */
const WINDOW_MS = 60 * 60_000
const MAX_REPEATS = 20
const MAX_PER_ITEM = 1000
const MAX_TOTAL = 3000

/** One line for the status: what the guard holds back and why. */
export function pausedMessage(paused) {
  if (!paused.length) return ''
  const p = paused[0]
  const what = p.key === '*' ? 'all uploads' : paused.length > 1 ? `${paused.length} items (first: ${p.key})` : p.key
  return `Paused ${what}: ${p.reason}. Saved on this computer, retried after ${new Date(Math.max(...paused.map((x) => x.until))).toLocaleTimeString()}`
}

export class PushGuard {
  constructor({ windowMs = WINDOW_MS, maxRepeats = MAX_REPEATS, maxPerItem = MAX_PER_ITEM, maxTotal = MAX_TOTAL, now = Date.now } = {}) {
    Object.assign(this, { windowMs, maxRepeats, maxPerItem, maxTotal, now })
    /** key -> [{ at, hash }] */
    this.log = new Map()
    /** key -> { until, reason } */
    this.paused = new Map()
    this.total = []
    this.allPausedUntil = 0
  }

  prune(t) {
    const from = t - this.windowMs
    for (const [k, list] of this.log) {
      const kept = list.filter((e) => e.at > from)
      if (kept.length) this.log.set(k, kept)
      else this.log.delete(k)
    }
    this.total = this.total.filter((at) => at > from)
    for (const [k, p] of this.paused) if (p.until <= t) this.paused.delete(k)
  }

  /** Why `key` must not be uploaded now (with this content), or null when it may. */
  check(key, hash) {
    const t = this.now()
    this.prune(t)
    if (this.allPausedUntil > t) return 'too many uploads in the last hour'
    const p = this.paused.get(key)
    if (p) return p.reason
    const list = this.log.get(key) || []
    let reason = null
    if (hash != null && list.filter((e) => e.hash === hash).length >= this.maxRepeats) reason = 'the same version kept being uploaded (a sync loop)'
    else if (list.length >= this.maxPerItem) reason = 'it was uploaded too many times in the last hour'
    if (reason) {
      this.paused.set(key, { until: t + this.windowMs, reason })
      return reason
    }
    if (this.total.length >= this.maxTotal) {
      this.allPausedUntil = t + this.windowMs
      return 'too many uploads in the last hour'
    }
    return null
  }

  /** An upload of `key` went through. */
  record(key, hash) {
    const t = this.now()
    const list = this.log.get(key) || []
    list.push({ at: t, hash })
    this.log.set(key, list)
    this.total.push(t)
  }

  /** What is paused right now, for the status line. */
  pausedItems() {
    const t = this.now()
    this.prune(t)
    const out = [...this.paused].map(([key, p]) => ({ key, reason: p.reason, until: p.until }))
    if (this.allPausedUntil > t) out.push({ key: '*', reason: 'too many uploads in the last hour', until: this.allPausedUntil })
    return out
  }
}
