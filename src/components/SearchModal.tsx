import React, { useEffect, useRef, useState } from 'react'
import { pathTo, useStore } from '../store'
import { storage, type SearchHit } from '../lib/storage'
import { suggestion } from '../../shared/search-core.mjs'
import { Archive, Search } from './Icons'

/** One row the arrow keys move through: a page, or one of its cells. */
interface Row {
  pageId: string
  cellId?: string
}

export default function SearchModal({ onClose }: { onClose(): void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)
  const workspace = useStore((s) => s.workspace)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      const my = ++seq.current
      // Make sure unsaved edits on the open page are searchable too.
      const st = useStore.getState()
      if (st.dirty) await st.save()
      const r = await storage.search(q)
      if (my !== seq.current) return // a newer query is on its way
      setResults(r)
      setActive(0)
      setSearching(false)
    }, 120)
    return () => clearTimeout(t)
  }, [q])

  // Every page, then each of its cells, so arrows can reach a specific cell.
  const rows: Row[] = results.flatMap((r) => [{ pageId: r.pageId }, ...r.hits.map((h) => ({ pageId: r.pageId, cellId: h.cellId }))])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = async (pageId: string, cellId?: string) => {
    await useStore.getState().openPage(pageId)
    useStore.getState().setSearchResult(cellId ? { cellId, query: q } : null)
    onClose()
  }

  const partial = results.length > 0 && results.every((r) => r.partial)
  // Words no result found at all, and a corrected query when the best hits were only near matches.
  const missingAll = partial ? results[0].missing.filter((m) => results.every((r) => r.missing.includes(m))) : []
  const fix = !searching ? suggestion(q, results) : null
  let rowIndex = -1

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search-modal">
        <div className="modal-head">
          <Search />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search pages, notebooks and cells"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              if (e.key === 'Enter' && rows[active]) {
                const r = rows[active]
                const page = results.find((x) => x.pageId === r.pageId)
                open(r.pageId, r.cellId ?? page?.hits[0]?.cellId)
              }
              if (e.key === 'Escape') onClose()
            }}
          />
          {q.trim() && <span className="search-count">{searching ? 'Searching...' : `${results.length} ${results.length === 1 ? 'page' : 'pages'}`}</span>}
        </div>
        <div className="modal-body" ref={listRef}>
          {!q.trim() && (
            <div className="empty-hint search-help">
              Type to search titles, notebooks, sections, cell titles and text. Small typos are forgiven, word starts match
              ("grad" finds gradient), and <code>"quotes"</code> match an exact phrase.
            </div>
          )}
          {q.trim() && !searching && results.length === 0 && <div className="empty-hint">Nothing found for "{q}".</div>}
          {fix && (
            <button className="search-note suggest" onClick={() => setQ(fix)}>
              Showing close spellings. Did you mean <strong>{fix}</strong>?
            </button>
          )}
          {partial && (
            <div className="search-note">
              No page has every word{missingAll.length ? <> (nothing matched <strong>{missingAll.join(', ')}</strong>)</> : ''}. Closest pages:
            </div>
          )}
          {results.map((r) => {
            const pageRow = ++rowIndex
            return (
              <div key={r.pageId} className="result-group">
                <div
                  className={`result ${pageRow === active ? 'active' : ''}`}
                  data-active={pageRow === active}
                  onMouseEnter={() => setActive(pageRow)}
                  onClick={() => open(r.pageId, r.hits[0]?.cellId)}
                >
                  <div className="r-title">
                    <Marked text={r.title || 'Untitled'} marks={r.titleMarks} />
                    {r.archived && <span className="r-badge"><Archive size={11} /> Archived</span>}
                  </div>
                  <div className="r-path">{pathTo(workspace.tree, r.pageId).slice(0, -1).map((n) => n.title).join('  /  ')}</div>
                  <MatchInfo r={r} />
                </div>
                {r.hits.map((h) => {
                  const i = ++rowIndex
                  return (
                    <div
                      key={h.cellId}
                      className={`r-snip ${i === active ? 'active' : ''}`}
                      data-active={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => open(r.pageId, h.cellId)}
                    >
                      {h.cellTitle && (
                        <strong>
                          <Marked text={h.cellTitle} marks={h.titleMarks} />:{' '}
                        </strong>
                      )}
                      <Marked text={h.snippet} marks={h.marks} />
                      {h.near.length > 0 && <span className="r-near" title="Spelled differently from your search">near match</span>}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="search-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

/** One line on how a page matched: where, which words were close spellings, which were missing. */
function MatchInfo({ r }: { r: SearchHit }) {
  const parts: React.ReactNode[] = []
  if (r.near.length)
    parts.push(
      <span key="near" className="mi near">
        Near match:{' '}
        {r.near.map((n, i) => (
          <React.Fragment key={n.term}>
            {i > 0 && ', '}
            <s>{n.term}</s> → <b>{n.word}</b>
          </React.Fragment>
        ))}
      </span>,
    )
  if (r.missing.length)
    parts.push(
      <span key="miss" className="mi miss">
        Missing: {r.missing.join(', ')}
      </span>,
    )
  if (!parts.length && r.matchedIn.length) {
    const where = r.matchedIn.map((w) => (w === 'title' ? 'page title' : w === 'notebook' ? 'notebook or section name' : 'cells'))
    parts.push(
      <span key="in" className="mi">
        Found in {where.join(', ')}
      </span>,
    )
  }
  return parts.length ? <div className="r-info">{parts}</div> : null
}

/** Text with the matched ranges highlighted (ranges come from the search engine, so typos highlight too). */
function Marked({ text, marks }: { text: string; marks?: [number, number][] }) {
  if (!marks?.length) return <>{text}</>
  const out: React.ReactNode[] = []
  let at = 0
  marks.forEach(([a, b], k) => {
    if (a < at || a >= text.length) return
    out.push(text.slice(at, a), <mark key={k}>{text.slice(a, b)}</mark>)
    at = b
  })
  out.push(text.slice(at))
  return <>{out}</>
}
