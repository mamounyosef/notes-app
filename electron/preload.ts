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
    write: (data: unknown) => ipcRenderer.invoke('workspace:write', data),
  },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (data: unknown) => ipcRenderer.invoke('settings:write', data),
  },
  page: {
    read: (id: string) => ipcRenderer.invoke('page:read', id),
    write: (id: string, data: unknown) => ipcRenderer.invoke('page:write', id, data),
    remove: (id: string) => ipcRenderer.invoke('page:delete', id),
  },
  asset: {
    save: (dataUrl: string) => ipcRenderer.invoke('asset:save', dataUrl) as Promise<string | null>,
    import: (filePath: string) => ipcRenderer.invoke('asset:import', filePath) as Promise<string | null>,
  },
  search: (query: string) => ipcRenderer.invoke('search:all', query),
  exportFile: (name: string, content: string) => ipcRenderer.invoke('export:file', name, content),
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
}

contextBridge.exposeInMainWorld('notes', api)

export type NotesApi = typeof api
