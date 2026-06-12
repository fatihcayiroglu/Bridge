// electron/main.ts
// Additions: deep link (bridge://), system tray, native OS notifications

import {
  app, BrowserWindow, shell, Menu, Tray,
  Notification, nativeImage, session, ipcMain,
} from 'electron';
import {
  checkForBridgeUpdates,
  installDownloadedUpdate,
  setupBridgeAutoUpdater,
  teardownBridgeAutoUpdater,
} from './updater';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverProcess: ChildProcess | null = null;

const DEEP_LINK_SCHEME = 'bridge';

// ─── DEEP LINK PROTOCOL ───────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

// Windows: single instance lock for deep link handling
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event: Electron.Event, argv: string[]) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (url) handleDeepLink(url);
  });
}

// Geçerli bridge:// yolu kalıpları
const DEEPLINK_PATTERNS: RegExp[] = [
  /^bridge:\/\/servers\/([a-zA-Z0-9_-]{1,64})$/,
  /^bridge:\/\/channels\/([a-zA-Z0-9_-]{1,64})$/,
  /^bridge:\/\/invite\/([a-zA-Z0-9_-]{1,32})$/,
];

function handleDeepLink(url: string): void {
  if (!mainWindow) return;
  const isAllowed = DEEPLINK_PATTERNS.some((pattern) => pattern.test(url));
  if (!isAllowed) {
    console.warn('[deeplink] Geçersiz veya izinsiz URL reddedildi:', url);
    return;
  }
  mainWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('bridge:deeplink', { detail: { url: ${JSON.stringify(url)} } }))`
  );
}

// ─── WAIT FOR SERVER ──────────────────────────────────────────
function waitForServer(retries = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (n: number): void => {
      http.get('http://localhost:3001', () => resolve())
        .on('error', () => {
          if (n <= 0) return reject(new Error('Server did not start'));
          setTimeout(() => check(n - 1), 500);
        });
    };
    check(retries);
  });
}

// ─── SYSTEM TRAY ─────────────────────────────────────────────
function createTray(): void {
  let icon: Electron.NativeImage;
  const iconPath = path.join(__dirname, 'icon.png');
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Bridge');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Bridge\'i Aç',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    },
    { type: 'separator' },
    {
      label: 'Bildirimler',
      type: 'checkbox',
      checked: true,
      click: (item: Electron.MenuItem) => {
        mainWindow?.webContents.send('tray:notifications-toggle', item.checked);
      },
    },
    { type: 'separator' },
    {
      label: 'Güncellemeleri Kontrol Et',
      click: () => { void checkForBridgeUpdates(true); },
    },
    {
      label: 'Güncellemeyi Kur ve Yeniden Başlat',
      click: () => { installDownloadedUpdate(); },
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => { (app as any).isQuitting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─── NATIVE NOTIFICATIONS ─────────────────────────────────────
interface NotifyPayload { title: string; body: string; icon?: string; }

ipcMain.on('bridge:notify', (_event: Electron.IpcMainEvent, { title, body }: NotifyPayload) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: title || 'Bridge',
    body:  body  || '',
    silent: false,
  });
  n.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  n.show();
});

// ─── SERVER CONTROL IPC ───────────────────────────────────────
function resolveBundledServerEntry(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? path.join(__dirname, '..');
  const candidates = app.isPackaged
    ? [
        path.join(resourcesPath, 'server', 'index.js'),
        path.join(resourcesPath, 'server', 'dist', 'index.js'),
      ]
    : [
        path.join(__dirname, '..', '..', 'server', 'dist', 'index.js'),
        path.join(__dirname, '..', '..', 'server', 'index.js'),
      ];

  return candidates.find((candidate) => {
    try { return require('fs').existsSync(candidate); } catch { return false; }
  }) ?? candidates[0]!;
}

type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';
interface LogEntry { t: number; level: 'info' | 'error'; line: string; }

let serverLogs: LogEntry[] = [];
let serverStatus: ServerStatus = 'stopped';

function broadcastServerStatus(): void {
  mainWindow?.webContents.send('server:status', {
    status: serverStatus,
    pid: serverProcess?.pid ?? null,
  });
}

function broadcastLog(line: string, level: 'info' | 'error' = 'info'): void {
  const entry: LogEntry = { t: Date.now(), level, line };
  serverLogs.push(entry);
  if (serverLogs.length > 200) serverLogs.shift();
  mainWindow?.webContents.send('server:log', entry);
}

function startServerControlled(): void {
  if (serverProcess && !serverProcess.killed) return;
  serverStatus = 'starting';
  broadcastServerStatus();
  broadcastLog('Sunucu başlatılıyor…', 'info');

  const serverPath = resolveBundledServerEntry();
  serverProcess = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: '3001', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    console.log('[Server]', line);
    if (serverStatus === 'starting') { serverStatus = 'running'; broadcastServerStatus(); }
    broadcastLog(line, 'info');
  });

  serverProcess.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    console.error('[Server Error]', line);
    broadcastLog(line, 'error');
  });

  serverProcess.on('exit', (code: number | null) => {
    broadcastLog(`Sunucu durdu (kod: ${code})`, code === 0 ? 'info' : 'error');
    serverProcess = null;
    serverStatus = code === 0 ? 'stopped' : 'error';
    broadcastServerStatus();
  });
}

function stopServerControlled(): void {
  if (!serverProcess || serverProcess.killed) {
    serverStatus = 'stopped';
    broadcastServerStatus();
    return;
  }
  broadcastLog('Sunucu durduruluyor…', 'info');
  serverProcess.kill('SIGTERM');
  setTimeout(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }, 5000);
}

ipcMain.on('server:start',   () => startServerControlled());
ipcMain.on('server:stop',    () => stopServerControlled());
ipcMain.on('server:restart', () => {
  broadcastLog('Yeniden başlatılıyor…', 'info');
  if (serverProcess && !serverProcess.killed) {
    serverProcess.once('exit', () => startServerControlled());
    stopServerControlled();
  } else {
    startServerControlled();
  }
});
ipcMain.handle('server:getStatus', () => ({
  status: serverStatus,
  pid: serverProcess?.pid ?? null,
  logs: serverLogs,
}));

// ─── CREATE WINDOW ────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1b1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'win32',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration:            false,
      contextIsolation:           true,
      webSecurity:                true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
  });

  // Sprint 122 FIX 8: Content Security Policy — Electron'da XSS → RCE zincirini engeller.
  // nodeIntegration=false + contextIsolation=true ile birlikte derinlemesine savunma.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' http://localhost:3001 ws://localhost:3001;" +
          "script-src 'self' 'unsafe-inline' http://localhost:3001;" +
          "style-src 'self' 'unsafe-inline';" +
          "img-src 'self' data: blob: http://localhost:3001 https:;" +
          "media-src 'self' blob: http://localhost:3001;" +
          "connect-src 'self' http://localhost:3001 ws://localhost:3001 wss://localhost:3001;" +
          "font-src 'self' data:;" +
          "worker-src 'self' blob:;" +
          "frame-ancestors 'none';"
        ],
      },
    });
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed: string[] = ['media', 'display-capture', 'mediaKeySystem', 'notifications'];
    callback(allowed.includes(permission));
  });

  mainWindow.loadURL('http://localhost:3001');
  mainWindow.once('ready-to-show', () => mainWindow!.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  mainWindow.on('close', (e: Electron.Event) => {
    if (!(app as any).isQuitting && process.platform !== 'darwin') {
      e.preventDefault();
      mainWindow!.hide();
      (tray as any)?.displayBalloon?.({
        title: 'Bridge',
        content: 'Bridge arka planda çalışmaya devam ediyor.',
      });
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  const menu = Menu.buildFromTemplate([
    {
      label: 'Bridge',
      submenu: [
        { label: 'Bridge Hakkında', click: () => {} },
        { type: 'separator' },
        { label: 'Güncellemeleri Kontrol Et', click: () => { void checkForBridgeUpdates(true); } },
        {
          label: 'Güncellemeyi Kur ve Yeniden Başlat',
          click: () => { installDownloadedUpdate(); },
        },
        { type: 'separator' },
        { label: 'Çıkış', accelerator: 'CmdOrCtrl+Q', click: () => { (app as any).isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { label: 'Yenile',       accelerator: 'CmdOrCtrl+R',    click: () => mainWindow!.reload() },
        { label: 'DevTools',     accelerator: 'F12',             click: () => mainWindow!.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Yakınlaştır', accelerator: 'CmdOrCtrl+Plus',  click: () => { mainWindow!.webContents.zoomFactor = Math.min(mainWindow!.webContents.zoomFactor + 0.1, 3); } },
        { label: 'Uzaklaştır',  accelerator: 'CmdOrCtrl+-',     click: () => { mainWindow!.webContents.zoomFactor = Math.max(mainWindow!.webContents.zoomFactor - 0.1, 0.5); } },
        { label: 'Sıfırla',     accelerator: 'CmdOrCtrl+0',     click: () => { mainWindow!.webContents.zoomFactor = 1; } },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ─── APP LIFECYCLE ────────────────────────────────────────────
app.whenReady().then(async () => {
  console.log('🌉 Bridge başlatılıyor…');
  startServerControlled();

  try {
    await waitForServer();
    console.log('✅ Sunucu hazır');
  } catch (e) {
    console.error('Sunucu başlatılamadı');
  }

  createTray();
  createWindow();

  setupBridgeAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { (app as any).isQuitting = true; });
app.on('quit', () => {
  teardownBridgeAutoUpdater();
  serverProcess?.kill();
  tray?.destroy();
});
