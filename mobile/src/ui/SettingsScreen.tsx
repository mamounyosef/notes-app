/** Settings: account and sync, updates, look, pages, pictures. */
import React, { useEffect, useState } from 'react'
import { ArrowLeft, SyncI, Download, Power } from '../../../src/components/Icons'
import { useStore } from '../../../src/store'
import { cloud, vault } from '../sync/backend'
import * as assets from '../sync/assets'
import * as idb from '../sync/idb'
import { useUpdate } from '../update/updater'
import { config } from '../config'
import { onBack } from '../platform'
import { askConfirm, showSheet, toast } from './overlays'
import { useUi } from './state'
import { ago, statusText, useCloud } from './SyncDot'
import { signOut } from './Login'

const THEMES: { id: string; label: string; bg: string; fg: string }[] = [
  { id: '', label: 'Computer', bg: 'linear-gradient(135deg,#202020 50%,#f4f4f4 50%)', fg: '' },
  { id: 'dark', label: 'Dark', bg: '#1f1f1f', fg: '' },
  { id: 'light', label: 'Light', bg: '#ffffff', fg: '' },
  { id: 'sepia', label: 'Sepia', bg: '#fbf5e9', fg: '' },
  { id: 'midnight', label: 'Midnight', bg: '#0f151d', fg: '' },
  { id: 'nord', label: 'Nord', bg: '#2b313c', fg: '' },
  { id: 'system', label: 'Phone', bg: 'linear-gradient(135deg,#0f151d 50%,#ffffff 50%)', fg: '' },
]

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function fmtDate(t: number | string) {
  const d = new Date(t)
  if (!t || isNaN(d.getTime())) return 'never'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "2026.11.14-231005" as a readable date. */
function versionDate(v: string) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})(\d{2})/.exec(v || '')
  if (!m) return v
  return fmtDate(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime())
}

function Switch({ on }: { on: boolean }) {
  return <span className={`m-switch ${on ? 'on' : ''}`} />
}

