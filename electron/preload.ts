import { contextBridge, ipcRenderer } from 'electron'
type WidgetShot = { ok: boolean; png?: string; width?: number; height?: number; errors?: string[]; lint?: string[]; done?: boolean; error?: string }

const api = {
  isDesktop: true,
  vault: {
    get: () => ipcRenderer.invoke('vault:get') as Promise<string>,
    choose: () => ipcRenderer.invoke('vault:choose') as Promise<string | null>,
    reveal: () => ipcRenderer.invoke('vault:reveal'),
  },
  workspace: {
    read: () => ipcRenderer.invoke('workspace:read'),
    write: (data: unknown, base: unknown) => ipcRenderer.invoke('workspace:write', data, base),
  },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (data: unknown, base: unknown) => ipcRenderer.invoke('settings:write', data, base),
  },
  page: {
    read: (id: string) => ipcRenderer.invoke('page:read', id),
    write: (id: string, data: unknown, base: unknown, touched: unknown) => ipcRenderer.invoke('page:write', id, data, base, touched),
    remove: (id: string) => ipcRenderer.invoke('page:delete', id),
  },
  local: {
    read: () => ipcRenderer.invoke('local:read'),
    write: (data: unknown) => ipcRenderer.invoke('local:write', data),
  },
  sync: {
    conflicts: () => ipcRenderer.invoke('sync:conflicts'),
    scan: () => ipcRenderer.invoke('sync:scan'),
    status: () => ipcRenderer.invoke('sync:status'),
    /** Changes another computer made to the notes folder. Returns an unsubscribe. */
    onEvent: (cb: (ev: unknown) => void) => {
      const fn = (_e: unknown, ev: unknown) => cb(ev)
      ipcRenderer.on('vault:event', fn)
      return () => ipcRenderer.removeListener('vault:event', fn)
    },
  },
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    signIn: (url: string, key: string, email: string, password: string) =>
      ipcRenderer.invoke('cloud:signIn', url, key, email, password) as Promise<{ ok: boolean; error?: string }>,
    signOut: () => ipcRenderer.invoke('cloud:signOut'),
    syncNow: () => ipcRenderer.invoke('cloud:syncNow'),
    /** Cloud sync state changes. Returns an unsubscribe. */
    onStatus: (cb: (s: unknown) => void) => {
      const fn = (_e: unknown, s: unknown) => cb(s)
      ipcRenderer.on('cloud:status', fn)
      return () => ipcRenderer.removeListener('cloud:status', fn)
    },
  },
  asset: {
    save: (dataUrl: string) => ipcRenderer.invoke('asset:save', dataUrl) as Promise<string | null>,
    import: (filePath: string) => ipcRenderer.invoke('asset:import', filePath) as Promise<string | null>,
  },
  artifacts: {
    list: (subDir?: string, recursive?: boolean) =>
      ipcRenderer.invoke('artifacts:list', subDir, recursive) as Promise<{ name: string; isDirectory: boolean; relativePath: string }[]>,
    pickFile: (subDir?: string) =>
      ipcRenderer.invoke('artifacts:pickFile', subDir) as Promise<{ relativePath: string; name: string; isDirectory: boolean } | null>,
    pickDirectory: (subDir?: string) =>
      ipcRenderer.invoke('artifacts:pickDirectory', subDir) as Promise<{ relativePath: string; name: string; isDirectory: boolean } | null>,
    reveal: (relativePath?: string) => ipcRenderer.invoke('artifacts:reveal', relativePath) as Promise<void>,
  },
  search: (query: string) => ipcRenderer.invoke('search:all', query),
  exportFile: (name: string, content: string) => ipcRenderer.invoke('export:file', name, content),
  openExternal: (url: string) => ipcRenderer.invoke('open:external', url) as Promise<void>,
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile') as Promise<string | null>,
  confirm: (message: string, okLabel?: string) => ipcRenderer.invoke('dialog:confirm', message, okLabel) as Promise<boolean>,
  /** The window asks the page to write everything pending before it closes. */
  onFlushRequest: (fn: () => Promise<void>) => {
    ipcRenderer.on('app:flush', async () => {
      try {
        await fn()
      } finally {
        ipcRenderer.send('app:flushed')
      }
    })
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    run: () => ipcRenderer.invoke('update:run') as Promise<{ ok: boolean; error?: string }>,
    openLog: () => ipcRenderer.invoke('update:openLog'),
  },
  agent: {
    keyStatus: (provider?: string) =>
      ipcRenderer.invoke('agent:keyStatus', provider) as Promise<{ hasKey: boolean; masked: string; keys: { masked: string; outUntil: number | null; detail: string; inUse: boolean }[] }>,
    setKey: (key: string, provider?: string) => ipcRenderer.invoke('agent:setKey', key, provider) as Promise<{ ok: boolean; error?: string }>,
    addKey: (key: string, provider: string) => ipcRenderer.invoke('agent:addKey', key, provider) as Promise<{ ok: boolean; error?: string }>,
    removeKey: (provider: string, index: number) => ipcRenderer.invoke('agent:removeKey', provider, index) as Promise<{ ok: boolean; error?: string }>,
    useKey: (provider: string, index: number) => ipcRenderer.invoke('agent:useKey', provider, index) as Promise<{ ok: boolean; error?: string }>,
    testKey: (provider: string, index: number) => ipcRenderer.invoke('agent:testKey', provider, index) as Promise<{ ok: boolean; error?: string; info?: string }>,
    openrouterLimits: (index?: number) => ipcRenderer.invoke('agent:openrouterLimits', index) as Promise<{ ok: boolean; freeUsed?: number | null; freeLimit?: number | null; freeTier?: boolean; error?: string }>,
    chat: (reqId: string, body: unknown) =>
      ipcRenderer.invoke('agent:chat', reqId, body) as Promise<{ ok: boolean; error?: string; aborted?: boolean; switched?: { provider: string; key: number; keys: number; reason: string } }>,
    abort: (reqId: string) => ipcRenderer.invoke('agent:abort', reqId),
    dictate: () => ipcRenderer.invoke('agent:dictate') as Promise<boolean>,
    web: (kind: 'search' | 'fetch', arg: unknown) =>
      ipcRenderer.invoke('agent:web', kind, arg) as Promise<{ ok: boolean; data?: any; error?: string }>,
    complete: (body: unknown) => ipcRenderer.invoke('agent:complete', body) as Promise<{ ok: boolean; content?: string; error?: string; switched?: { provider: string; key: number; keys: number; reason: string } }>,
    renderWidget: (body: { html: string; width?: number }) => ipcRenderer.invoke('agent:renderWidget', body) as Promise<WidgetShot>,
    /** Streamed chunks of a running chat request. Returns an unsubscribe. */
    onChunk: (cb: (reqId: string, chunk: any) => void) => {
      const fn = (_e: unknown, reqId: string, chunk: any) => cb(reqId, chunk)
      ipcRenderer.on('agent:chunk', fn)
      return () => ipcRenderer.removeListener('agent:chunk', fn)
    },
  },
  voice: {
    status: () => ipcRenderer.invoke('voice:status'),
    ensure: () => ipcRenderer.invoke('voice:ensure') as Promise<{ ok: boolean; port?: number; error?: string }>,
    voices: () => ipcRenderer.invoke('voice:voices'),
    warm: () => ipcRenderer.invoke('voice:warm'),
    off: () => ipcRenderer.invoke('voice:off') as Promise<{ ok: boolean }>,
    preview: (body: { voice: string; speed: number; text?: string }) =>
      ipcRenderer.invoke('voice:preview', body) as Promise<{ ok: boolean; wav?: string; error?: string }>,
    chooseEngine: () => ipcRenderer.invoke('voice:chooseEngine') as Promise<{ ok: boolean; engineDir?: string; error?: string; canceled?: boolean }>,
  },
  diagram: {
    render: (kind: string, src: string, theme: unknown) => ipcRenderer.invoke('diagram:render', kind, src, theme) as Promise<{ ok: boolean; svg?: string; error?: string }>,
  },
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    get: (id: string) => ipcRenderer.invoke('chats:get', id),
    put: (chat: unknown) => ipcRenderer.invoke('chats:put', chat),
    remove: (id: string) => ipcRenderer.invoke('chats:remove', id),
    status: () => ipcRenderer.invoke('chats:status'),
    syncNow: () => ipcRenderer.invoke('chats:syncNow'),
    saveBlob: (b64: string) => ipcRenderer.invoke('blob:save', b64) as Promise<string>,
    getBlob: (sha: string) => ipcRenderer.invoke('blob:get', sha) as Promise<string | null>,
    blobToAsset: (sha: string, mime: string) => ipcRenderer.invoke('blob:toAsset', sha, mime) as Promise<string | null>,
    onEvent: (cb: (ev: any) => void) => {
      const fn = (_e: unknown, ev: any) => cb(ev)
      ipcRenderer.on('chats:event', fn)
      return () => ipcRenderer.removeListener('chats:event', fn)
    },
    onStatus: (cb: (s: any) => void) => {
      const fn = (_e: unknown, s: any) => cb(s)
      ipcRenderer.on('chats:status', fn)
      return () => ipcRenderer.removeListener('chats:status', fn)
    },
  },
}

contextBridge.exposeInMainWorld('notes', api)

export type NotesApi = typeof api
