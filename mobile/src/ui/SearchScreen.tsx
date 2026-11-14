/**
 * Search everything, as you type: the same ranked search as the computer
 * (typos forgiven, "exact phrases", -excluded words). Tap a result to open the
 * page with the words lit up; tap a snippet to jump to that cell.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { storage, type SearchHit } from '../../../src/lib/storage'
import { pathTo, useStore } from '../../../src/store'
import { ArrowLeft, Clock, X } from '../../../src/components/Icons'
import { pageIndex, suggestion } from '../../../shared/search-core.mjs'
import { onBack } from '../platform'
import { useUi } from './state'

type Filter = 'all' | 'titles' | 'here'

function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  if (!marks?.length) return <>{text}</>
  const out: React.ReactNode[] = []
  let at = 0
  marks.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s))
    out.push(<mark key={i}>{text.slice(s, e)}</mark>)
    at = e
  })
  out.push(text.slice(at))
  return <>{out}</>
}

export function SearchScreen() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const recentSearches = useUi((s) => s.recentSearches)
  const activePageId = useStore((s) => s.activePageId)
  const tree = useStore((s) => s.workspace.tree)
  const input = useRef<HTMLInputElement>(null)

  const close = () => useUi.setState({ screen: null })
  useEffect(() => onBack(() => (close(), true)), [])
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!q.trim()) {
      setHits([])
      return
    }
    setBusy(true)
    let stale = false
    const t = setTimeout(async () => {
      const r = await storage.search(q)
      if (!stale) {
        setHits(r)
        setBusy(false)
      }
    }, 140)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [q])

  // "This section": pages that share the open page's section.
  const sectionPages = useMemo(() => {
    if (!activePageId) return null
    const path = pathTo(tree, activePageId)
    const section = [...path].reverse().find((n: any) => n.kind === 'section')
    if (!section) return null
    const ids = new Set<string>()
    const walk = (ns: any[]) => ns.forEach((n) => (n.kind === 'page' && ids.add(n.id), walk(n.children || [])))
    walk(section.children)
    return { ids, title: section.title as string }
  }, [activePageId, tree])

  const shown = useMemo(() => {
    let r = hits.filter((h) => !h.archived)
    if (filter === 'titles') r = r.filter((h) => h.matchedIn.includes('title'))
    if (filter === 'here' && sectionPages) r = r.filter((h) => sectionPages.ids.has(h.pageId))
    return r
  }, [hits, filter, sectionPages])

  const remember = (text: string) => {
    const t = text.trim()
    if (!t) return
    useUi.getState().setPrefs({ recentSearches: [t, ...recentSearches.filter((x) => x !== t)].slice(0, 8) })
  }

  const open = async (h: SearchHit, cellId?: string) => {
    remember(q)
    close()
    const target = cellId || h.hits[0]?.cellId
    await useStore.getState().openPage(h.pageId)
    if (target) useUi.setState({ flash: { pageId: h.pageId, cellId: target, query: q } })
  }

  const hint = !busy && q.trim() && !shown.length ? suggestion(q, hits) : null
  const info = useMemo(() => pageIndex(tree), [tree])
  const pathOf = (h: SearchHit) => (info.get(h.pageId)?.path || []).join(' / ')

  return (
    <div className="m-screen" role="dialog" aria-label="Search">
      <div className="m-screen-head">
        <button className="m-icon" aria-label="Back" onClick={close}>
          <ArrowLeft />
        </button>
        <input
          ref={input}
          className="m-search-input"
          placeholder="Search all notes"
          value={q}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              remember(q)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {q && (
          <button className="m-icon" aria-label="Clear" onClick={() => (setQ(''), input.current?.focus())}>
            <X />
          </button>
        )}
      </div>
      {q.trim() && (
        <div className="m-filters">
          <button className={`m-chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            Everywhere
          </button>
          {sectionPages && (
            <button className={`m-chip ${filter === 'here' ? 'on' : ''}`} onClick={() => setFilter('here')}>
              In {sectionPages.title}
            </button>
          )}
          <button className={`m-chip ${filter === 'titles' ? 'on' : ''}`} onClick={() => setFilter('titles')}>
            Titles
          </button>
          <span className="m-chip" style={{ border: 'none', background: 'none' }}>
            {busy ? 'Searching...' : `${shown.length} page${shown.length === 1 ? '' : 's'}`}
          </span>
        </div>
      )}
      <div className="m-screen-body">
        {!q.trim() && (
          <>
            {recentSearches.length > 0 && <div className="m-label">Recent searches</div>}
            {recentSearches.map((r) => (
              <button key={r} className="m-row" onClick={() => setQ(r)}>
                <span className="ic">
                  <Clock />
                </span>
                <span className="t">{r}</span>
              </button>
            ))}
            <div className="m-hint">
              Typos are forgiven. Use "quotes" for an exact phrase and -word to leave a word out.
            </div>
          </>
        )}
        {shown.map((h) => (
          <div key={h.pageId} className="m-result">
            <button style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => open(h)}>
              <div className="rp">{pathOf(h)}</div>
              <div className="rt">
                <Marked text={h.title || 'Untitled'} marks={h.titleMarks as any} />
              </div>
            </button>
            {h.hits.slice(0, 3).map((c) => (
              <button key={c.cellId} className="rs" onClick={() => open(h, c.cellId)}>
                {c.cellTitle && (
                  <b>
                    <Marked text={c.cellTitle} marks={c.titleMarks as any} />
                    {': '}
                  </b>
                )}
                <Marked text={c.snippet} marks={c.marks as any} />
              </button>
            ))}
            {h.hits.length > 3 && <div className="rp" style={{ marginTop: 6 }}>and {h.hits.length - 3} more in this page</div>}
          </div>
        ))}
        {hint && (
          <button className="m-hint" style={{ width: '100%' }} onClick={() => setQ(hint)}>
            Nothing found. Did you mean <b style={{ color: 'var(--accent)' }}>{hint}</b>?
          </button>
        )}
        {!busy && q.trim() && !shown.length && !hint && <div className="m-hint">Nothing found.</div>}
      </div>
    </div>
  )
}
