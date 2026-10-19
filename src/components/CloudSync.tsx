import React, { useEffect, useState } from 'react'
import { cloud, type CloudStatus } from '../lib/storage'

/** The cloud sync state, kept fresh by events from the main process. */
export function useCloudStatus() {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  useEffect(() => {
    let alive = true
    cloud.status().then((s) => alive && setStatus(s)).catch(() => {})
    const off = cloud.onStatus((s) => setStatus((prev) => ({ ...prev, ...s })))
    return () => {
      alive = false
      off()
    }
  }, [])
  return [status, setStatus] as const
}

export function cloudLine(s: CloudStatus | null) {
  if (!s || !s.signedIn) return 'Not signed in. Notes stay on this computer only.'
  const last = s.lastSyncAt ? ` Last synced ${new Date(s.lastSyncAt).toLocaleString()}.` : ''
  const pending = s.pending > 0 ? ` ${s.pending} waiting to upload.` : ''
  switch (s.phase) {
    case 'syncing':
      return `Syncing...${pending}`
    case 'offline':
      return `Offline. Your changes are saved here and upload when you are back online.${pending}${last}`
    case 'error':
      return `Sync problem: ${s.lastError}.${pending}${last} Retrying by itself.`
    case 'signed-out':
      return 'Signed out. Sign in again to keep syncing.'
    default:
      return `In sync.${pending}${last}`
  }
}

/** Settings > Storage: connect this computer to the Supabase project. */
export function CloudSyncSection() {
  const [status, setStatus] = useCloudStatus()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (status?.url && !url) setUrl(status.url)
    if (status?.key && !key) setKey(status.key)
  }, [status?.url, status?.key])

  if (!cloud.available) return null

  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await cloud.signIn(url, key, email, password)
      if (!r.ok) setError(r.error || 'Could not sign in')
      else {
        setPassword('')
        setStatus(await cloud.status())
      }
    } finally {
      setBusy(false)
    }
  }

  const signedIn = Boolean(status?.signedIn)

  return (
    <>
      <h3>Cloud sync</h3>
      <div className="empty-hint" style={{ padding: '0 0 6px' }}>{cloudLine(status)}</div>
      {signedIn ? (
        <div className="set-row">
          <label>
            Signed in
            <span className="sub">{status?.email}</span>
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" disabled={status?.phase === 'syncing'} onClick={() => cloud.syncNow()}>
              Sync now
            </button>
            <button
              className="btn"
              onClick={async () => {
                await cloud.signOut()
                setStatus(await cloud.status())
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <form
          className="cloud-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy) signIn()
          }}
        >
          <input placeholder="Project URL (https://....supabase.co)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input placeholder="Publishable (anon) key" value={key} onChange={(e) => setKey(e.target.value)} />
          <input placeholder="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="sync-error">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy || !url || !key || !email || !password}>
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      )}
    </>
  )
}
