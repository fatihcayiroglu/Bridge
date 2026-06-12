// electron/tests/__mocks__/electron.js
//
// require('electron') yerine Jest'in kullandığı tam mock.
// Ana süreç API'lerini (main.js) ve renderer API'lerini (preload.js) kapsar.
//
// Kullanılan API'ler:
//   main.js    → app, BrowserWindow, ipcMain, Tray, Notification, nativeImage,
//                Menu, shell, session
//   preload.js → contextBridge, ipcRenderer

'use strict';

// ── Event Emitter tabanı ────────────────────────────────────────────────────
// Her Electron nesnesinin `.on()` / `.emit()` / `.once()` desteği olması gerekir.
class MockEmitter {
  constructor() {
    this._listeners = {};
  }
  on(event, cb) {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  }
  once(event, cb) {
    const wrapper = (...args) => { this.removeListener(event, wrapper); cb(...args); };
    return this.on(event, wrapper);
  }
  removeListener(event, cb) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(l => l !== cb);
    }
    return this;
  }
  emit(event, ...args) {
    (this._listeners[event] || []).forEach(l => l(...args));
    return this;
  }
}

// ── ipcMain ─────────────────────────────────────────────────────────────────
const _ipcMainHandlers = {};
const _ipcMainListeners = {};

const ipcMain = {
  on: jest.fn((channel, handler) => {
    _ipcMainListeners[channel] = handler;
  }),
  handle: jest.fn((channel, handler) => {
    _ipcMainHandlers[channel] = handler;
  }),
  removeHandler: jest.fn((channel) => {
    delete _ipcMainHandlers[channel];
  }),
  // Test yardımcısı: bir IPC mesajı tetiklemek için
  _trigger: (channel, event, ...args) => {
    if (_ipcMainListeners[channel]) _ipcMainListeners[channel](event, ...args);
  },
  // Test yardımcısı: ipcMain.handle() ile kayıtlı handler'ı çağırmak için
  _invoke: async (channel, event, ...args) => {
    if (_ipcMainHandlers[channel]) return _ipcMainHandlers[channel](event, ...args);
    throw new Error(`No handler for channel: ${channel}`);
  },
};

// ── webContents ─────────────────────────────────────────────────────────────
const makeWebContents = () => ({
  send: jest.fn(),
  executeJavaScript: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
});

// ── BrowserWindow ────────────────────────────────────────────────────────────
class BrowserWindow extends MockEmitter {
  constructor(opts = {}) {
    super();
    this._opts = opts;
    this.webContents = makeWebContents();
    this.id = Math.random();
  }
  loadURL     = jest.fn().mockResolvedValue(undefined);
  loadFile    = jest.fn().mockResolvedValue(undefined);
  show        = jest.fn();
  hide        = jest.fn();
  focus       = jest.fn();
  restore     = jest.fn();
  isMinimized = jest.fn().mockReturnValue(false);
  isDestroyed = jest.fn().mockReturnValue(false);
  close       = jest.fn();
  setProgressBar = jest.fn();
  displayBalloon = jest.fn();

  static getAllWindows = jest.fn().mockReturnValue([]);
  static fromId       = jest.fn();
}

// ── Notification ─────────────────────────────────────────────────────────────
class Notification extends MockEmitter {
  constructor(opts = {}) {
    super();
    this._opts = opts;
  }
  show  = jest.fn();
  close = jest.fn();

  static isSupported = jest.fn().mockReturnValue(true);
}

// ── Tray ─────────────────────────────────────────────────────────────────────
class Tray extends MockEmitter {
  constructor(icon) {
    super();
    this._icon = icon;
  }
  setToolTip      = jest.fn();
  setContextMenu  = jest.fn();
  displayBalloon  = jest.fn();
  destroy         = jest.fn();
}

// ── Menu ─────────────────────────────────────────────────────────────────────
class Menu {
  static buildFromTemplate = jest.fn((tpl) => ({ items: tpl }));
  static setApplicationMenu = jest.fn();
}

// ── nativeImage ──────────────────────────────────────────────────────────────
const nativeImage = {
  createFromDataURL : jest.fn().mockReturnValue({}),
  createFromPath    : jest.fn().mockReturnValue({}),
  createEmpty       : jest.fn().mockReturnValue({}),
};

// ── app ──────────────────────────────────────────────────────────────────────
const app = new MockEmitter();
Object.assign(app, {
  getPath                  : jest.fn((name) => `/mock/${name}`),
  getVersion               : jest.fn().mockReturnValue('45.0.0'),
  getName                  : jest.fn().mockReturnValue('Bridge'),
  quit                     : jest.fn(),
  isQuitting               : false,
  requestSingleInstanceLock: jest.fn().mockReturnValue(true),
  setAsDefaultProtocolClient: jest.fn(),
  disableHardwareAcceleration: jest.fn(),
  whenReady                : jest.fn().mockResolvedValue(undefined),
  isReady                  : jest.fn().mockReturnValue(true),
});

// ── shell ────────────────────────────────────────────────────────────────────
const shell = {
  openExternal : jest.fn().mockResolvedValue(undefined),
  openPath     : jest.fn().mockResolvedValue(''),
};

// ── session ──────────────────────────────────────────────────────────────────
const session = {
  defaultSession: {
    setPermissionRequestHandler: jest.fn(),
    webRequest: { onHeadersReceived: jest.fn() },
  },
};

// ── contextBridge (preload.js için) ──────────────────────────────────────────
const _exposedApis = {};
const contextBridge = {
  exposeInMainWorld: jest.fn((key, api) => {
    _exposedApis[key] = api;
  }),
  // Test yardımcısı: preload'un expose ettiği API'yi almak için
  _getExposed: (key) => _exposedApis[key],
};

// ── ipcRenderer (preload.js için) ────────────────────────────────────────────
const _ipcRendererListeners = {};
const ipcRenderer = {
  send   : jest.fn(),
  invoke : jest.fn().mockResolvedValue(undefined),
  on     : jest.fn((channel, cb) => {
    (_ipcRendererListeners[channel] = _ipcRendererListeners[channel] || []).push(cb);
  }),
  removeListener: jest.fn((channel, cb) => {
    if (_ipcRendererListeners[channel]) {
      _ipcRendererListeners[channel] = _ipcRendererListeners[channel].filter(l => l !== cb);
    }
  }),
  // Test yardımcısı: renderer'a event göndermek için
  _trigger: (channel, ...args) => {
    (_ipcRendererListeners[channel] || []).forEach(l => l({}, ...args));
  },
};

// ── autoUpdater ──────────────────────────────────────────────────────────────
// electron-updater ayrı mock dosyasında; burada sadece placeholder
const autoUpdater = new MockEmitter();
Object.assign(autoUpdater, {
  checkForUpdatesAndNotify : jest.fn().mockResolvedValue(null),
  downloadUpdate           : jest.fn().mockResolvedValue([]),
  quitAndInstall           : jest.fn(),
});

// ── Export ───────────────────────────────────────────────────────────────────
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
  autoUpdater,
  // Test yardımcıları — mock iç durumuna erişim
  _ipcMainListeners,
  _ipcMainHandlers,
  _ipcRendererListeners,
  _exposedApis,
};
