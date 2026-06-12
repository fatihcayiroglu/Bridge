// electron/tests/__mocks__/electron.ts
// require('electron') yerine Jest'in kullandığı tam mock.

'use strict';

// ── Event Emitter tabanı ──────────────────────────────────────────────────────
class MockEmitter {
  protected _listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  on(event: string, cb: (...args: unknown[]) => void): this {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  }
  once(event: string, cb: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.removeListener(event, wrapper);
      cb(...args);
    };
    return this.on(event, wrapper);
  }
  removeListener(event: string, cb: (...args: unknown[]) => void): this {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter((l) => l !== cb);
    }
    return this;
  }
  emit(event: string, ...args: unknown[]): this {
    (this._listeners[event] || []).forEach((l) => l(...args));
    return this;
  }
}

// ── ipcMain ───────────────────────────────────────────────────────────────────
const _ipcMainHandlers: Record<string, (...args: unknown[]) => unknown> = {};
const _ipcMainListeners: Record<string, (...args: unknown[]) => unknown> = {};

const ipcMain = {
  on: jest.fn((channel: string, handler: (...args: unknown[]) => void) => {
    _ipcMainListeners[channel] = handler;
  }),
  handle: jest.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    _ipcMainHandlers[channel] = handler;
  }),
  removeHandler: jest.fn((channel: string) => {
    delete _ipcMainHandlers[channel];
  }),
  _trigger: (channel: string, event: unknown, ...args: unknown[]): void => {
    if (_ipcMainListeners[channel]) _ipcMainListeners[channel](event, ...args);
  },
  _invoke: async (channel: string, event: unknown, ...args: unknown[]): Promise<unknown> => {
    if (_ipcMainHandlers[channel]) return _ipcMainHandlers[channel](event, ...args);
    throw new Error(`No handler for channel: ${channel}`);
  },
};

// ── webContents ───────────────────────────────────────────────────────────────
const makeWebContents = () => ({
  send: jest.fn(),
  executeJavaScript: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  zoomFactor: 1,
  toggleDevTools: jest.fn(),
});

// ── BrowserWindow ──────────────────────────────────────────────────────────────
class BrowserWindow extends MockEmitter {
  webContents = makeWebContents();
  id = Math.random();

  loadURL     = jest.fn().mockResolvedValue(undefined);
  loadFile    = jest.fn().mockResolvedValue(undefined);
  show        = jest.fn();
  hide        = jest.fn();
  focus       = jest.fn();
  restore     = jest.fn();
  reload      = jest.fn();
  isMinimized = jest.fn().mockReturnValue(false);
  isVisible   = jest.fn().mockReturnValue(true);
  isDestroyed = jest.fn().mockReturnValue(false);
  close       = jest.fn();
  setProgressBar  = jest.fn();
  displayBalloon  = jest.fn();

  static getAllWindows = jest.fn().mockReturnValue([]);
  static fromId       = jest.fn();
}

// ── Notification ───────────────────────────────────────────────────────────────
const Notification = jest.fn(function Notification(this: any) {
  this.on = jest.fn();
  this.show = jest.fn();
  this.close = jest.fn();
}) as any;
Notification.isSupported = jest.fn().mockReturnValue(true);

// ── Tray ───────────────────────────────────────────────────────────────────────
class Tray extends MockEmitter {
  setToolTip      = jest.fn();
  setContextMenu  = jest.fn();
  displayBalloon  = jest.fn();
  destroy         = jest.fn();
}

// ── Menu ───────────────────────────────────────────────────────────────────────
class Menu {
  static buildFromTemplate = jest.fn((tpl: unknown) => ({ items: tpl }));
  static setApplicationMenu = jest.fn();
}

// ── nativeImage ────────────────────────────────────────────────────────────────
const nativeImage = {
  createFromDataURL : jest.fn().mockReturnValue({ resize: jest.fn().mockReturnValue({}) }),
  createFromPath    : jest.fn().mockReturnValue({ resize: jest.fn().mockReturnValue({}) }),
  createEmpty       : jest.fn().mockReturnValue({}),
};

// ── app ────────────────────────────────────────────────────────────────────────
const app = new MockEmitter() as any;
Object.assign(app, {
  getPath                  : jest.fn((name: string) => `/mock/${name}`),
  getVersion               : jest.fn().mockReturnValue('45.0.0'),
  getName                  : jest.fn().mockReturnValue('Bridge'),
  quit                     : jest.fn(),
  isQuitting               : false,
  isPackaged               : false,
  requestSingleInstanceLock: jest.fn().mockReturnValue(true),
  setAsDefaultProtocolClient: jest.fn(),
  disableHardwareAcceleration: jest.fn(),
  whenReady                : jest.fn().mockResolvedValue(undefined),
  isReady                  : jest.fn().mockReturnValue(true),
});

// ── shell ──────────────────────────────────────────────────────────────────────
const shell = {
  openExternal : jest.fn().mockResolvedValue(undefined),
  openPath     : jest.fn().mockResolvedValue(''),
};

// ── session ────────────────────────────────────────────────────────────────────
const session = {
  defaultSession: {
    setPermissionRequestHandler: jest.fn(),
    webRequest: { onHeadersReceived: jest.fn() },
  },
};

// ── contextBridge (preload.ts için) ────────────────────────────────────────────
const _exposedApis: Record<string, unknown> = {};
const contextBridge = {
  exposeInMainWorld: jest.fn((key: string, api: unknown) => {
    _exposedApis[key] = api;
  }),
  _getExposed: (key: string): unknown => _exposedApis[key],
};

// ── ipcRenderer (preload.ts için) ──────────────────────────────────────────────
const _ipcRendererListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
const ipcRenderer = {
  send   : jest.fn(),
  invoke : jest.fn().mockResolvedValue(undefined),
  on     : jest.fn((channel: string, cb: (...args: unknown[]) => void) => {
    (_ipcRendererListeners[channel] = _ipcRendererListeners[channel] || []).push(cb);
  }),
  removeListener: jest.fn((channel: string, cb: (...args: unknown[]) => void) => {
    if (_ipcRendererListeners[channel]) {
      _ipcRendererListeners[channel] = _ipcRendererListeners[channel].filter((l) => l !== cb);
    }
  }),
  _trigger: (channel: string, ...args: unknown[]): void => {
    (_ipcRendererListeners[channel] || []).forEach((l) => l({}, ...args));
  },
};

// ── Export ─────────────────────────────────────────────────────────────────────
module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  contextBridge,
  Tray,
  Notification,
  nativeImage,
  Menu,
  shell,
  session,
  _ipcMainListeners,
  _ipcMainHandlers,
  _ipcRendererListeners,
  _exposedApis,
};

export {};
