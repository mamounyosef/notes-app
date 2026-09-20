import React, { useEffect, useMemo, useRef, useState } from 'react'
import { pathTo, useStore } from '../store'
import { storage, type SearchHit } from '../lib/storage'
import { Search } from './Icons'

export default function SearchModal({ onClose }: { onClose(): void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const workspace = useStore((s) => s.workspace)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) {
        setResults([])
        return
      }
      // Make sure unsaved edits on the open page are searchable too.
      const st = useStore.getState()
      if (st.dirty) await st.save()
      setResults(await storage.search(q))
      setActive(0)
    }, 140)
    return () => clearTimeout(t)
  }, [q])

  const titleMatches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const out: { id: string; title: string }[] = []
    const walkAll = (nodes: typeof workspace.tree) => {
      for (const n of nodes) {
        if (n.kind === 'page' && n.title.toLowerCase().includes(needle)) out.push({ id: n.id, title: n.title })
        walkAll(n.children)
      }
    }
    walkAll(workspace.tree)
    return out.slice(0, 6)
  }, [q, workspace.tree])

  const open = async (pageId: string, cellId?: string) => {
    await useStore.getState().openPage(pageId)
    if (cellId) {
      useStore.getState().setSearchResult({ cellId, query: q })
    } else {
      useStore.getState().setSearchResult(null)
    }
    onClose()
  }

  const flat = [
    ...titleMatches.map((t) => ({ kind: 'title' as const, pageId: t.id, title: t.title })),
    ...results.map((r) => ({ kind: 'body' as const, ...r })),
  ]

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <Search />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search every page and cell"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              if (e.key === 'Enter' && flat[active]) {
                const r = flat[active]
                open(r.pageId, r.kind === 'body' && r.hits.length > 0 ? r.hits[0].cellId : undefined)
              }
              if (e.key === 'Escape') onClose()
            }}
          />
        </div>
        <div className="modal-body">
          {!q.trim() && <div className="empty-hint">Type to search titles, cell titles and cell text across all notebooks.</div>}
          {q.trim() && flat.length === 0 && <div className="empty-hint">Nothing found for "{q}".</div>}
          {flat.map((r, i) => (
            <div
              key={`${r.kind}-${r.pageId}-${i}`}
              className={`result ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => open(r.pageId, r.kind === 'body' && r.hits.length > 0 ? r.hits[0].cellId : undefined)}
            >
              <div className="r-title">{r.title || 'Untitled'}</div>
              <div className="r-path">{pathTo(workspace.tree, r.pageId).map((n) => n.title).join('  /  ')}</div>
              {r.kind === 'body' &&
                r.hits.map((h, j) => (
                  <div className="r-snip" key={j}>
                    {h.cellTitle && <strong>{h.cellTitle}: </strong>}
                    <Highlighted text={h.snippet} needle={q} />
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Highlighted({ text, needle }: { text: string; needle: string }) {
  const i = text.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  )
}
