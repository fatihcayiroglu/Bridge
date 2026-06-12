// electron/tests/__mocks__/electron-updater.js
'use strict';

class MockEmitter {
  constructor() { this._listeners = {}; }
  on(e, cb)  { (this._listeners[e] = this._listeners[e] || []).push(cb); return this; }
  once(e, cb) { const w = (...a) => { this.removeListener(e, w); cb(...a); }; return this.on(e, w); }
  removeListener(e, cb) { if (this._listeners[e]) this._listeners[e] = this._listeners[e].filter(l => l !== cb); return this; }
  emit(e, ...a) { (this._listeners[e] || []).forEach(l => l(...a)); return this; }
}

const autoUpdater = new MockEmitter();
Object.assign(autoUpdater, {
  checkForUpdatesAndNotify: jest.fn().mockResolvedValue(null),
  downloadUpdate          : jest.fn().mockResolvedValue([]),
  quitAndInstall          : jest.fn(),
  logger                  : null,
  autoDownload            : true,
});

module.exports = { autoUpdater };
