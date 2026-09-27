// electron/main.ts
//
// Bridge desktop — a native client for a Bridge server: deep links (bridge://),
// system tray, native notifications, user-controlled start with Windows, updates.
//
// ── Final21 Phase 12: CLIENT, NOT BUNDLED SERVER ─────────────────────────────
// This process used to spawn a bundled copy of the Bridge server on 127.0.0.1:3001.
// Measured on an installed build: the copy shipped without node_modules, database
// or secrets, crashed on `Cannot find module 'dotenv/config'`, and the window stayed
// empty. A Bridge server needs PostgreSQL and operator secrets; a consumer install
// cannot provide them. The desktop app now opens the server the user connects to
// (desktopSettings.ts), like other self-hosted chat clients.

import {
  app, BrowserWindow, dialog, shell, Menu, Tray,
  Notification, nativeImage, session, ipcMain, net,
} from 'electron';
import {
  checkForBridgeUpdates,
  installDownloadedUpdate,
  setupBridgeAutoUpdater,
  teardownBridgeAutoUpdater,
} from './updater';
import path from 'path';
import { pathToFileURL } from 'url';
import { getAppOrigin, isAllowedExternalUrl, isSameAppOrigin, setAppOrigin } from './navigationPolicy';
import { nativeText, normalizeNativeLocale, type NativeTextKey } from './nativeLocale';
import { ipcSenderUrl, isTrustedIpcSender } from './ipcSecurity';
import { normalizeServerUrl, readDesktopSettings, writeDesktopSettings, type ServerUrlRejection } from './desktopSettings';

let mainWindow: BrowserWindow | null = null;
let connectWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let backgroundNoticeShown = false;

const DEEP_LINK_SCHEME = 'bridge';
const APP_USER_MODEL_ID = 'com.bridge.desktop';
/** Passed by the "Start with Windows" login item: start in the tray, not in the user's face. */
const BACKGROUND_ARG = '--background';
const SERVER_PROBE_TIMEOUT_MS = 8_000;

/** electron/ in both layouts: compiled code runs from electron/dist, tests load electron/*.ts. */
const APP_ROOT = path.basename(__dirname) === 'dist' ? path.join(__dirname, '..') : __dirname;
const assetPath = (file: string): string => path.join(APP_ROOT, 'assets', file);
const connectPagePath = (): string => path.join(APP_ROOT, 'static', 'connect.html');
const settingsFile = (): string => path.join(app.getPath('userData'), 'desktop-settings.json');

function shellText(key: NativeTextKey, vars: Record<string, string | number> = {}): string {
  const locale = typeof app.getLocale === 'function' ? app.getLocale() : process.env.BRIDGE_LOCALE;
  return nativeText(key, vars, locale);
}

function openExternalSafely(url: string): void {
  if (!isAllowedExternalUrl(url)) {
    console.warn('[navigation] Unsafe external URL scheme rejected:', url);
    return;
  }
  void shell.openExternal(url).catch(() => { /* harici acilamadi — yut */ });
}

// ─── DEEP LINK PROTOCOL ───────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

// Geçerli bridge:// yolu kalıpları
const DEEPLINK_PATTERNS: RegExp[] = [
  /^bridge:\/\/servers\/([a-zA-Z0-9_-]{1,64})$/,
  /^bridge:\/\/channels\/([a-zA-Z0-9_-]{1,64})$/,
  /^bridge:\/\/invite\/([a-zA-Z0-9_-]{1,32})$/,
];

function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/**
 * A link that launched the app (cold start) arrives in process.argv, before any
 * window exists. It used to be dropped: only `second-instance` links were read.
 * Links wait here until the Bridge page has loaded.
 */
let pendingDeepLink: string | null = deepLinkFromArgv(process.argv);
let appPageLoaded = false;

function handleDeepLink(url: string): void {
  const isAllowed = DEEPLINK_PATTERNS.some((pattern) => pattern.test(url));
  if (!isAllowed) {
    console.warn('[deeplink] Geçersiz veya izinsiz URL reddedildi:', url);
    return;
  }
  if (!mainWindow || !appPageLoaded) {
    pendingDeepLink = url;
    return;
  }
  pendingDeepLink = null;
  // Delivered over IPC; preload.ts holds it until the web app subscribes, so a
  // link is not lost when the app boots after the page's load event.
  mainWindow.webContents.send('desktop:deeplink', url);
}

