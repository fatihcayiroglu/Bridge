// electron/tests/main.test.ts
//
// Final21 Phase 12: these tests load the REAL main.ts / preload.ts / connectPreload.ts
// against the Electron mock. The previous file re-implemented each handler inside
// the test body (notify handler, server status, deep-link patterns, waitForServer)
// and never imported main.ts — all 45 tests would have passed with main.ts deleted.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

type Electron = any;

interface Loaded {
  electron: Electron;
  main: typeof import('../main');
  userData: string;
}

const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function loadMain(options: { packaged?: boolean; serverOrigin?: string | null; argv?: string[] } = {}): Promise<Loaded> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-desktop-test-'));
  tempDirs.push(userData);
  if (options.serverOrigin) {
    fs.writeFileSync(path.join(userData, 'desktop-settings.json'), JSON.stringify({ serverOrigin: options.serverOrigin }));
  }
  const originalArgv = process.argv;
  process.argv = ['Bridge.exe', ...(options.argv ?? [])];
  let loaded!: Loaded;
  try {
    jest.isolateModules(() => {
      const electron = require('electron');
      electron.app.getPath.mockImplementation(() => userData);
      electron.app.isPackaged = options.packaged ?? false;
      const main = require('../main');
      loaded = { electron, main, userData };
    });
    await flush();
  } finally {
    process.argv = originalArgv;
  }
  return loaded;
}

const windows = (electron: Electron) => electron.BrowserWindow.instances as any[];
const connectWindowOf = (electron: Electron) => windows(electron).find((w) => String(w.options.webPreferences?.preload).endsWith('connectPreload.js'));
const mainWindowOf = (electron: Electron) => windows(electron).find((w) => String(w.options.webPreferences?.preload).endsWith(`${path.sep}preload.js`));

function connectEvent(win: any) {
  return { sender: win.webContents, senderFrame: { url: win.webContents.getURL() } };
}
function appEvent(url: string) {
  return { sender: { getURL: () => url }, senderFrame: { url } };
}
function bridgeHealthResponse(body: unknown = { status: 'ok', check: 'liveness' }) {
  return { ok: true, json: async () => body };
}

describe('first run — connect to a server', () => {
  it('opens only the connect window, with the connect preload and the local connect page', async () => {
    const { electron } = await loadMain();
    const connect = connectWindowOf(electron);
    expect(windows(electron)).toHaveLength(1);
    expect(connect.options.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    expect(connect.loadFile).toHaveBeenCalledWith(expect.stringMatching(/static[\\/]connect\.html$/));
  });

  it('answers connect IPC only from the connect page inside the connect window', async () => {
    const { electron } = await loadMain();
    const connect = connectWindowOf(electron);
    await expect(electron.ipcMain._invoke('desktop:connect', appEvent('https://evil.example.com/'), 'chat.example.com'))
      .rejects.toThrow('Untrusted IPC sender');
    const foreignWindow = { sender: {}, senderFrame: { url: connect.webContents.getURL() } };
    await expect(electron.ipcMain._invoke('desktop:connect-context', foreignWindow)).rejects.toThrow('Untrusted IPC sender');
    await expect(electron.ipcMain._invoke('desktop:connect-context', connectEvent(connect))).resolves.toMatchObject({
      locale: 'tr', lastOrigin: null, strings: { connectButton: 'Bağlan' },
    });
  });

  it('refuses an insecure address without probing or saving anything', async () => {
    const { electron, userData } = await loadMain();
    const result = await electron.ipcMain._invoke('desktop:connect', connectEvent(connectWindowOf(electron)), 'http://chat.example.com');
    expect(result).toEqual({ ok: false, message: expect.stringContaining('https://') });
    expect(electron.net.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userData, 'desktop-settings.json'))).toBe(false);
  });

  it.each([
    ['network error', () => Promise.reject(new Error('ENOTFOUND'))],
    ['HTTP error', () => Promise.resolve({ ok: false, json: async () => ({}) })],
    ['a server that is not Bridge', () => Promise.resolve(bridgeHealthResponse({ status: 'ok' }))],
  ])('reports an unreachable server on %s', async (_label, response) => {
    const { electron, userData } = await loadMain();
    electron.net.fetch.mockImplementation(response);
    const result = await electron.ipcMain._invoke('desktop:connect', connectEvent(connectWindowOf(electron)), 'chat.example.com');
    expect(result).toEqual({ ok: false, message: 'Bu adreste bir Bridge sunucusuna ulaşılamadı.' });
    expect(fs.existsSync(path.join(userData, 'desktop-settings.json'))).toBe(false);
    expect(mainWindowOf(electron)).toBeUndefined();
  });

  it('saves a verified Bridge server, opens it and closes the connect window', async () => {
    const { electron, userData } = await loadMain();
    electron.net.fetch.mockResolvedValue(bridgeHealthResponse());
    const connect = connectWindowOf(electron);
    const result = await electron.ipcMain._invoke('desktop:connect', connectEvent(connect), ' chat.example.com/ignored/path ');

    expect(result).toEqual({ ok: true });
    expect(electron.net.fetch).toHaveBeenCalledWith('https://chat.example.com/api/health/live', expect.objectContaining({ redirect: 'error' }));
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8'))).toEqual({ serverOrigin: 'https://chat.example.com' });
    expect(mainWindowOf(electron).loadURL).toHaveBeenCalledWith('https://chat.example.com');
    expect(connect.close).toHaveBeenCalled();
  });
});

