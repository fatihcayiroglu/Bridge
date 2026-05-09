// electron/main.js
// Additions: deep link (bridge://), system tray, native OS notifications

const {
  app, BrowserWindow, shell, Menu, Tray,
  Notification, nativeImage, session, ipcMain,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path   = require('path');
const { spawn } = require('child_process');
const http   = require('http');

let mainWindow;
let tray;
let serverProcess;

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
  app.on('second-instance', (event, argv) => {
    // Someone opened bridge:// while app is running
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = argv.find(a => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (url) handleDeepLink(url);
  });
}

// Geçerli bridge:// yolu kalıpları
// Yalnızca bu kalıplara uyan URL'ler işlenir; diğerleri sessizce reddedilir.
const DEEPLINK_PATTERNS = [
  /^bridge:\/\/servers\/([a-zA-Z0-9_-]{1,64})$/,
  /^bridge:\/\/channels\/([a-zA-Z0-9_-]{1,64})$/,
  /^bridge:\/\/invite\/([a-zA-Z0-9_-]{1,32})$/,
];

function handleDeepLink(url) {
  // bridge://servers/SERVERID   — navigate to server
  // bridge://channels/CHANNELID — navigate to channel
  // bridge://invite/CODE        — open invite
  if (!mainWindow) return;

  // Güvenlik: URL kalıp doğrulaması — executeJavaScript injection'ını önler
  const isAllowed = DEEPLINK_PATTERNS.some(pattern => pattern.test(url));
  if (!isAllowed) {
    console.warn('[deeplink] Geçersiz veya izinsiz URL reddedildi:', url);
    return;
  }

  // url artık doğrulanmış durumda; JSON.stringify ile güvenle gömülebilir
  mainWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('bridge:deeplink', { detail: { url: ${JSON.stringify(url)} } }))`
  );
}

// ─── START BACKEND ────────────────────────────────────────────
// startServerControlled() tarafından karşılanıyor (IPC + log yayını)

// ─── WAIT FOR SERVER ──────────────────────────────────────────
function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    const check = (n) => {
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
function createTray() {
  // Use a plain icon — fallback to empty 16x16 if icon.png absent
  let icon;
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
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      },
    },
    { type: 'separator' },
    {
      label: 'Bildirimler',
      type: 'checkbox',
      checked: true,
      click: (item) => {
        mainWindow?.webContents.send('tray:notifications-toggle', item.checked);
      },
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ─── NATIVE NOTIFICATIONS ─────────────────────────────────────
// Renderer -> main IPC to show OS notification (bypasses browser permission)
ipcMain.on('bridge:notify', (event, { title, body, icon: iconUrl }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: title || 'Bridge',
    body:  body  || '',
    // icon: iconUrl ? nativeImage.createFromDataURL(iconUrl) : undefined,
    silent: false,
  });
  n.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  n.show();
});

// ─── SERVER CONTROL IPC ───────────────────────────────────────
// Renderer'dan sunucuyu başlatma/durdurma/yeniden başlatma

let serverLogs = [];      // Son 200 satır log tamponu
let serverStatus = 'stopped'; // 'stopped' | 'starting' | 'running' | 'error'

function broadcastServerStatus() {
  mainWindow?.webContents.send('server:status', {
    status: serverStatus,
    pid: serverProcess?.pid || null,
  });
}

function broadcastLog(line, level = 'info') {
  const entry = { t: Date.now(), level, line };
  serverLogs.push(entry);
  if (serverLogs.length > 200) serverLogs.shift();
  mainWindow?.webContents.send('server:log', entry);
}

function startServerControlled() {
  if (serverProcess && !serverProcess.killed) return; // zaten çalışıyor
  serverStatus = 'starting';
  broadcastServerStatus();
  broadcastLog('Sunucu başlatılıyor…', 'info');

  const serverPath = path.join(__dirname, '../server/index.js');
  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: '3001' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (d) => {
    const line = d.toString().trim();
    console.log('[Server]', line);
    if (serverStatus === 'starting') { serverStatus = 'running'; broadcastServerStatus(); }
    broadcastLog(line, 'info');
  });

  serverProcess.stderr.on('data', (d) => {
    const line = d.toString().trim();
    console.error('[Server Error]', line);
    broadcastLog(line, 'error');
  });

  serverProcess.on('exit', (code) => {
    broadcastLog(`Sunucu durdu (kod: ${code})`, code === 0 ? 'info' : 'error');
    serverProcess = null;
    serverStatus = code === 0 ? 'stopped' : 'error';
    broadcastServerStatus();
  });
}

function stopServerControlled() {
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

ipcMain.on('server:start', () => startServerControlled());
ipcMain.on('server:stop',  () => stopServerControlled());
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
  pid: serverProcess?.pid || null,
  logs: serverLogs,
}));

// ─── CREATE WINDOW ────────────────────────────────────────────
function createWindow() {
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

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'display-capture', 'mediaKeySystem', 'notifications'];
    callback(allowed.includes(permission));
  });

  mainWindow.loadURL('http://localhost:3001');

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Intercept external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle macOS open-url deep link
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  // Minimize to tray instead of closing (Windows/Linux)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting && process.platform !== 'darwin') {
      e.preventDefault();
      mainWindow.hide();
      tray?.displayBalloon?.({
        title: 'Bridge',
        content: 'Bridge arka planda çalışmaya devam ediyor.',
      });
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'Bridge',
      submenu: [
        { label: 'Bridge Hakkında', click: () => {} },
        { type: 'separator' },
        { label: 'Çıkış', accelerator: 'CmdOrCtrl+Q', click: () => { app.isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { label: 'Yenile', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { label: 'DevTools', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Yakınlaştır',   accelerator: 'CmdOrCtrl+Plus', click: () => { mainWindow.webContents.zoomFactor = Math.min(mainWindow.webContents.zoomFactor + 0.1, 3); } },
        { label: 'Uzaklaştır',   accelerator: 'CmdOrCtrl+-',    click: () => { mainWindow.webContents.zoomFactor = Math.max(mainWindow.webContents.zoomFactor - 0.1, 0.5); } },
        { label: 'Sıfırla',      accelerator: 'CmdOrCtrl+0',    click: () => { mainWindow.webContents.zoomFactor = 1; } },
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

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { app.isQuitting = true; });

app.on('quit', () => {
  serverProcess?.kill();
  tray?.destroy();
});
