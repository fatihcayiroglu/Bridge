// electron/preload.ts
// Exposes a safe IPC bridge to renderer for native notifications + deep links

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronBridge', {
  // Send a native OS notification via main process
  notify: (title: string, body: string): void =>
    ipcRenderer.send('bridge:notify', { title, body }),

  // Listen for tray notification toggle
  onNotificationsToggle: (cb: (enabled: boolean) => void): void => {
    ipcRenderer.on('tray:notifications-toggle', (_: IpcRendererEvent, enabled: boolean) => cb(enabled));
  },
});

// Sunucu kontrol API'si
export interface ServerStatusData {
  status: 'stopped' | 'starting' | 'running' | 'error';
  pid: number | null;
}
export interface ServerLogEntry {
  t: number;
  level: 'info' | 'error';
  line: string;
}

contextBridge.exposeInMainWorld('serverControl', {
  start:     (): void  => ipcRenderer.send('server:start'),
  stop:      (): void  => ipcRenderer.send('server:stop'),
  restart:   (): void  => ipcRenderer.send('server:restart'),
  getStatus: (): Promise<ServerStatusData & { logs: ServerLogEntry[] }> =>
    ipcRenderer.invoke('server:getStatus') as Promise<ServerStatusData & { logs: ServerLogEntry[] }>,
  onStatus:  (cb: (data: ServerStatusData) => void): void => {
    ipcRenderer.on('server:status', (_: IpcRendererEvent, data: ServerStatusData) => cb(data));
  },
  onLog:     (cb: (data: ServerLogEntry) => void): void => {
    ipcRenderer.on('server:log', (_: IpcRendererEvent, data: ServerLogEntry) => cb(data));
  },
  offStatus: (cb: (...args: unknown[]) => void): void => {
    ipcRenderer.removeListener('server:status', cb);
  },
  offLog:    (cb: (...args: unknown[]) => void): void => {
    ipcRenderer.removeListener('server:log', cb);
  },
});

// Otomatik güncelleme API'si
export interface BridgeUpdateState {
  phase:
    | 'idle'
    | 'disabled'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  releaseName: string | null;
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  canInstall: boolean;
  isPackaged: boolean;
}

contextBridge.exposeInMainWorld('bridgeUpdater', {
  getStatus: (): Promise<BridgeUpdateState> =>
    ipcRenderer.invoke('updater:getStatus') as Promise<BridgeUpdateState>,
  check: (): Promise<BridgeUpdateState> =>
    ipcRenderer.invoke('updater:check') as Promise<BridgeUpdateState>,
  install: (): Promise<BridgeUpdateState> =>
    ipcRenderer.invoke('updater:install') as Promise<BridgeUpdateState>,
  onStatus: (cb: (data: BridgeUpdateState) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, data: BridgeUpdateState): void => cb(data);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
});