describe('returning user — the saved server', () => {
  const ORIGIN = 'https://chat.example.com';

  it('opens the saved server directly, with a sandboxed window and the Bridge icon', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    const win = mainWindowOf(electron);
    expect(connectWindowOf(electron)).toBeUndefined();
    expect(win.loadURL).toHaveBeenCalledWith(ORIGIN);
    expect(win.options).toMatchObject({ title: 'Bridge', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    expect(win.options.frame).toBeUndefined();
    expect(fs.existsSync(win.options.icon)).toBe(true);
    const trayImage = electron.Tray.instances[0].image.source;
    expect(fs.existsSync(trayImage)).toBe(true);
    expect(electron.app.setAppUserModelId).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 0);
  });

  it('shows native notifications only for the connected server page', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    electron.ipcMain._trigger('bridge:notify', appEvent('https://evil.example.com/'), { title: 'x', body: 'y' });
    expect(electron.Notification).not.toHaveBeenCalled();

    electron.ipcMain._trigger('bridge:notify', appEvent(`${ORIGIN}/channels/1`), { title: 'T'.repeat(200), body: 'hello' });
    expect(electron.Notification).toHaveBeenCalledTimes(1);
    const notification = electron.Notification.mock.instances[0];
    expect(notification.options).toMatchObject({ title: 'T'.repeat(160), body: 'hello' });
    expect(notification.show).toHaveBeenCalled();
  });

  it('grants media and notification permissions only to the connected server', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    const handler = electron.session.defaultSession.setPermissionRequestHandler.mock.calls[0][0];
    const decide = (url: string, permission: string) => new Promise((resolve) => handler({ getURL: () => url }, permission, resolve));
    await expect(decide(`${ORIGIN}/`, 'media')).resolves.toBe(true);
    await expect(decide(`${ORIGIN}/`, 'geolocation')).resolves.toBe(false);
    await expect(decide('https://evil.example.com/', 'media')).resolves.toBe(false);
  });

  it('adds a strict CSP only to server documents that lack one', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    const handler = electron.session.defaultSession.webRequest.onHeadersReceived.mock.calls[0][0];
    const run = (details: object) => new Promise<any>((resolve) => handler(details, resolve));

    const added = await run({ url: `${ORIGIN}/`, resourceType: 'mainFrame', responseHeaders: {} });
    const policy = added.responseHeaders['Content-Security-Policy'][0];
    expect(policy).toContain("default-src 'self'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);

    const kept = { 'content-security-policy': ["default-src 'self'; script-src 'nonce-abc'"] };
    await expect(run({ url: `${ORIGIN}/`, resourceType: 'mainFrame', responseHeaders: kept })).resolves.toEqual({ responseHeaders: kept });
    await expect(run({ url: 'https://cdn.example.com/a.js', resourceType: 'script', responseHeaders: {} })).resolves.toEqual({ responseHeaders: {} });
  });

  it('keeps navigation on the server and hands everything else to the browser', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    const win = mainWindowOf(electron);
    const same = { preventDefault: jest.fn() };
    win.webContents.emit('will-navigate', same, `${ORIGIN}/settings`);
    expect(same.preventDefault).not.toHaveBeenCalled();

    const away = { preventDefault: jest.fn() };
    win.webContents.emit('will-navigate', away, 'https://example.org/');
    expect(away.preventDefault).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.org/');

    const script = { preventDefault: jest.fn() };
    win.webContents.emit('will-navigate', script, 'javascript:alert(1)');
    expect(script.preventDefault).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
  });
});

