/**
 * Updates, two kinds:
 *  - Web updates (almost every change): a zip of the app's web files from
 *    <updateBase>/ota. Downloaded in the background and switched to the next
 *    time the app is reopened, or right away with "Restart now". If a new
 *    version fails to start, the updater rolls back to the last good one on
 *    its own (notifyAppReady never came).
 *  - App updates (rare, when the Android shell changes): a new Notes.apk,
 *    downloaded inside the app and handed to Android's installer.
 */
import { create } from 'zustand'
import { App } from '@capacitor/app'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { FileOpener } from '@capawesome-team/capacitor-file-opener'
import { config } from '../config'
import { native } from '../platform'

const KEY = 'notes:update'
const CHECK_EVERY_MS = 30 * 60_000

export interface Manifest {
  version: string
  minNativeVersion: number
  sha256: string
  size: number
  publishedAt: string
  notes: string
  file: string
}
export interface ApkInfo {
  versionCode: number
  versionName: string
  size: number
  publishedAt: string
  notes: string
}

interface Saved {
  lastCheckAt: number
  lastCheckError: string
  /** The web version running now, and since when. */
  appliedVersion: string
  appliedAt: number
  /** Downloaded and waiting for the next start. */
  ready: { id: string; version: string; notes: string; publishedAt: string } | null
  latestApk: ApkInfo | null
  auto: boolean
}

interface UpdateState extends Saved {
  checking: boolean
  progress: number
  running: string
  nativeVersion: number
  nativeName: string
  check(manual?: boolean): Promise<void>
  restartNow(): Promise<void>
  installApk(): Promise<void>
  setAuto(on: boolean): void
}

function load(): Saved {
  const d: Saved = { lastCheckAt: 0, lastCheckError: '', appliedVersion: config.bundleVersion, appliedAt: 0, ready: null, latestApk: null, auto: true }
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return d
  }
}

function save(s: Saved) {
  const { lastCheckAt, lastCheckError, appliedVersion, appliedAt, ready, latestApk, auto } = s
  try {
    localStorage.setItem(KEY, JSON.stringify({ lastCheckAt, lastCheckError, appliedVersion, appliedAt, ready, latestApk, auto }))
  } catch {
    /* ignore */
  }
}

const headers = () => ({ 'x-notes-app': config.otaToken })
const url = (p: string) => `${config.updateBase.replace(/\/$/, '')}/${p}`

async function getJson<T>(p: string): Promise<T | null> {
  const r = await fetch(url(p), { headers: headers(), cache: 'no-store' })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(r.status === 401 ? 'the update server did not accept this app' : `the update server answered ${r.status}`)
  if (!(r.headers.get('content-type') || '').includes('json')) throw new Error('the update server is not reachable (is the computer on?)')
  return (await r.json()) as T
}

export const useUpdate = create<UpdateState>((set, get) => ({
  ...load(),
  checking: false,
  progress: 0,
  running: config.bundleVersion,
  nativeVersion: config.nativeVersion,
  nativeName: '',

  setAuto(on) {
    set({ auto: on })
    save(get())
  },

  async check(manual = false) {
    if (get().checking) return
    if (!manual && Date.now() - get().lastCheckAt < CHECK_EVERY_MS) return
    set({ checking: true, lastCheckError: '' })
    try {
      const [m, apk] = await Promise.all([getJson<Manifest>('ota/manifest.json'), getJson<ApkInfo>('apk.json').catch(() => null)])
      set({ latestApk: apk && apk.versionCode > get().nativeVersion ? apk : null })
      const running = get().running
      if (m && m.version > running && m.minNativeVersion <= get().nativeVersion && get().ready?.version !== m.version) {
        if (native && (get().auto || manual)) {
          set({ progress: 0 })
          const bundle = await CapacitorUpdater.download({
            url: url(`ota/${m.file}?t=${encodeURIComponent(config.otaToken)}`),
            version: m.version,
            checksum: m.sha256,
          })
          await CapacitorUpdater.next({ id: bundle.id })
          set({ ready: { id: bundle.id, version: m.version, notes: m.notes, publishedAt: m.publishedAt } })
        }
      }
      set({ lastCheckAt: Date.now() })
    } catch (e: any) {
      const msg = String(e?.message || e)
      set({ lastCheckAt: Date.now(), lastCheckError: /fetch|network/i.test(msg) ? 'the update server is not reachable (is the computer on?)' : msg })
    } finally {
      set({ checking: false })
      save(get())
    }
  },

  async restartNow() {
    const r = get().ready
    if (!r || !native) return
    await CapacitorUpdater.set({ id: r.id })
  },

  async installApk() {
    const apk = get().latestApk
    if (!apk || !native) return
    set({ progress: 1 })
    try {
      const path = `Notes-${apk.versionName}.apk`
      await Filesystem.downloadFile({ url: url('notes.apk'), path, directory: Directory.Cache, headers: headers(), progress: false })
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
      await FileOpener.openFile({ path: uri, mimeType: 'application/vnd.android.package-archive' })
    } finally {
      set({ progress: 0 })
    }
  },
}))

/** Called once the app has drawn: tells the updater this version works. */
export async function startUpdater() {
  if (!native) return
  try {
    await CapacitorUpdater.notifyAppReady()
    const info = await App.getInfo()
    const st = useUpdate.getState()
    const nativeVersion = Number(info.build) || config.nativeVersion
    const cur: any = await CapacitorUpdater.current()
    // The built-in bundle reports the native version (1.0.0): use the web version stamped at build.
    const running = cur?.bundle?.id && cur.bundle.id !== 'builtin' && cur.bundle.version ? cur.bundle.version : config.bundleVersion
    const patch: Partial<Saved> & { running: string; nativeVersion: number; nativeName: string } = { running, nativeVersion, nativeName: info.version }
    if (st.appliedVersion !== running) {
      patch.appliedVersion = running
      patch.appliedAt = Date.now()
    }
    if (st.ready && st.ready.version === running) patch.ready = null
    useUpdate.setState(patch)
    save(useUpdate.getState())
  } catch (e) {
    console.warn('updater start', e)
  }
  setTimeout(() => useUpdate.getState().check(), 4000)
}
