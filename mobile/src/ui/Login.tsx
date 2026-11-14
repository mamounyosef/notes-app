/** Sign in (once), and the first download of the notes. */
import React, { useState } from 'react'
import { create } from 'zustand'
import { Book } from '../../../src/components/Icons'
import { useStore } from '../../../src/store'
import { config } from '../config'
import { cloud } from '../sync/backend'
import { createRemote, type Remote } from '../sync/remote'
import * as idb from '../sync/idb'
import * as assets from '../sync/assets'
import { useCloud } from './SyncDot'
import { demoAllowed, inDemo, seedDemo } from '../demo'

let remote: Remote | null = null
export function getRemote(): Remote {
  remote ??= createRemote(config.supabaseUrl, config.supabaseKey)
  return remote
}

interface SessionState {
  phase: 'checking' | 'signed-out' | 'signed-in'
  email: string
}
export const useSession = create<SessionState>(() => ({ phase: 'checking', email: '' }))

/** At start: an existing sign in goes straight to the notes, even offline. */
export async function restoreSession() {
  if (inDemo()) {
    useSession.setState({ phase: 'signed-in', email: 'demo' })
    return
  }
  const r = getRemote()
  let s = null
  try {
    s = await r.session()
  } catch {
    /* offline: the stored session is still read from local storage */
  }
  if (s) {
    useSession.setState({ phase: 'signed-in', email: s.email })
    cloud.setRemote(r)
  } else {
    // Notes already on the phone open even when the session is gone.
    const hasNotes = Boolean(await idb.get('docs', 'workspace:'))
    useSession.setState({ phase: hasNotes ? 'signed-in' : 'signed-out', email: '' })
  }
}

export async function signOut(removeNotes: boolean) {
  await getRemote().signOut()
  cloud.setRemote(null)
  if (removeNotes) {
    await idb.clearAll()
    await assets.clear()
    localStorage.removeItem('notes:local:mobile')
    location.reload()
    return
  }
  await cloud.reset()
  useSession.setState({ phase: 'signed-out', email: '' })
}

export function LoginScreen() {
  const [email, setEmail] = useState(() => localStorage.getItem('notes:last-email') || '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true)
    setError('')
    try {
      const s = await getRemote().signIn(email.trim(), password)
      localStorage.setItem('notes:last-email', email.trim())
      useSession.setState({ phase: 'signed-in', email: s?.email || email })
      cloud.setRemote(getRemote())
    } catch (err: any) {
      const msg = String(err?.message || err)
      setError(/invalid/i.test(msg) ? 'Wrong email or password.' : navigator.onLine ? msg : 'No internet connection.')
    } finally {
      setBusy(false)
      setPassword('')
    }
  }

  return (
    <div className="m-center" style={{ paddingBottom: 'calc(24px + var(--kb))' }}>
      <div className="m-logo">
        <Book />
      </div>
      <h1>Notes</h1>
      <p>Sign in with the same account your computers use for cloud sync. You only do this once.</p>
      <form className="m-login" onSubmit={submit}>
        <input className="m-field" type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          className="m-field"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="m-error">{error}</div>}
        <button className="m-btn primary" type="submit" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        {demoAllowed && (
          <button
            type="button"
            className="m-btn"
            onClick={async () => {
              await seedDemo()
              location.reload()
            }}
          >
            Try with demo notes (test build)
          </button>
        )}
      </form>
    </div>
  )
}

/** Shown until the first download of the notes is done. */
export function FirstSync() {
  const s = useCloud()
  const ready = useStore((st) => st.ready)
  return (
    <div className="m-center">
      <div className="m-logo">
        <Book />
      </div>
      <h1>Getting your notes</h1>
      <p>
        {s.phase === 'offline'
          ? 'Waiting for an internet connection...'
          : s.phase === 'error'
            ? s.lastError
            : s.received
              ? `${s.received} notes received...`
              : ready
                ? 'Almost there...'
                : 'Connecting...'}
      </p>
      <div className="m-progress">
        <i />
      </div>
    </div>
  )
}
