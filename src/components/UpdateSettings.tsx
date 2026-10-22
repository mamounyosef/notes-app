/**
 * Settings, Update: what is new since this build, and a button that updates
 * the app (setup.bat runs hidden: Notes closes, rebuilds and opens again).
 */
import React, { useEffect, useState } from 'react'
import { askConfirm } from '../lib/confirm'

type Commit = { hash: string; subject: string; date: string }
type Last = { at: number; result: 'ok' | 'failed' | 'unknown'; tail: string } | null
type Check = { ok: boolean; error?: string; current?: Commit; behind?: number; commits?: Commit[]; canRun?: boolean; last?: Last }

const desk = (window as any).notes
const when = (d: string | number) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function UpdateSettings() {
  const [info, setInfo] = useState<Check | null>(null)
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [msg, setMsg] = useState('')

  const check = async () => {
    if (!desk?.update) return setInfo({ ok: false, error: 'Updating works in the desktop app.' })
    setChecking(true)
    setInfo(await desk.update.check())
    setChecking(false)
  }
  useEffect(() => {
    check()
  }, [])

  const run = async () => {
    if (!(await askConfirm('Notes will close, update and open again by itself in a few minutes. Your notes are saved first.', 'Update now'))) return
    setStarting(true)
    const r = await desk.update.run()
    if (!r.ok) {
      setStarting(false)
      setMsg(r.error || 'Could not start the update.')
    } else setMsg('Updating. Notes will close in a moment and open again when it is done.')
  }

  const last = info?.last
  const behind = info?.behind ?? 0
  return (
    <div className="set-group">
      <h3>Update</h3>
      <div className="set-row">
        <label>
          {checking ? 'Checking for updates...' : !info ? '' : !info.ok ? 'Cannot check for updates' : behind ? `${behind} new change${behind > 1 ? 's' : ''} ready` : 'Up to date'}
          <span className="sub">
            {info?.ok && info.current ? `This version: ${info.current.subject} (${when(info.current.date)}).` : info?.error || ''}
          </span>
        </label>
        <div className="row-inline">
          <button className="btn" disabled={checking || starting} onClick={check}>Check again</button>
          {info?.ok && info.canRun && (
            <button className={`btn ${behind ? 'primary' : ''}`} disabled={checking || starting} onClick={run} title="Runs setup.bat in the background">
              {starting ? 'Updating...' : behind ? 'Update now' : 'Rebuild anyway'}
            </button>
          )}
        </div>
      </div>
      {behind > 0 && (
        <ul className="upd-list">
          {info!.commits!.map((c) => (
            <li key={c.hash}>
              {c.subject} <span>{when(c.date)}</span>
            </li>
          ))}
        </ul>
      )}
      {msg && <div className="empty-hint" style={{ padding: '4px 0' }}>{msg}</div>}
      {last && (
        <div className="set-row">
          <label>
            Last update: {last.result === 'ok' ? 'finished' : last.result === 'failed' ? 'failed' : 'did not finish'} ({when(last.at)})
            {last.result !== 'ok' && <span className="sub" style={{ whiteSpace: 'pre-wrap' }}>{last.tail}</span>}
          </label>
          <div className="row-inline">
            <button className="btn" onClick={() => desk?.update?.openLog()}>Open log</button>
          </div>
        </div>
      )}
      <div className="empty-hint" style={{ padding: '6px 0' }}>
        Same as running setup.bat, but in the background: it gets the latest version, closes Notes, builds it and opens it again.
      </div>
    </div>
  )
}
