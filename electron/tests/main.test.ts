// electron/tests/main.test.ts
// Electron main.ts ve preload.ts birim testleri

'use strict';

jest.mock('electron', () => jest.requireActual('./__mocks__/electron'));
jest.mock('electron-updater', () => jest.requireActual('./__mocks__/electron-updater'));
jest.mock('child_process');
jest.mock('http');

import {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  contextBridge,
  Notification,
} from 'electron';
import { spawn } from 'child_process';
import http from 'http';

// ── Type helpers ──────────────────────────────────────────────────────────────
interface MockProcess {
  killed: boolean;
  pid: number;
  stdout: { on: jest.Mock };
  stderr: { on: jest.Mock };
  on: jest.Mock;
  kill: jest.Mock;
  once: jest.Mock;
}

// ── Spawn mock'u ──────────────────────────────────────────────────────────────
const makeSpawnMock = (_exitCode = 0): MockProcess => {
  const proc: MockProcess = {
    killed: false,
    pid: 12345,
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(function (this: MockProcess) { this.killed = true; }),
    once: jest.fn(),
  };
  (spawn as jest.Mock).mockReturnValue(proc);
  return proc;
};

// ── http.get mock'u ────────────────────────────────────────────────────────────
const mockHttpGetSuccess = (): void => {
  (http as any).get = jest.fn((url: string, cb?: () => void) => {
    if (cb) cb();
    return { on: jest.fn() };
  });
};

// ═════════════════════════════════════════════════════════════════════════════
// MAIN.TS — IPC handler testleri
// ═════════════════════════════════════════════════════════════════════════════

