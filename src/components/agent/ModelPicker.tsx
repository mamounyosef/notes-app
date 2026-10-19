import React, { useEffect, useRef, useState } from 'react'
import { useAgent } from '../../agent/store'
import { MODELS, modelInfo, fmtCtx, fmtDate, paramsLabel, type ModelInfo } from '../../agent/models'
import { Check, Chevron, ImageI } from '../Icons'

const money = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`)

function PriceLine({ m }: { m: ModelInfo }) {
  if (!m.price) return <span className="mp-price none">Price not listed</span>
  return (
    <span className="mp-price" title="US dollars per million tokens (ollama.com/pricing)">
      {money(m.price.input)} in · {money(m.price.output)} out <em>/ 1M</em>
    </span>
  )
}

/** Model chooser: name in the composer, details for every model in the menu. */
export default function ModelPicker() {
  const model = useAgent((s) => s.prefs.model)
  const setPrefs = useAgent((s) => s.setPrefs)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const cur = modelInfo(model)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div className="mp" ref={ref}>
      <button
        className={`mp-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        title={`${cur.name}: ${paramsLabel(cur)}, ${fmtCtx(cur.context)} context${cur.released ? `, released ${fmtDate(cur.released)}` : ''}`}
      >
        {cur.name}
        <Chevron size={11} className="mp-chev" />
      </button>
      {open && (
        <div className="mp-pop">
          <div className="mp-head">Model</div>
          {MODELS.map((m) => (
            <button
              key={m.id}
              className={`mp-opt ${m.id === model ? 'sel' : ''}`}
              onClick={() => {
                setPrefs({ model: m.id })
                setOpen(false)
              }}
            >
              <div className="mp-row1">
                <span className="mp-name">{m.name}</span>
                {m.vision && (
                  <span className="mp-tag" title="Can see images">
                    <ImageI size={11} /> vision
                  </span>
                )}
                {m.id === model && <Check size={13} className="mp-check" />}
              </div>
              <div className="mp-row2">
                <span>{paramsLabel(m)}</span>
                <span>{fmtCtx(m.context)} context</span>
                <span>{fmtDate(m.released)}</span>
              </div>
              <div className="mp-row3">
                <PriceLine m={m} />
                {m.note && <span className="mp-note">{m.note}</span>}
              </div>
            </button>
          ))}
          <div className="mp-foot">Prices from ollama.com/pricing. Your plan's monthly credits are used first.</div>
        </div>
      )}
    </div>
  )
}