export function SettingsScreen() {
  const ui = useUi()
  const s = useCloud()
  const dirty = useStore((st) => st.dirty)
  const conflicts = useStore((st) => st.conflicts)
  const up = useUpdate()
  const [imgs, setImgs] = useState(assets.localBytes())
  const [busy, setBusy] = useState('')
  const close = () => useUi.setState({ screen: null })
  useEffect(() => onBack(() => (close(), true)), [])
  useEffect(() => {
    useStore.getState().refreshConflicts()
    const off = vault.on((ev) => ev.type === 'asset' && setImgs(assets.localBytes()))
    return () => void off()
  }, [])

  const downloadAll = async () => {
    setBusy('images')
    const list = await cloud.missingImages()
    let n = 0
    for (const p of list) {
      if (await cloud.download(p)) n++
    }
    setBusy('')
    setImgs(assets.localBytes())
    toast(list.length ? `${n} of ${list.length} pictures saved on the phone` : 'All pictures are already on the phone')
  }

  return (
    <div className="m-screen" role="dialog" aria-label="Settings">
      <div className="m-screen-head">
        <button className="m-icon" aria-label="Back" onClick={close}>
          <ArrowLeft />
        </button>
        <h2>Settings</h2>
      </div>
      <div className="m-screen-body">
        {/* ---------- account ---------- */}
        <div className="m-group-title">Account and sync</div>
        <div className="m-group">
          <div className="m-set">
            <div className="grow">
              <div>{s.email || 'Not signed in'}</div>
              <small>{statusText(s, dirty)}</small>
            </div>
          </div>
          <div className="m-set">
            <div className="grow">
              <div>Last synced</div>
              <small>{s.lastSyncAt ? `${ago(s.lastSyncAt)} (${fmtDate(s.lastSyncAt)})` : 'never'}</small>
            </div>
            <button
              className="m-btn"
              disabled={s.phase === 'syncing'}
              onClick={async () => {
                await cloud.syncNow()
                const st = cloud.status()
                toast(st.phase === 'idle' ? 'All synced' : statusText(st, false))
              }}
            >
              <SyncI /> {s.phase === 'syncing' ? 'Syncing' : 'Sync now'}
            </button>
          </div>
          {(conflicts.cells.length > 0 || conflicts.orphans.length > 0) && (
            <button
              className="m-set"
              onClick={() =>
                showSheet({
                  title: 'Kept in two versions (pick one on each)',
                  items: [
                    ...conflicts.cells.map((c) => ({
                      label: `${c.pageTitle}: ${c.cellTitle}`,
                      onClick: () => {
                        close()
                        useStore.getState().showConflict(c.pageId, c.cellId)
                      },
                    })),
                    ...conflicts.orphans.map((o) => ({
                      label: `Restore page "${o.title}" (deleted elsewhere, edited here)`,
                      onClick: () => useStore.getState().restoreOrphan(o.pageId, o.title),
                    })),
                  ],
                })
              }
            >
              <div className="grow">
                <div>{conflicts.cells.length + conflicts.orphans.length} item(s) need a look</div>
                <small>Edited on two devices at once. Nothing was lost.</small>
              </div>
            </button>
          )}
          <button
            className="m-set"
            onClick={() =>
              showSheet({
                title: 'Sign out',
                items: [
                  { label: 'Sign out, keep notes on this phone', icon: <Power />, onClick: () => signOut(false) },
                  {
                    label: 'Sign out and remove notes from this phone',
                    icon: <Power />,
                    danger: true,
                    onClick: () =>
                      askConfirm({
                        title: 'Remove the notes from this phone?',
                        body: 'They stay safe in the cloud and on your computers. Changes not synced yet are lost.',
                        ok: 'Remove',
                        danger: true,
                        onOk: () => signOut(true),
                      }),
                  },
                ],
              })
            }
          >
            <div className="grow">
              <div style={{ color: '#f85149' }}>Sign out</div>
            </div>
          </button>
        </div>

        {/* ---------- updates ---------- */}
        <div className="m-group-title">Updates</div>
        <div className="m-group">
          {up.latestApk && (
            <div className="m-set">
              <div className="grow">
                <div>New app version {up.latestApk.versionName}</div>
                <small>{up.latestApk.notes || 'A new version of the Android app.'} Android asks you to confirm the install.</small>
              </div>
              <button className="m-btn primary" disabled={up.progress > 0} onClick={() => up.installApk().catch((e) => toast(`Could not download: ${e?.message || e}`))}>
                <Download /> {up.progress > 0 ? 'Downloading' : 'Install'}
              </button>
            </div>
          )}
          {up.ready && (
            <div className="m-set">
              <div className="grow">
                <div>Update ready</div>
                <small>
                  {up.ready.notes ? `${up.ready.notes}. ` : ''}Published {versionDate(up.ready.version)}. Applies the next time Notes opens.
                </small>
              </div>
              <button className="m-btn primary" onClick={() => up.restartNow()}>
                Restart now
              </button>
            </div>
          )}
          <div className="m-set">
            <div className="grow">
              <div>Version</div>
              <small>
                Notes {versionDate(up.running)}
                {up.nativeName ? `, app ${up.nativeName} (${up.nativeVersion})` : ''}
              </small>
            </div>
          </div>
          <div className="m-set">
            <div className="grow">
              <div>Last updated</div>
              <small>{up.appliedAt ? `${fmtDate(up.appliedAt)} (to the version published ${versionDate(up.running)})` : `Installed version, published ${versionDate(up.running)}`}</small>
            </div>
          </div>
          <div className="m-set">
            <div className="grow">
              <div>Last checked</div>
              <small>{up.lastCheckAt ? `${ago(up.lastCheckAt)}${up.lastCheckError ? `. Problem: ${up.lastCheckError}` : '. Up to date' + (up.ready ? ' (update waiting)' : '')}` : 'never'}</small>
            </div>
            <button
              className="m-btn"
              disabled={up.checking}
              onClick={async () => {
                await up.check(true)
                const st = useUpdate.getState()
                toast(st.lastCheckError ? `Could not check: ${st.lastCheckError}` : st.ready ? 'Update downloaded' : st.latestApk ? 'A new app version is available' : 'Notes is up to date')
              }}
            >
              {up.checking ? 'Checking' : 'Check now'}
            </button>
          </div>
          <button className="m-set" onClick={() => up.setAuto(!up.auto)}>
            <div className="grow">
              <div>Update automatically</div>
              <small>Downloads updates in the background and applies them the next time Notes opens.</small>
            </div>
            <Switch on={up.auto} />
          </button>
        </div>

        {/* ---------- look ---------- */}
        <div className="m-group-title">Look</div>
        <div className="m-group">
          <div className="m-theme-chips">
            {THEMES.map((t) => (
              <button key={t.id || 'pc'} className={`m-theme-chip ${ui.theme === t.id ? 'on' : ''}`} onClick={() => ui.setPrefs({ theme: t.id })}>
                <i style={{ background: t.bg }} />
                {t.label}
              </button>
            ))}
          </div>
          <div className="m-set">
            <div className="grow">
              <div>Text size</div>
              <small>{Math.round(ui.textScale * 100)}% of the computer's size</small>
            </div>
            <div className="m-seg">
              {[0.9, 1, 1.1, 1.25].map((k) => (
                <button key={k} className={Math.abs(ui.textScale - k) < 0.01 ? 'on' : ''} onClick={() => ui.setPrefs({ textScale: k })}>
                  {k === 0.9 ? 'S' : k === 1 ? 'M' : k === 1.1 ? 'L' : 'XL'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ---------- pages ---------- */}
        <div className="m-group-title">Pages</div>
        <div className="m-group">
          <div className="m-set">
            <div className="grow">
              <div>Open pages as</div>
              <small>Flow: cells stacked, easy to read and type. Page: laid out like the computer, pinch to zoom.</small>
            </div>
            <div className="m-seg">
              <button className={ui.defaultView === 'flow' ? 'on' : ''} onClick={() => ui.setPrefs({ defaultView: 'flow', pageViews: {} })}>
                Flow
              </button>
              <button className={ui.defaultView === 'canvas' ? 'on' : ''} onClick={() => ui.setPrefs({ defaultView: 'canvas', pageViews: {} })}>
                Page
              </button>
            </div>
          </div>
          <button className="m-set" onClick={() => ui.setPrefs({ swipePages: !ui.swipePages })}>
            <div className="grow">
              <div>Swipe between pages</div>
              <small>In flow view, swipe left or right for the next or previous page of the section.</small>
            </div>
            <Switch on={ui.swipePages} />
          </button>
        </div>

        {/* ---------- pictures ---------- */}
        <div className="m-group-title">Pictures and storage</div>
        <div className="m-group">
          <div className="m-set">
            <div className="grow">
              <div>On this phone</div>
              <small>
                {imgs.count} pictures, {fmtBytes(imgs.bytes)}. In the cloud: {fmtBytes(cloud.cloudImageBytes())}.
              </small>
            </div>
          </div>
          <button className="m-set" onClick={() => ui.setPrefs({ keepImagesOffline: !ui.keepImagesOffline })}>
            <div className="grow">
              <div>Keep all pictures offline</div>
              <small>Saves every picture on the phone in the background (on Wi-Fi). Off: pictures download when a page shows them.</small>
            </div>
            <Switch on={ui.keepImagesOffline} />
          </button>
          <div className="m-set">
            <div className="grow">
              <div>Download all pictures now</div>
            </div>
            <button className="m-btn" disabled={Boolean(busy)} onClick={downloadAll}>
              {busy === 'images' ? 'Downloading' : 'Download'}
            </button>
          </div>
          <div className="m-set">
            <div className="grow">
              <div>Free up space</div>
              <small>Removes pictures from the phone. They stay in the cloud and come back when needed.</small>
            </div>
            <button
              className="m-btn danger"
              onClick={() =>
                askConfirm({
                  title: 'Remove pictures from this phone?',
                  body: 'Pictures not uploaded yet are kept.',
                  ok: 'Remove',
                  danger: true,
                  onOk: async () => {
                    const keep = Object.keys((cloud as any).state.outbox || {})
                    if (keep.length) return toast('Some new pictures are not uploaded yet. Try again after a sync.')
                    await assets.clear()
                    setImgs(assets.localBytes())
                    toast('Pictures removed from the phone')
                  },
                })
              }
            >
              Remove
            </button>
          </div>
        </div>

        <div className="m-hint">
          Notes for Android. Device {vault.device}. Built {fmtDate(config.builtAt)}.
          <br />
          Ask Claude about your notes from the Claude app on your phone (the Notes connector), while your computer is on.
        </div>
        <button className="m-hint" style={{ width: '100%', fontSize: 12 }} onClick={async () => toast(`${(await idb.keys('docs')).length} notes stored on the phone`)}>
          Storage details
        </button>
      </div>
    </div>
  )
}