function revealMainWindow(): void {
  const win = mainWindow ?? connectWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Windows: single instance — a second launch focuses the running app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event: Electron.Event, argv: string[]) => {
    revealMainWindow();
    const url = deepLinkFromArgv(argv);
    if (url) handleDeepLink(url);
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ─── START WITH WINDOWS (USER-CONTROLLED, OFF BY DEFAULT) ─────
export function isStartWithWindowsEnabled(): boolean {
  if (process.platform !== 'win32') return false;
  return app.getLoginItemSettings({ args: [BACKGROUND_ARG] }).openAtLogin === true;
}

export function setStartWithWindows(enabled: boolean): void {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: [BACKGROUND_ARG] });
}

// ─── SYSTEM TRAY ─────────────────────────────────────────────
function createTray(): void {
  const icon = nativeImage.createFromPath(assetPath('tray.png'));
  tray = new Tray(icon.isEmpty?.() ? nativeImage.createFromPath(assetPath('icon.png')) : icon);
  tray.setToolTip('Bridge');

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: shellText('openBridge'), click: () => revealMainWindow() },
    { type: 'separator' },
    {
      label: shellText('notifications'),
      type: 'checkbox',
      checked: true,
      click: (item: Electron.MenuItem) => {
        mainWindow?.webContents.send('tray:notifications-toggle', item.checked);
      },
    },
    { type: 'separator' },
    {
      label: shellText('voiceDiagnostics'),
      click: () => {
        revealMainWindow();
        mainWindow?.webContents.send('tray:open-surface', 'voice-check');
      },
    },
    {
      label: shellText('systemStatus'),
      click: () => {
        revealMainWindow();
        mainWindow?.webContents.send('tray:open-surface', 'system-health');
      },
    },
    { type: 'separator' },
    { label: shellText('checkUpdates'), click: () => { void checkForBridgeUpdates(true); } },
    { label: shellText('installRestart'), click: () => { installDownloadedUpdate(); } },
    { type: 'separator' },
    { label: shellText('changeServer'), click: () => openConnectWindow() },
  ];
  if (process.platform === 'win32') {
    template.push({
      label: shellText('startWithWindows'),
      type: 'checkbox',
      checked: isStartWithWindowsEnabled(),
      click: (item: Electron.MenuItem) => setStartWithWindows(item.checked),
    });
  }
  template.push(
    { type: 'separator' },
    { label: shellText('quit'), click: () => { isQuitting = true; app.quit(); } },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on('click', () => revealMainWindow());
}

// ─── NATIVE NOTIFICATIONS ─────────────────────────────────────
interface NotifyPayload { title: string; body: string; icon?: string; }

ipcMain.on('bridge:notify', (event: Electron.IpcMainEvent, payload: NotifyPayload) => {
  if (!isTrustedIpcSender(event) || !Notification.isSupported()) return;
  const title = typeof payload?.title === 'string' ? payload.title.slice(0, 160) : '';
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 1000) : '';
  const n = new Notification({
    title: title || 'Bridge',
    body,
    icon: assetPath('icon.png'),
    silent: false,
  });
  n.on('click', () => revealMainWindow());
  n.show();
});

// ─── CONNECT TO A SERVER ──────────────────────────────────────
const REJECTION_TEXT: Record<ServerUrlRejection, NativeTextKey> = {
  empty: 'connectInvalid',
  invalid: 'connectInvalid',
  insecure: 'connectInsecure',
  credentials: 'connectCredentials',
};

