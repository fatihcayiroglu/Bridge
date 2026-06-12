// electron/tests/__mocks__/electron-updater.ts
'use strict';

class MockEmitter {
  protected _listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  on(e: string, cb: (...args: unknown[]) => void): this {
    (this._listeners[e] = this._listeners[e] || []).push(cb); return this;
  }
  once(e: string, cb: (...args: unknown[]) => void): this {
    const w = (...a: unknown[]): void => { this.removeListener(e, w); cb(...a); };
    return this.on(e, w);
  }
  removeListener(e: string, cb: (...args: unknown[]) => void): this {
    if (this._listeners[e]) this._listeners[e] = this._listeners[e].filter((l) => l !== cb);
    return this;
  }
  emit(e: string, ...a: unknown[]): this {
    (this._listeners[e] || []).forEach((l) => l(...a)); return this;
  }
}

const autoUpdater = new MockEmitter() as any;
Object.assign(autoUpdater, {
  checkForUpdates          : jest.fn().mockResolvedValue(null),
  checkForUpdatesAndNotify: jest.fn().mockResolvedValue(null),
  downloadUpdate          : jest.fn().mockResolvedValue([]),
  quitAndInstall          : jest.fn(),
  logger                  : null,
  autoDownload            : true,
  autoInstallOnAppQuit    : false,
  allowPrerelease         : false,
});

module.exports = { autoUpdater };

export {};
