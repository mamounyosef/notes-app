/** Cloud sync status: a dot on an icon, tap for details and "Sync now". */
import React, { useEffect, useState } from 'react'
import { SyncI } from '../../../src/components/Icons'
import { useStore } from '../../../src/store'
import { cloud } from '../sync/backend'
import type { CloudStatus } from '../sync/cloud'
import { showSheet, toast } from './overlays'
import { useUi } from './state'

export function useCloud(): CloudStatus {
  const [s, setS] = useState<CloudStatus>(cloud.status())
  useEffect(() => {
    const off = cloud.onStatus(setS)
    return () => void off()
  }, [])
  return s
}

export function ago(t: number): string {
  if (!t) return 'never'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function statusText(s: CloudStatus, dirty: boolean): string {
  if (s.phase === 'off' || s.phase === 'signed-out') return 'Not signed in'
  if (s.phase === 'syncing') return 'Syncing...'
  if (s.phase === 'offline') return s.pending || dirty ? `Offline: ${s.pending} change${s.pending === 1 ? '' : 's'} saved on the phone` : 'Offline, all changes saved on the phone'
  if (s.phase === 'error') return s.lastError || 'Sync problem'
  if (s.pending || dirty) return 'Saving...'
  return `Synced ${ago(s.lastSyncAt)}`
}

export function SyncDot({ asButton }: { asButton?: boolean }) {
  const s = useCloud()
  const dirty = useStore((st) => st.dirty)
  const conflicts = useStore((st) => st.conflicts.cells.length + st.conflicts.orphans.length)
  const cls = s.phase === 'idle' && (s.pending || dirty) ? 'pending' : s.phase === 'off' ? 'signed-out' : s.phase

  const open = () => {
    showSheet({
      title: statusText(s, dirty),
      items: [
        {
          label: 'Sync now',
          icon: <SyncI />,
          onClick: async () => {
            await cloud.syncNow()
            const st = cloud.status()
            toast(st.phase === 'idle' ? 'All synced' : statusText(st, false))
          },
        },
        ...(conflicts
          ? [
              {
                label: `${conflicts} item${conflicts === 1 ? '' : 's'} kept in two versions`,
                icon: <SyncI />,
                onClick: () => useUi.setState({ screen: 'settings' }),
              },
            ]
          : []),
      ],
    })
  }

  if (!asButton) return <span className={`m-sync-dot ${cls}`} />
  return (
    <button className="m-icon" aria-label={statusText(s, dirty)} onClick={open}>
      <SyncI />
      <span className={`m-sync-dot ${cls}`} />
    </button>
  )
}