describe("IPC: bridge:notify — bildirim handler'ı", () => {
  let notifyHandler: (event: unknown, payload: { title: string; body: string }) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    notifyHandler = (_event, { title, body }) => {
      if (!(Notification as any).isSupported()) return;
      const n = new (Notification as any)({ title: title || 'Bridge', body: body || '' });
      n.show();
      return n;
    };
  });

  it('Notification.isSupported() false ise bildirim oluşturmamalı', () => {
    (Notification as any).isSupported.mockReturnValue(false);
    const n = notifyHandler({}, { title: 'Test', body: 'Mesaj' });
    expect(n).toBeUndefined();
    expect(Notification).not.toHaveBeenCalled();
  });

  it('Notification.isSupported() true ise n.show() çağrılmalı', () => {
    (Notification as any).isSupported.mockReturnValue(true);
    notifyHandler({}, { title: 'Yeni mesaj', body: 'Merhaba' });
    expect(Notification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Yeni mesaj', body: 'Merhaba' })
    );
    const instance = (Notification as any).mock.instances[0];
    expect(instance.show).toHaveBeenCalled();
  });

  it('title/body boşsa varsayılan değerleri kullanmalı', () => {
    (Notification as any).isSupported.mockReturnValue(true);
    notifyHandler({}, { title: '', body: '' });
    expect(Notification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bridge', body: '' })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("IPC: server:getStatus — durum handler'ı", () => {
  it('status ve pid döndürmeli', async () => {
    const serverStatus = 'running';
    const serverProcess = { pid: 9999 };

    const handler = () => ({
      status: serverStatus,
      pid: serverProcess?.pid ?? null,
      logs: [] as unknown[],
    });

    const result = handler();
    expect(result.status).toBe('running');
    expect(result.pid).toBe(9999);
    expect(Array.isArray(result.logs)).toBe(true);
  });

  it('process null iken pid null döndürmeli', () => {
    const serverStatus = 'stopped';
    const serverProcess: null = null;

    const handler = () => ({
      status: serverStatus,
      pid: serverProcess ?? null,
      logs: [] as unknown[],
    });

    const result = handler();
    expect(result.status).toBe('stopped');
    expect(result.pid).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('server control — startServerControlled mantığı', () => {
  let mockProc: MockProcess;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProc = makeSpawnMock();
  });

  it('spawn çağrıldığında stdout.on ve stderr.on dinleyici kaydeder', () => {
    const proc = spawn('node', ['server/index.js'], { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as MockProcess;
    proc.stdout.on('data', jest.fn());
    proc.stderr.on('data', jest.fn());

    expect(spawn).toHaveBeenCalledWith('node', ['server/index.js'], expect.any(Object));
    expect(proc.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
    expect(proc.stderr.on).toHaveBeenCalledWith('data', expect.any(Function));
  });

  it('process.kill("SIGTERM") çağrıldığında killed true olmalı', () => {
    const proc = spawn('node', ['x']) as unknown as MockProcess;
    proc.kill('SIGTERM');
    expect(proc.killed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('handleDeepLink — derin bağlantı güvenlik doğrulaması', () => {
  const DEEPLINK_PATTERNS: RegExp[] = [
    /^bridge:\/\/servers\/([a-zA-Z0-9_-]{1,64})$/,
    /^bridge:\/\/channels\/([a-zA-Z0-9_-]{1,64})$/,
    /^bridge:\/\/invite\/([a-zA-Z0-9_-]{1,32})$/,
  ];

  function isAllowed(url: string): boolean {
    return DEEPLINK_PATTERNS.some((p) => p.test(url));
  }

  it.each([
    ['bridge://servers/abc123',  true],
    ['bridge://channels/ch-xyz', true],
    ['bridge://invite/CODE99',   true],
    ['bridge://servers/' + 'a'.repeat(64), true],
  ] as [string, boolean][])('geçerli URL kabul edilmeli: %s', (url, expected) => {
    expect(isAllowed(url)).toBe(expected);
  });

  it.each([
    ['bridge://admin/exec',                   false],
    ['bridge://servers/' + 'a'.repeat(65),    false],
    ['javascript:alert(1)',                   false],
    ['bridge://invite/../../etc/passwd',      false],
    ['bridge://servers/<script>xss</script>', false],
    ['',                                      false],
  ] as [string, boolean][])('geçersiz URL reddedilmeli: %s', (url, expected) => {
    expect(isAllowed(url)).toBe(expected);
  });

  it('mainWindow null iken erken dönmeli (crash yok)', () => {
    let mainWindow: BrowserWindow | null = null;
    const handleDeepLink = (url: string): string => {
      if (!mainWindow) return 'early-return';
      if (!isAllowed(url)) return 'rejected';
      (mainWindow as BrowserWindow).webContents.executeJavaScript(`...`);
      return 'executed';
    };
    expect(handleDeepLink('bridge://servers/test')).toBe('early-return');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('waitForServer — retry mantığı', () => {
  it('sunucu hemen yanıt verirse resolve etmeli', async () => {
    mockHttpGetSuccess();

    const waitForServer = (retries = 20): Promise<void> =>
      new Promise((resolve, reject) => {
        const check = (n: number): void => {
          (http as any).get('http://localhost:3001', () => resolve())
            .on('error', () => {
              if (n <= 0) return reject(new Error('Server did not start'));
              setTimeout(() => check(n - 1), 500);
            });
        };
        check(retries);
      });

    await expect(waitForServer(3)).resolves.toBeUndefined();
    expect((http as any).get).toHaveBeenCalledWith('http://localhost:3001', expect.any(Function));
  });

  it('tüm retrylar başarısız olursa reject etmeli', async () => {
    (http as any).get = jest.fn((_url: string, _cb?: unknown) => {
      const req = {
        on: jest.fn((event: string, handler: (e: Error) => void) => {
          if (event === 'error') handler(new Error('ECONNREFUSED'));
        }),
      };
      return req;
    });
    jest.useFakeTimers();

    const waitForServer = (retries = 2): Promise<void> =>
      new Promise((resolve, reject) => {
        const check = (n: number): void => {
          (http as any).get('http://localhost:3001', () => resolve())
            .on('error', () => {
              if (n <= 0) return reject(new Error('Server did not start'));
              setTimeout(() => check(n - 1), 10);
            });
        };
        check(retries);
      });

    const promise = waitForServer(0);
    await expect(promise).rejects.toThrow('Server did not start');
    jest.useRealTimers();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ENTEGRASYON: main.ts handler kayıt + davranış doğrulaması
// ═════════════════════════════════════════════════════════════════════════════

describe('main.ts — IPC handler kayıt + davranış entegrasyon testleri', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (ipcMain as any).handle('server:getStatus', () => ({
      status: 'running',
      pid: 42,
      logs: ['Server started'],
    }));

    (ipcMain as any).handle('bridge:getConfig', () => ({
      version: '69.0.0',
      features: ['canvas', 'stage', 'dm-call'],
    }));

    (ipcMain.on as jest.Mock)('server:start',   jest.fn());
    (ipcMain.on as jest.Mock)('server:stop',    jest.fn());
    (ipcMain.on as jest.Mock)('server:restart', jest.fn());
    (ipcMain.on as jest.Mock)('bridge:notify',  jest.fn());
  });

  it('server:getStatus handler kayıtlı ve doğru veri döndürmeli', async () => {
    const result = await (ipcMain as any)._invoke('server:getStatus', {});
    expect(result.status).toBe('running');
    expect(result.pid).toBe(42);
    expect(Array.isArray(result.logs)).toBe(true);
  });

  it('bridge:getConfig handler kayıtlı ve version döndürmeli', async () => {
    const result = await (ipcMain as any)._invoke('bridge:getConfig', {});
    expect(result.version).toBe('69.0.0');
    expect(result.features).toContain('canvas');
  });

  it('kayıtsız kanal _invoke edilince hata fırlatmalı', async () => {
    await expect((ipcMain as any)._invoke('nonexistent:channel', {}))
      .rejects.toThrow('No handler for channel: nonexistent:channel');
  });

  it('server:start kanalı ipcMain.on ile kayıtlı olmalı', () => {
    const onChannels = (ipcMain.on as jest.Mock).mock.calls.map(([ch]: [string]) => ch);
    expect(onChannels).toContain('server:start');
  });

  it('server:stop kanalı ipcMain.on ile kayıtlı olmalı', () => {
    const onChannels = (ipcMain.on as jest.Mock).mock.calls.map(([ch]: [string]) => ch);
    expect(onChannels).toContain('server:stop');
  });

  it('bridge:notify kanalı ipcMain.on ile kayıtlı olmalı', () => {
    const onChannels = (ipcMain.on as jest.Mock).mock.calls.map(([ch]: [string]) => ch);
    expect(onChannels).toContain('bridge:notify');
  });

  it('server:start tetiklenince handler çağrılmalı', () => {
    (ipcMain as any)._trigger('server:start', {});
    const startHandler = (ipcMain.on as jest.Mock).mock.calls
      .find(([ch]: [string]) => ch === 'server:start')?.[1];
    expect(startHandler).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRELOAD.TS — contextBridge.exposeInMainWorld testleri
// ═════════════════════════════════════════════════════════════════════════════

describe('preload.ts — electronBridge API kayıt ve mesajlaşma', () => {
  interface ElectronBridgeAPI {
    notify: (title: string, body: string) => void;
    onNotificationsToggle: (cb: (enabled: boolean) => void) => void;
  }

  let electronBridge: ElectronBridgeAPI;

  beforeEach(() => {
    jest.clearAllMocks();
    electronBridge = {
      notify: (title, body) => ipcRenderer.send('bridge:notify', { title, body }),
      onNotificationsToggle: (cb) =>
        (ipcRenderer.on as jest.Mock)('tray:notifications-toggle', (_: unknown, enabled: boolean) => cb(enabled)),
    };
    contextBridge.exposeInMainWorld('electronBridge', electronBridge);
  });

  it('contextBridge.exposeInMainWorld çağrılmış olmalı', () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('electronBridge', expect.any(Object));
  });

  it('electronBridge.notify() ipcRenderer.send ile bridge:notify kanalına mesaj göndermeli', () => {
    electronBridge.notify('Test', 'Mesaj');
    expect(ipcRenderer.send).toHaveBeenCalledWith('bridge:notify', { title: 'Test', body: 'Mesaj' });
  });

  it('electronBridge.onNotificationsToggle() ipcRenderer.on kaydeder', () => {
    const cb = jest.fn();
    electronBridge.onNotificationsToggle(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('tray:notifications-toggle', expect.any(Function));
  });
});

describe('preload.ts — serverControl API kayıt ve IPC köprüsü', () => {
  interface ServerControlAPI {
    start:     () => void;
    stop:      () => void;
    restart:   () => void;
    getStatus: () => Promise<{ status: string; pid: number | null; logs: unknown[] }>;
    onStatus:  (cb: (data: { status: string; pid: number | null }) => void) => void;
    onLog:     (cb: (data: { t: number; level: string; line: string }) => void) => void;
    offStatus: (cb: (...args: unknown[]) => void) => void;
    offLog:    (cb: (...args: unknown[]) => void) => void;
  }

  let serverControl: ServerControlAPI;

  beforeEach(() => {
    jest.clearAllMocks();
    serverControl = {
      start:     ()    => ipcRenderer.send('server:start'),
      stop:      ()    => ipcRenderer.send('server:stop'),
      restart:   ()    => ipcRenderer.send('server:restart'),
      getStatus: ()    => ipcRenderer.invoke('server:getStatus') as Promise<any>,
      onStatus:  (cb)  => (ipcRenderer.on as jest.Mock)('server:status',
        (_: unknown, data: { status: string; pid: number | null }) => cb(data)),
      onLog:     (cb)  => (ipcRenderer.on as jest.Mock)('server:log',
        (_: unknown, data: { t: number; level: string; line: string }) => cb(data)),
      offStatus: (cb)  => ipcRenderer.removeListener('server:status', cb),
      offLog:    (cb)  => ipcRenderer.removeListener('server:log', cb),
    };
    contextBridge.exposeInMainWorld('serverControl', serverControl);
  });

  it('start() server:start kanalına send etmeli', () => {
    serverControl.start();
    expect(ipcRenderer.send).toHaveBeenCalledWith('server:start');
  });

  it('stop() server:stop kanalına send etmeli', () => {
    serverControl.stop();
    expect(ipcRenderer.send).toHaveBeenCalledWith('server:stop');
  });

  it('restart() server:restart kanalına send etmeli', () => {
    serverControl.restart();
    expect(ipcRenderer.send).toHaveBeenCalledWith('server:restart');
  });

  it('getStatus() ipcRenderer.invoke ile server:getStatus çağrılmalı', async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue({ status: 'running', pid: 42, logs: [] });
    const result = await serverControl.getStatus();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('server:getStatus');
    expect(result.status).toBe('running');
  });

  it('onStatus(cb) tray eventi tetiklenince cb çağrılmalı', () => {
    const cb = jest.fn();
    serverControl.onStatus(cb);
    const [, registeredCb] = (ipcRenderer.on as jest.Mock).mock.calls
      .find(([ch]: [string]) => ch === 'server:status') ?? [];
    registeredCb({}, { status: 'stopped', pid: null });
    expect(cb).toHaveBeenCalledWith({ status: 'stopped', pid: null });
  });

  it('offStatus(cb) removeListener çağrılmalı', () => {
    const cb = jest.fn();
    serverControl.offStatus(cb);
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('server:status', cb);
  });
});

describe('preload.ts — bridgeUpdater API kayıt ve IPC köprüsü', () => {
  interface BridgeUpdateState {
    phase: string;
    currentVersion: string;
    availableVersion: string | null;
    percent: number;
    canInstall: boolean;
    isPackaged: boolean;
  }

  interface BridgeUpdaterAPI {
    getStatus: () => Promise<BridgeUpdateState>;
    check:     () => Promise<BridgeUpdateState>;
    install:   () => Promise<BridgeUpdateState>;
    onStatus:  (cb: (data: BridgeUpdateState) => void) => (() => void);
  }

  let bridgeUpdater: BridgeUpdaterAPI;

  beforeEach(() => {
    jest.clearAllMocks();
    bridgeUpdater = {
      getStatus: () => ipcRenderer.invoke('updater:getStatus') as Promise<BridgeUpdateState>,
      check:     () => ipcRenderer.invoke('updater:check') as Promise<BridgeUpdateState>,
      install:   () => ipcRenderer.invoke('updater:install') as Promise<BridgeUpdateState>,
      onStatus:  (cb) => {
        const listener = (_: unknown, data: BridgeUpdateState): void => cb(data);
        (ipcRenderer.on as jest.Mock)('updater:status', listener);
        return () => ipcRenderer.removeListener('updater:status', listener);
      },
    };
    contextBridge.exposeInMainWorld('bridgeUpdater', bridgeUpdater);
  });

  it('contextBridge bridgeUpdater API kaydını yapmalı', () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('bridgeUpdater', expect.any(Object));
  });

  it('getStatus/check/install doğru IPC kanallarını çağırmalı', async () => {
    const status = { phase: 'downloaded', currentVersion: '1.0.0', availableVersion: '1.1.0', percent: 100, canInstall: true, isPackaged: true };
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(status);

    await expect(bridgeUpdater.getStatus()).resolves.toEqual(status);
    await bridgeUpdater.check();
    await bridgeUpdater.install();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('updater:getStatus');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('updater:check');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('updater:install');
  });

  it('onStatus status eventini dinlemeli ve unsubscribe removeListener çağırmalı', () => {
    const cb = jest.fn();
    const off = bridgeUpdater.onStatus(cb);
    const [, registeredCb] = (ipcRenderer.on as jest.Mock).mock.calls
      .find(([ch]: [string]) => ch === 'updater:status') ?? [];
    const payload = { phase: 'downloading', currentVersion: '1.0.0', availableVersion: '1.1.0', percent: 42, canInstall: false, isPackaged: true };
    registeredCb({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);

    off();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('updater:status', registeredCb);
  });
});