/** True only for a Bridge server: `/api/health/live` answers `{ status: 'ok', check: 'liveness' }`. */
export async function probeBridgeServer(origin: string): Promise<boolean> {
  try {
    const response = await net.fetch(`${origin}/api/health/live`, {
      redirect: 'error',
      signal: AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown; check?: unknown };
    return body?.status === 'ok' && body?.check === 'liveness';
  } catch {
    return false;
  }
}

/** The connect IPC answers only the local connect page in the connect window. */
function isConnectPageSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!connectWindow || event.sender !== connectWindow.webContents) return false;
  const url = ipcSenderUrl(event).split(/[?#]/)[0];
  return url === pathToFileURL(connectPagePath()).href;
}

ipcMain.handle('desktop:connect-context', (event) => {
  if (!isConnectPageSender(event)) throw new Error('Untrusted IPC sender');
  const locale = normalizeNativeLocale(app.getLocale());
  return {
    locale,
    lastOrigin: getAppOrigin(),
    strings: {
      connectTitle: shellText('connectTitle'),
      connectHelp: shellText('connectHelp'),
      connectLabel: shellText('connectLabel'),
      connectButton: shellText('connectButton'),
      connecting: shellText('connecting'),
    },
  };
});

ipcMain.handle('desktop:connect', async (event, address: unknown) => {
  if (!isConnectPageSender(event)) throw new Error('Untrusted IPC sender');
  const normalized = normalizeServerUrl(address);
  if (!normalized.ok) return { ok: false, message: shellText(REJECTION_TEXT[normalized.reason]) };
  if (!(await probeBridgeServer(normalized.origin))) return { ok: false, message: shellText('connectUnreachable') };

  writeDesktopSettings(settingsFile(), { serverOrigin: normalized.origin });
  const changed = normalized.origin !== getAppOrigin();
  setAppOrigin(normalized.origin);
  if (!mainWindow) createMainWindow();
  else if (changed) loadAppOrigin();
  revealMainWindow();
  connectWindow?.close();
  return { ok: true };
});

function openConnectWindow(): void {
  if (connectWindow) {
    connectWindow.show();
    connectWindow.focus();
    return;
  }
  connectWindow = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    maximizable: false,
    title: 'Bridge',
    backgroundColor: '#0c0e1a',
    autoHideMenuBar: true,
    icon: assetPath('icon.png'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'connectPreload.js'),
    },
  });
  connectWindow.setMenu(null);
  connectWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  void connectWindow.loadFile(connectPagePath());
  connectWindow.once('ready-to-show', () => connectWindow?.show());
  connectWindow.on('closed', () => { connectWindow = null; });
}

// ─── MAIN WINDOW ──────────────────────────────────────────────
function loadAppOrigin(): void {
  const origin = getAppOrigin();
  if (!mainWindow || !origin) return;
  appPageLoaded = false;
  void mainWindow.loadURL(origin).catch((err: unknown) => console.error('[window] load failed:', err));
}

