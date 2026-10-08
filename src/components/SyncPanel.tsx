import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { storage, type SyncStatus } from '../lib/storage'
import { askConfirm } from '../lib/confirm'
import { X } from './Icons'

/**
 * Everything sync needs a decision on: cells kept in two versions, cells
 * deleted on one computer but edited on the other, and pages whose tree entry
 * was deleted elsewhere while they were edited here.
 */
export default function SyncPanel({ onClose }: { onClose(): void }) {
  const conflicts = useStore((s) => s.conflicts)
  const syncError = useStore((s) => s.syncError)
  const activePageId = useStore((s) => s.activePageId)
  const st = useStore.getState
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    storage.syncStatus().then(setStatus).catch(() => {})
  }, [conflicts])

  const checkNow = async () => {
    setChecking(true)
    try {
      await storage.scanNow()
      await st().refreshConflicts()
      setStatus(await storage.syncStatus())
    } finally {
      setChecking(false)
    }
  }

  // Group the cells by page.
  const byPage = new Map<string, { title: string; cells: typeof conflicts.cells }>()
  for (const c of conflicts.cells) {
    if (!byPage.has(c.pageId)) byPage.set(c.pageId, { title: c.pageTitle, cells: [] })
    byPage.get(c.pageId)!.cells.push(c)
  }
  const nothing = conflicts.cells.length === 0 && conflicts.orphans.length === 0

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sync-panel">
        <div className="modal-head">
          <h2>Sync</h2>
          <div className="spacer" />
          <button className="btn" disabled={checking} onClick={checkNow}>{checking ? 'Checking...' : 'Check now'}</button>
          <button className="tb-btn" onClick={onClose}><X /></button>
        </div>
        <div className="modal-body">
          {syncError && <div className="sync-error">{syncError}</div>}

          {nothing && (
            <div className="empty-hint" style={{ padding: '10px 0' }}>
              Nothing needs your attention. Changes from your other computers show up here by themselves.
            </div>
          )}

          {[...byPage].map(([pageId, group]) => (
            <div key={pageId} className="sync-group">
              <div className="sync-group-head">{group.title}</div>
              {group.cells.map((c) => {
                const here = activePageId === pageId
                return (
                  <div key={c.cellId} className="sync-item">
                    <div className="sync-item-text">
                      <div className="sync-item-title">{c.cellTitle}</div>
                      <div className="sync-item-sub">
                        {c.reason === 'deleted-elsewhere'
                          ? 'Deleted on the other computer, edited here. Kept for now.'
                          : 'Edited on both computers. Both versions were kept.'}
                      </div>
                    </div>
                    <button
                      className="btn"
                      onClick={() => {
                        st().showConflict(pageId, c.cellId)
                        onClose()
                      }}
                    >
                      Show
                    </button>
                    {here &&
                      (c.reason === 'deleted-elsewhere' ? (
                        <>
                          <button className="btn" onClick={() => st().resolveConflict(c.cellId, 'keep')}>Keep</button>
                          <button className="btn danger" onClick={() => st().resolveConflict(c.cellId, 'delete')}>Delete</button>
                        </>
                      ) : (
                        <>
                          <button className="btn" title="Replace the original cell with this version" onClick={() => st().resolveConflict(c.cellId, 'use-this')}>Use this</button>
                          <button className="btn" onClick={() => st().resolveConflict(c.cellId, 'keep-both')}>Keep both</button>
                          <button className="btn danger" title="Delete this version, keep the original" onClick={() => st().resolveConflict(c.cellId, 'discard')}>Discard</button>
                        </>
                      ))}
                  </div>
                )
              })}
            </div>
          ))}

          {conflicts.orphans.length > 0 && (
            <div className="sync-group">
              <div className="sync-group-head">Pages not in any notebook</div>
              <div className="empty-hint" style={{ padding: '0 0 6px' }}>
                Deleted on another computer while they still had changes here.
              </div>
              {conflicts.orphans.map((o) => (
                <div key={o.pageId} className="sync-item">
                  <div className="sync-item-text">
                    <div className="sync-item-title">{o.title}</div>
                  </div>
                  <button className="btn primary" onClick={() => st().restoreOrphan(o.pageId, o.title)}>Restore</button>
                  <button
                    className="btn danger"
                    onClick={async () => {
                      if (await askConfirm(`Delete "${o.title}"? It moves to the .trash folder.`, 'Delete')) st().discardOrphan(o.pageId)
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

          {status && (
            <div className="sync-status">
              {status.watching ? 'Watching the notes folder, and checking it' : 'Checking the notes folder'}
              {` every ${Math.round(status.pollMs / 1000)} seconds.`}
              {status.lastRemoteAt > 0 && ` Last change from another computer: ${new Date(status.lastRemoteAt).toLocaleString()}.`}
              <br />
              This computer's sync id: {status.deviceId}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
