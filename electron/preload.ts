// electron/preload.ts
// Exposes a safe IPC bridge to renderer for native notifications + deep links

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// bridge:// links from the main process. The preload exists from document start,
// the web app subscribes only after it boots: links arriving in between are held
// here (bounded) and replayed on subscription instead of being lost.
const MAX_PENDING_DEEP_LINKS = 10;
const pendingDeepLinks: string[] = [];
let deepLinkListener: ((url: string) => void) | null = null;
ipcRenderer.on('desktop:deeplink', (_: IpcRendererEvent, url: unknown) => {
  if (typeof url !== 'string') return;
  if (deepLinkListener) deepLinkListener(url);
  else if (pendingDeepLinks.length < MAX_PENDING_DEEP_LINKS) pendingDeepLinks.push(url);
});

contextBridge.exposeInMainWorld('electronBridge', {
  onDeepLink: (cb: (url: string) => void): (() => void) => {
    deepLinkListener = cb;
    for (const url of pendingDeepLinks.splice(0)) cb(url);
    return () => { if (deepLinkListener === cb) deepLinkListener = null; };
  },

  // Send a native OS notification via main process
  notify: (title: string, body: string): void =>
    ipcRenderer.send('bridge:notify', { title, body }),

  // Listen for tray notification toggle
  onNotificationsToggle: (cb: (enabled: boolean) => void): void => {
    ipcRenderer.on('tray:notifications-toggle', (_: IpcRendererEvent, enabled: boolean) => cb(enabled));
  },
  onOpenSurface: (cb: (surface: 'voice-check' | 'system-health') => void): (() => void) => {
    const listener = (_: IpcRendererEvent, surface: 'voice-check' | 'system-health'): void => cb(surface);
    ipcRenderer.on('tray:open-surface', listener);
    return () => ipcRenderer.removeListener('tray:open-surface', listener);
  },
});

// (Final21 Phase 12) The `serverControl` API is gone: the desktop app no longer
// starts a bundled server; it connects to one (see main.ts / desktopSettings.ts).

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
