import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '../shared/types'

/** 渲染进程只获得固定业务接口，不能任意访问文件、网络或 IPC 通道。 */
const bridge: DesktopBridge = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: config => ipcRenderer.invoke('config:save', config),
  translate: request => ipcRenderer.invoke('translation:run', request),
  cancelTranslation: requestId => ipcRenderer.invoke('translation:cancel', requestId),
  testEngine: engine => ipcRenderer.invoke('engine:test', engine),
  showCard: () => ipcRenderer.invoke('window:show-card'),
  openSettings: () => ipcRenderer.invoke('window:settings'),
  hideCard: () => ipcRenderer.invoke('window:hide-card'),
  setAlwaysOnTop: value => ipcRenderer.invoke('window:pin', value),
  setCompactMode: value => ipcRenderer.invoke('window:compact', value),
  copyText: text => ipcRenderer.invoke('clipboard:write', text),
  quit: () => ipcRenderer.invoke('app:quit'),
  onConfigChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, config: Parameters<typeof callback>[0]) => callback(config)
    ipcRenderer.on('config:changed', listener)
    return () => { ipcRenderer.removeListener('config:changed', listener) }
  },
  onCardVisibilityChanged: callback => {
    let disposed = false
    let observed = false
    const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => { observed = true; if (!disposed) callback(visible) }
    ipcRenderer.on('window:visibility', listener)
    void ipcRenderer.invoke('window:is-visible').then(visible => { if (!disposed && !observed) callback(Boolean(visible)) })
    return () => { disposed = true; ipcRenderer.removeListener('window:visibility', listener) }
  },
}
contextBridge.exposeInMainWorld('desktop', bridge)
