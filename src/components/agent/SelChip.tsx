import React, { useMemo } from 'react'
import katex from 'katex'
import type { PickedNode, SentSelection } from '../../agent/api'
import { goToSelection } from '../../agent/selection'
import { X } from '../Icons'

/** A small picture of what is selected: the image itself, or the equation drawn by KaTeX. */
function Preview({ node }: { node?: PickedNode }) {
  const math = useMemo(() => {
    if (node?.type !== 'math' || !node.latex) return ''
    try {
      return katex.renderToString(node.latex, { throwOnError: false, displayMode: false, output: 'html' })
    } catch {
      return ''
    }
  }, [node?.type, node?.latex])
  if (node?.type === 'image' && node.src) return <img className="ag-sel-thumb" src={node.src} alt="" draggable={false} />
  if (math) return <span className="ag-sel-math" dangerouslySetInnerHTML={{ __html: math }} />
  return <span className={`ag-sel-dot ${node ? node.type : ''}`} />
}

const tip = (s: Pick<SentSelection, 'text' | 'cellTitle'>, go: boolean) =>
  `${s.cellTitle ? `In "${s.cellTitle}": ` : ''}${s.text.slice(0, 600)}${go ? '\n\nClick to go there' : ''}`

/**
 * What is selected in the notes, beside the model name (live) or on a sent
 * message. Either way a click glides the page to exactly that spot and marks it.
 */
export default function SelChip({ sel, sent, onDismiss }: { sel: SentSelection; sent?: boolean; onDismiss?(): void }) {
  const go = Boolean(sel.cellIds.length)
  const label = sent && sel.cellTitle && sel.kind !== 'cells' ? `${sel.label} in "${sel.cellTitle}"` : sel.label
  return (
    <span className={`ag-sel ${sent ? 'sent' : ''} ${sel.node ? `has-${sel.node.type}` : ''}`}>
      <button className="ag-sel-go" title={tip(sel, go)} disabled={!go} onClick={() => go && void goToSelection(sel)}>
        <Preview node={sel.node} />
        <span className="ag-sel-label">{label}</span>
      </button>
      {onDismiss && (
        <button className="ag-sel-x" aria-label="Do not send the selection" title="Don't include this selection" onClick={onDismiss}>
          <X size={11} />
        </button>
      )}
    </span>
  )
}
