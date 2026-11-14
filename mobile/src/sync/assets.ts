/**
 * Pictures on the phone: files in the app's private storage, named exactly
 * like on the computer (assets/<sha1 prefix>.<ext>).
 *
 * Pages keep `asset://local/<name>` links (as on the computer). While a page
 * is on screen, those links point at the file through Capacitor's local web
 * server instead (see `toDisplay` / `toStored`), the same trick the browser
 * build uses with /media/.
 */
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import * as idb from './idb'

const DIR = 'vault/assets'
const STORED = 'asset://local/'
const native = Capacitor.isNativePlatform()

/** The URL prefix pictures are shown from on this phone (set by init). */
let display = STORED
const sizes = new Map<string, number>()
const present = new Set<string>()

export async function init() {
  if (!native) return
  try {
    await Filesystem.mkdir({ path: DIR, directory: Directory.Data, recursive: true })
  } catch {
    /* already there */
  }
  const { uri } = await Filesystem.getUri({ path: DIR, directory: Directory.Data })
  display = Capacitor.convertFileSrc(uri.endsWith('/') ? uri : uri + '/')
  try {
    const { files } = await Filesystem.readdir({ path: DIR, directory: Directory.Data })
    for (const f of files) {
      present.add(f.name)
      if (f.size) sizes.set(f.name, f.size)
    }
  } catch {
    /* empty */
  }
}

export const displayPrefix = () => display

/** Stored form (asset://local/...) to what an <img> on this phone can load. */
export function toDisplay<T>(value: T): T {
  if (display === STORED) return value
  return JSON.parse(JSON.stringify(value).split(STORED).join(display))
}

/** What the screen shows back to the stored form, before saving. */
export function toStored<T>(value: T): T {
  if (display === STORED) return value
  return JSON.parse(JSON.stringify(value).split(display).join(STORED))
}

/** Picture names a page refers to. */
export function namesIn(html: string): string[] {
  const out = new Set<string>()
  const re = /asset:\/\/local\/([A-Za-z0-9._-]+)/g
  let m
  while ((m = re.exec(html))) out.add(m[1])
  if (display !== STORED) {
    const esc = display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re2 = new RegExp(esc + '([A-Za-z0-9._-]+)', 'g')
    while ((m = re2.exec(html))) out.add(m[1])
  }
  return [...out]
}

export async function has(name: string): Promise<boolean> {
  if (present.has(name)) return true
  if (!native) return Boolean(await idb.get('meta', `asset:${name}`))
  try {
    const st = await Filesystem.stat({ path: `${DIR}/${name}`, directory: Directory.Data })
    present.add(name)
    sizes.set(name, st.size)
    return true
  } catch {
    return false
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export async function write(name: string, bytes: Uint8Array) {
  if (!native) {
    await idb.put('meta', `asset:${name}`, bytes)
  } else {
    // Written under a temporary name first, so a half written picture never shows.
    const tmp = `${DIR}/.${name}.part`
    await Filesystem.writeFile({ path: tmp, data: toBase64(bytes), directory: Directory.Data, recursive: true })
    await Filesystem.rename({ from: tmp, to: `${DIR}/${name}`, directory: Directory.Data, toDirectory: Directory.Data })
  }
  present.add(name)
  sizes.set(name, bytes.length)
}

export async function read(name: string): Promise<Uint8Array | null> {
  try {
    if (!native) return (await idb.get<Uint8Array>('meta', `asset:${name}`)) || null
    const r = await Filesystem.readFile({ path: `${DIR}/${name}`, directory: Directory.Data })
    if (typeof r.data === 'string') return fromBase64(r.data)
    return new Uint8Array(await (r.data as Blob).arrayBuffer())
  } catch {
    return null
  }
}

export const sizeHint = (name: string) => sizes.get(name) || 0

export async function sha1(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha1Of(name: string): Promise<string | null> {
  const b = await read(name)
  return b ? sha1(b) : null
}

/** Bytes of all pictures kept on this phone. */
export function localBytes() {
  let n = 0
  for (const v of sizes.values()) n += v
  return { count: present.size, bytes: n }
}

/** Removes every picture from the phone (they stay in the cloud). */
export async function clear() {
  if (native) {
    try {
      await Filesystem.rmdir({ path: DIR, directory: Directory.Data, recursive: true })
      await Filesystem.mkdir({ path: DIR, directory: Directory.Data, recursive: true })
    } catch {
      /* nothing there */
    }
  }
  present.clear()
  sizes.clear()
}

/**
 * Saves picture bytes the way the computer does (named by content) and
 * returns its stored link and full sha1 (what the cloud keys it by).
 */
export async function save(bytes: Uint8Array, ext: string): Promise<{ name: string; sha: string; stored: string; shown: string }> {
  const sha = await sha1(bytes)
  const clean = (ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png'
  const name = `${sha.slice(0, 20)}.${clean}`
  if (!(await has(name))) await write(name, bytes)
  return { name, sha, stored: STORED + name, shown: display + name }
}

export { fromBase64, toBase64 }