function installSessionPolicies(): void {
  // Electron must never weaken the server-owned nonce CSP. If the server
  // unexpectedly omits CSP on a document, install a strict fail-closed fallback
  // without unsafe-inline/eval. An existing policy is preserved byte-for-byte.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    const hasCsp = Object.keys(headers).some((key) => key.toLowerCase() === 'content-security-policy');
    const isDocument = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    if (hasCsp || !isDocument || !isSameAppOrigin(details.url)) return callback({ responseHeaders: headers });
    callback({
      responseHeaders: {
        ...headers,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; " +
          "media-src 'self' blob:; connect-src 'self' wss: https:; font-src 'self' data:; worker-src 'self' blob:; " +
          "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        ],
      },
    });
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed: string[] = ['media', 'display-capture', 'mediaKeySystem', 'notifications'];
    const requesterUrl = (webContents as { getURL?: () => string }).getURL?.() ?? '';
    callback(isSameAppOrigin(requesterUrl) && allowed.includes(permission));
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Bridge',
    backgroundColor: '#0c0e1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration:            false,
      contextIsolation:           true,
      sandbox:                    true,
      webSecurity:                true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: assetPath('icon.png'),
    show: false,
  });

  const startInBackground = process.argv.includes(BACKGROUND_ARG);
  mainWindow.once('ready-to-show', () => { if (!startInBackground) mainWindow?.show(); });
  mainWindow.webContents.on('did-finish-load', () => {
    appPageLoaded = isSameAppOrigin(mainWindow?.webContents.getURL() ?? '');
    if (appPageLoaded && pendingDeepLink) handleDeepLink(pendingDeepLink);
  });
  loadAppOrigin();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PENCERE ICI GEZINME KILITLENIR — DERINLEMESINE SAVUNMA
  // ══════════════════════════════════════════════════════════════════════════
  // `setWindowOpenHandler` YALNIZCA YENI pencere/sekme acilislarini kapsar.
  // ANA pencerenin KENDI icinde baska bir adrese gitmesini engellemez
  // (`window.location`, `<a target="_self">`, meta refresh, JS yonlendirme).
  //
  // NEDEN ONEMLI: `setPermissionRequestHandler` bu oturuma mikrofon/kamera gibi
  // izinleri VERIR. Pencere dusman bir adrese giderse, o kaynak ZATEN VERILMIS
  // izinleri devralir. Bridge masaustu istemcisi TEK bir sunucu kaynagini yukler;
  // disari cikan her gezinme varsayilan tarayiciya devredilir.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isSameAppOrigin(url)) return;                // uygulama ici gezinme serbest
    event.preventDefault();
    openExternalSafely(url);
  });

  // Alt cerceve (iframe/webview) gezinmeleri de ayni kurala tabidir.
  mainWindow.webContents.on('will-frame-navigate', (event: Electron.Event & { url?: string }) => {
    const url = String((event as { url?: string }).url ?? '');
    if (!isSameAppOrigin(url)) event.preventDefault();
  });

  // Yeni bir webview eklenmesi ENGELLENIR.
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  mainWindow.on('close', (e: Electron.Event) => {
    if (!isQuitting && process.platform !== 'darwin') {
      e.preventDefault();
      mainWindow!.hide();
      if (!backgroundNoticeShown) {
        backgroundNoticeShown = true;
        tray?.displayBalloon({ title: 'Bridge', content: shellText('backgroundRunning'), iconType: 'info' });
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; appPageLoaded = false; });

  const viewItems: Electron.MenuItemConstructorOptions[] = [
    { label: shellText('reload'), accelerator: 'CmdOrCtrl+R', click: () => mainWindow!.reload() },
  ];
  // Developer tools only in development builds; an installed app exposes no dev console.
  if (!app.isPackaged) {
    viewItems.push({ label: 'DevTools', accelerator: 'F12', click: () => mainWindow!.webContents.toggleDevTools() });
  }
  viewItems.push(
    { type: 'separator' },
    { label: shellText('zoomIn'), accelerator: 'CmdOrCtrl+Plus',  click: () => { mainWindow!.webContents.zoomFactor = Math.min(mainWindow!.webContents.zoomFactor + 0.1, 3); } },
    { label: shellText('zoomOut'),  accelerator: 'CmdOrCtrl+-',     click: () => { mainWindow!.webContents.zoomFactor = Math.max(mainWindow!.webContents.zoomFactor - 0.1, 0.5); } },
    { label: shellText('resetZoom'),     accelerator: 'CmdOrCtrl+0',     click: () => { mainWindow!.webContents.zoomFactor = 1; } },
  );

  const menu = Menu.buildFromTemplate([
    {
      label: 'Bridge',
      submenu: [
        { label: shellText('about'), click: () => showAbout() },
        { type: 'separator' },
        { label: shellText('checkUpdates'), click: () => { void checkForBridgeUpdates(true); } },
        { label: shellText('installRestart'), click: () => { installDownloadedUpdate(); } },
        { label: shellText('changeServer'), click: () => openConnectWindow() },
        { type: 'separator' },
        { label: shellText('quit'), accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    { label: shellText('view'), submenu: viewItems },
  ]);
  Menu.setApplicationMenu(menu);
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'Bridge',
    message: shellText('about'),
    detail: shellText('aboutDetail', { version: app.getVersion() }),
    icon: nativeImage.createFromPath(assetPath('icon.png')),
  });
}

// ─── APP LIFECYCLE ────────────────────────────────────────────
app.whenReady().then(() => {
  if (!gotLock) return;
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
  console.log(`🌉 ${shellText('appStarting')}`);

  installSessionPolicies();
  createTray();

  const { serverOrigin } = readDesktopSettings(settingsFile());
  if (serverOrigin) {
    setAppOrigin(serverOrigin);
    createMainWindow();
  } else {
    openConnectWindow();
  }

  setupBridgeAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
    else if (getAppOrigin()) createMainWindow();
    else openConnectWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isQuitting = true; });
app.on('quit', () => {
  teardownBridgeAutoUpdater();
  tray?.destroy();
});

/** Test hooks — module state is otherwise private to the Electron main process. */
export const _testing = {
  handleDeepLink,
  deepLinkFromArgv,
  getPendingDeepLink: (): string | null => pendingDeepLink,
  getMainWindow: (): BrowserWindow | null => mainWindow,
  getConnectWindow: (): BrowserWindow | null => connectWindow,
  isConnectPageSender,
  connectPagePath,
};