describe('deep links', () => {
  const ORIGIN = 'https://chat.example.com';

  it('delivers a link that launched the app once the Bridge page has loaded', async () => {
    const { electron, main } = await loadMain({ serverOrigin: ORIGIN, argv: ['bridge://invite/ABC123'] });
    const win = mainWindowOf(electron);
    const deepLinkSends = () => win.webContents.send.mock.calls.filter(([channel]: [string]) => channel === 'desktop:deeplink');
    expect(main._testing.getPendingDeepLink()).toBe('bridge://invite/ABC123');
    expect(deepLinkSends()).toHaveLength(0);

    win.webContents.emit('did-finish-load');
    expect(deepLinkSends()).toEqual([['desktop:deeplink', 'bridge://invite/ABC123']]);
    expect(main._testing.getPendingDeepLink()).toBeNull();
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('focuses the running window on a second launch and ignores links outside the allow-list', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    const win = mainWindowOf(electron);
    win.webContents.emit('did-finish-load');

    const deepLinkSends = () => win.webContents.send.mock.calls.filter(([channel]: [string]) => channel === 'desktop:deeplink');
    electron.app.emit('second-instance', {}, ['Bridge.exe', 'bridge://admin/exec']);
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(deepLinkSends()).toHaveLength(0);

    electron.app.emit('second-instance', {}, ['Bridge.exe', 'bridge://channels/general-1']);
    expect(deepLinkSends()).toEqual([['desktop:deeplink', 'bridge://channels/general-1']]);
  });

  it('does not open a window when another instance already holds the lock', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-desktop-test-'));
    tempDirs.push(userData);
    let electron: Electron;
    jest.isolateModules(() => {
      electron = require('electron');
      electron.app.getPath.mockImplementation(() => userData);
      electron.app.requestSingleInstanceLock.mockReturnValue(false);
      require('../main');
    });
    await flush();
    expect(electron.app.quit).toHaveBeenCalled();
    expect(windows(electron)).toHaveLength(0);
  });
});

