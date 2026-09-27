// electron/connectPreload.ts — preload for the local connect page only.
// The Bridge web app never receives this API; it gets preload.ts.

import { contextBridge, ipcRenderer } from 'electron';

export type ConnectResult = { ok: true } | { ok: false; message: string };

export interface ConnectContext {
  locale: string;
  lastOrigin: string | null;
  strings: Record<'connectTitle' | 'connectHelp' | 'connectLabel' | 'connectButton' | 'connecting', string>;
}

contextBridge.exposeInMainWorld('bridgeConnect', {
  getContext: (): Promise<ConnectContext> => ipcRenderer.invoke('desktop:connect-context') as Promise<ConnectContext>,
  connect: (address: string): Promise<ConnectResult> =>
    ipcRenderer.invoke('desktop:connect', String(address ?? '')) as Promise<ConnectResult>,
});
