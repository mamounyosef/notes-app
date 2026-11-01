import type { Change } from '../../agent/ledger'

/** What an edit really changed (and what the app put back), under its chip in the chat. */
export default function ChangeList({ changes, restored }: { changes?: Change[]; restored?: Change[] }) {
  if (!changes?.length && !restored?.length) return null
  return (
    <div className="ag-changes">
      {(changes || []).map((c, i) => (
        <ChangeLine key={`c${i}`} c={c} />
      ))}
      {(restored || []).map((c, i) => (
        <ChangeLine key={`r${i}`} c={c} kept />
      ))}
    </div>
  )
}

const NAME: Record<string, string> = { fontSize: 'size', fontFamily: 'font', color: 'color', highlight: 'highlight', link: 'link' }
const isColor = (attr?: string) => attr === 'color' || attr === 'highlight'

function Swatch({ v }: { v: string | null }) {
  return <span className={`ag-swatch ${v ? '' : 'none'}`} style={v ? { background: v } : undefined} title={v || 'none'} />
}

function blockName(b: string | null) {
  if (!b) return 'nothing'
  return b
    .split(' > ')
    .map((p) => p.replace(/\(level=(\d)\)/, ' $1').replace(/\(.*\)$/, ''))
    .filter((p) => p !== 'listItem' && p !== 'taskItem')
    .join(' ')
}

function ChangeLine({ c, kept }: { c: Change; kept?: boolean }) {
  const on = c.text ? <span className="ag-change-on">"{c.text}"</span> : null
  let body: React.ReactNode
  if (c.kind === 'text') {
    body = (
      <>
        {c.from && <del>{c.from}</del>}
        {c.from && c.to && <span className="ag-change-arrow">→</span>}
        {c.to && <ins>{c.to}</ins>}
      </>
    )
  } else if (c.kind === 'block') {
    body = (
      <>
        {on} {blockName(c.from)} <span className="ag-change-arrow">→</span> {blockName(c.to)}
      </>
    )
  } else if (kept) {
    // What stayed: the value from before the edit.
    body = isColor(c.attr) ? (
      <>
        {NAME[c.attr!]} <Swatch v={c.from} /> {on}
      </>
    ) : (
      <>
        {NAME[c.attr || ''] || c.attr} {c.from ?? (c.to ? 'off' : '')} {on}
      </>
    )
  } else if (isColor(c.attr)) {
    body = (
      <>
        {NAME[c.attr!]} <Swatch v={c.from} />
        <span className="ag-change-arrow">→</span>
        <Swatch v={c.to} /> {on}
      </>
    )
  } else if (c.attr && !NAME[c.attr]) {
    body = (
      <>
        {c.attr} {c.to ? 'added' : 'removed'} {on}
      </>
    )
  } else {
    body = (
      <>
        {NAME[c.attr || '']} {c.from ?? 'none'} <span className="ag-change-arrow">→</span> {c.to ?? 'none'} {on}
      </>
    )
  }
  return (
    <div
      className={`ag-change ${kept ? 'kept' : ''}`}
      title={kept ? 'The edit would also have changed this, which it was not asked to. The app put it back.' : 'Read back from the note after saving'}
    >
      {kept && <span className="ag-change-tag">Kept</span>}
      {body}
    </div>
  )
}