describe('shell chrome', () => {
  const ORIGIN = 'https://chat.example.com';
  const viewItems = (electron: Electron) => {
    const template = electron.Menu.setApplicationMenu.mock.calls[0][0].items;
    return template[1].submenu as Array<{ label?: string }>;
  };

  it('offers DevTools only in development builds', async () => {
    const dev = await loadMain({ serverOrigin: ORIGIN, packaged: false });
    expect(viewItems(dev.electron).some((item) => item.label === 'DevTools')).toBe(true);
    const installed = await loadMain({ serverOrigin: ORIGIN, packaged: true });
    expect(viewItems(installed.electron).some((item) => item.label === 'DevTools')).toBe(false);
  });

  it('hides to the tray on close and explains it only once', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    const win = mainWindowOf(electron);
    for (let i = 0; i < 2; i++) {
      const event = { preventDefault: jest.fn() };
      win.emit('close', event);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    expect(win.hide).toHaveBeenCalledTimes(2);
    expect(electron.Tray.instances[0].displayBalloon).toHaveBeenCalledTimes(1);
  });

  it('quits for real from the tray menu', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN });
    const items = electron.Tray.instances[0].setContextMenu.mock.calls[0][0].items as Array<{ label?: string; click?: () => void }>;
    items.find((item) => item.label === 'Çıkış')!.click!();
    expect(electron.app.quit).toHaveBeenCalled();
    const event = { preventDefault: jest.fn() };
    mainWindowOf(electron).emit('close', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  (process.platform === 'win32' ? it : it.skip)('Start with Windows is off by default and follows the tray checkbox', async () => {
    const { electron, main } = await loadMain({ serverOrigin: ORIGIN });
    const items = electron.Tray.instances[0].setContextMenu.mock.calls[0][0].items as Array<{ label?: string; checked?: boolean; click?: (i: object) => void }>;
    const toggle = items.find((item) => item.label === 'Windows ile başlat')!;
    expect(toggle.checked).toBe(false);
    toggle.click!({ checked: true });
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ['--background'] });
    expect(main.isStartWithWindowsEnabled()).toBe(true);
    toggle.click!({ checked: false });
    expect(main.isStartWithWindowsEnabled()).toBe(false);
  });

  it('stays in the tray when started by the login item', async () => {
    const { electron } = await loadMain({ serverOrigin: ORIGIN, argv: ['--background'] });
    const win = mainWindowOf(electron);
    win.emit('ready-to-show');
    expect(win.show).not.toHaveBeenCalled();
  });
});

describe('preloads', () => {
  it('the web app gets notifications and the updater — no server process control', () => {
    jest.isolateModules(() => {
      const electron = require('electron');
      require('../preload');
      expect(Object.keys(electron._exposedApis).sort()).toEqual(['bridgeUpdater', 'electronBridge']);
      (electron._exposedApis.electronBridge as { notify: (t: string, b: string) => void }).notify('Title', 'Body');
      expect(electron.ipcRenderer.send).toHaveBeenCalledWith('bridge:notify', { title: 'Title', body: 'Body' });
    });
  });

  it('holds deep links that arrive before the web app subscribes, then replays them once', () => {
    jest.isolateModules(() => {
      const electron = require('electron');
      require('../preload');
      electron.ipcRenderer._trigger('desktop:deeplink', 'bridge://invite/EARLY');
      electron.ipcRenderer._trigger('desktop:deeplink', { not: 'a string' });
      const bridge = electron._exposedApis.electronBridge as { onDeepLink: (cb: (url: string) => void) => () => void };
      const received: string[] = [];
      const unsubscribe = bridge.onDeepLink((url) => received.push(url));
      expect(received).toEqual(['bridge://invite/EARLY']);
      electron.ipcRenderer._trigger('desktop:deeplink', 'bridge://servers/LIVE');
      expect(received).toEqual(['bridge://invite/EARLY', 'bridge://servers/LIVE']);
      unsubscribe();
      electron.ipcRenderer._trigger('desktop:deeplink', 'bridge://servers/AFTER');
      expect(received).toHaveLength(2);
    });
  });

  it('the connect page gets only the connect API', async () => {
    let electron: Electron;
    jest.isolateModules(() => {
      electron = require('electron');
      require('../connectPreload');
    });
    expect(Object.keys(electron._exposedApis)).toEqual(['bridgeConnect']);
    await (electron._exposedApis.bridgeConnect as { connect: (a: unknown) => Promise<unknown> }).connect(undefined);
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('desktop:connect', '');
  });

  it('the connect page is the file main.ts trusts', async () => {
    const { main } = await loadMain();
    expect(pathToFileURL(main._testing.connectPagePath()).href).toMatch(/\/static\/connect\.html$/);
    expect(fs.existsSync(main._testing.connectPagePath())).toBe(true);
  });
});
