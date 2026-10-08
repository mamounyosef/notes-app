import { contextBridge, ipcRenderer } from 'electron'

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
  asset: {
    save: (dataUrl: string) => ipcRenderer.invoke('asset:save', dataUrl) as Promise<string | null>,
    import: (filePath: string) => ipcRenderer.invoke('asset:import', filePath) as Promise<string | null>,
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
}

contextBridge.exposeInMainWorld('notes', api)

export type NotesApi = typeof api
