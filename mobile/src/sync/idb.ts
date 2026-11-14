/**
 * A tiny promise wrapper around IndexedDB: the phone's offline copy of the notes.
 *
 * Stores:
 *  - docs:  "page:<id>" | "workspace:" | "settings:"  ->  the note JSON
 *  - trash: deleted pages, kept a while just in case
 *  - meta:  small bookkeeping (cloud sync state, device id)
 */
const DB_NAME = 'notes-mobile'
const VERSION = 1
const STORES = ['docs', 'trash', 'meta'] as const
export type StoreName = (typeof STORES)[number]

let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab or an app update asked for a newer version: let go.
      db.onversionchange = () => {
        db.close()
        dbp = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbp = null
      reject(req.error)
    }
  })
  return dbp
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function get<T = any>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open()
  return done(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>
}

export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).put(value, key)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function del(store: StoreName, key: string): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).delete(key)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function keys(store: StoreName): Promise<string[]> {
  const db = await open()
  return (await done(db.transaction(store, 'readonly').objectStore(store).getAllKeys())) as string[]
}

/** Every [key, value] pair of a store (one read transaction). */
export async function entries<T = any>(store: StoreName): Promise<[string, T][]> {
  const db = await open()
  const os = db.transaction(store, 'readonly').objectStore(store)
  const [ks, vs] = await Promise.all([done(os.getAllKeys()), done(os.getAll())])
  return (ks as string[]).map((k, i) => [k, vs[i] as T])
}

/** Wipes everything (sign out with "remove notes from this phone"). */
export async function clearAll(): Promise<void> {
  const db = await open()
  const tx = db.transaction([...STORES], 'readwrite')
  for (const s of STORES) tx.objectStore(s).clear()
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Asks the browser not to evict our data under storage pressure. */
export async function persist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
