declare namespace Electron {
  interface Event { preventDefault(): void; }
  interface NativeImage { resize(opts: { width?: number; height?: number }): NativeImage; }
  interface MenuItem { checked?: boolean; }
  interface IpcMainEvent {}
  interface IpcRendererEvent {}
}

declare namespace NodeJS { interface Process { defaultApp?: boolean; } }

declare module 'electron' {
  export const app: {
    setAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean;
    requestSingleInstanceLock(): boolean;
    quit(): void;
    on(event: string, listener: (...args: any[]) => void): void;
    whenReady(): Promise<void>;
    dock?: { hide(): void };
    isQuitting?: boolean;
    isPackaged: boolean;
    getVersion(): string;
  };
  export class BrowserWindow {
    static getAllWindows(): BrowserWindow[];
    constructor(opts?: Record<string, unknown>);
    webContents: {
      executeJavaScript(script: string): Promise<unknown>;
      send(channel: string, ...args: unknown[]): void;
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
      toggleDevTools(): void;
      zoomFactor: number;
      isDestroyed?(): boolean;
    };
    loadURL(url: string): Promise<void>;
    once(event: string, listener: (...args: any[]) => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
    show(): void;
    hide(): void;
    focus(): void;
    restore(): void;
    reload(): void;
    isMinimized(): boolean;
    isVisible(): boolean;
  }
  export const shell: { openExternal(url: string): Promise<void> | void };
  export const Menu: { buildFromTemplate(tpl: Array<Record<string, unknown>>): unknown; setApplicationMenu(menu: unknown): void };
  export class Tray {
    constructor(image: Electron.NativeImage);
    setToolTip(text: string): void;
    setContextMenu(menu: unknown): void;
    on(event: string, listener: (...args: any[]) => void): void;
    displayBalloon?(opts: { title: string; content: string }): void;
    destroy(): void;
  }
  export class Notification {
    constructor(opts: { title: string; body: string; silent?: boolean });
    static isSupported(): boolean;
    on(event: string, listener: (...args: any[]) => void): void;
    show(): void;
  }
  export const nativeImage: { createFromPath(path: string): Electron.NativeImage; createEmpty(): Electron.NativeImage };
  export const session: {
    defaultSession: {
      webRequest: { onHeadersReceived(handler: (details: { responseHeaders?: Record<string, string[]> }, callback: (response: { responseHeaders?: Record<string, string[]> }) => void) => void): void };
      setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void;
    };
  };
  export const ipcMain: { on(channel: string, handler: (...args: any[]) => void): void; handle(channel: string, handler: (...args: any[]) => unknown): void };
  export const contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  export const ipcRenderer: { send(channel: string, ...args: unknown[]): void; invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>; on(channel: string, listener: (...args: any[]) => void): void; removeListener(channel: string, listener: (...args: any[]) => void): void };
  export type IpcRendererEvent = Electron.IpcRendererEvent;
}

declare module 'electron-updater' {
  export const autoUpdater: {
    checkForUpdates(): Promise<unknown>;
    checkForUpdatesAndNotify(): Promise<unknown>;
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
    logger: unknown;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowPrerelease: boolean;
    on(event: string, listener: (...args: any[]) => void): void;
  };
}
