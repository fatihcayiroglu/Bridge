// electron/updater.ts
// Discord benzeri otomatik güncelleme akışı:
// - Uygulama açılınca ve periyodik olarak güncelleme kontrol eder.
// - Yeni sürüm varsa arka planda indirir.
// - İndirme bitince renderer'a/tray/menu'ye "yeniden başlat ve kur" durumunu bildirir.

import { app, BrowserWindow, Notification, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface BridgeUpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  releaseName: string | null;
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  canInstall: boolean;
  isPackaged: boolean;
}

interface UpdateInfoLike {
  version?: string;
  releaseDate?: string;
  releaseName?: string;
}

interface ProgressInfoLike {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

type MainWindowGetter = () => BrowserWindow | null;

type MutableAutoUpdater = typeof autoUpdater & {
  checkForUpdates?: () => Promise<unknown>;
  checkForUpdatesAndNotify?: () => Promise<unknown>;
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  allowPrerelease?: boolean;
  quitAndInstall?: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
};

const UPDATE_CHECK_INTERVAL_MS = Math.max(
  Number(process.env.BRIDGE_UPDATE_INTERVAL_MS ?? 30 * 60 * 1000),
  5 * 60 * 1000,
);

const FORCE_UPDATER_IN_DEV = process.env.BRIDGE_UPDATER_FORCE === 'true';

let mainWindowGetter: MainWindowGetter = () => null;
let setupDone = false;
let updateTimer: NodeJS.Timeout | null = null;
let activeCheck: Promise<BridgeUpdateState> | null = null;

let state: BridgeUpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  releaseDate: null,
  releaseName: null,
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  lastCheckedAt: null,
  lastError: null,
  canInstall: false,
  isPackaged: app.isPackaged,
};

function normalizePercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function updateState(patch: Partial<BridgeUpdateState>): BridgeUpdateState {
  state = { ...state, ...patch, currentVersion: app.getVersion(), isPackaged: app.isPackaged };
  broadcastUpdateState();
  return state;
}

function broadcastUpdateState(): void {
  const win = mainWindowGetter();
  if (!win || win.webContents.isDestroyed?.()) return;
  win.webContents.send('updater:status', state);
}

function showUpdateReadyNotification(version: string | null): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Bridge güncellemesi hazır',
    body: version
      ? `v${version} indirildi. Kurmak için Bridge’i yeniden başlat.`
      : 'Yeni sürüm indirildi. Kurmak için Bridge’i yeniden başlat.',
    silent: false,
  });
  notification.on('click', () => {
    const win = mainWindowGetter();
    win?.show();
    win?.focus();
  });
  notification.show();
}

function getUpdater(): MutableAutoUpdater {
  return autoUpdater as MutableAutoUpdater;
}

function wireAutoUpdaterEvents(): void {
  const updater = getUpdater();

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = process.env.BRIDGE_UPDATE_CHANNEL === 'beta';

  updater.on('checking-for-update', () => {
    updateState({
      phase: 'checking',
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      percent: 0,
      canInstall: false,
    });
  });

  updater.on('update-available', (info: UpdateInfoLike) => {
    updateState({
      phase: 'available',
      availableVersion: info?.version ?? null,
      releaseDate: info?.releaseDate ?? null,
      releaseName: info?.releaseName ?? null,
      lastError: null,
      percent: 0,
      canInstall: false,
    });
  });

  updater.on('download-progress', (progress: ProgressInfoLike) => {
    updateState({
      phase: 'downloading',
      percent: normalizePercent(progress?.percent),
      bytesPerSecond: Number(progress?.bytesPerSecond ?? 0),
      transferred: Number(progress?.transferred ?? 0),
      total: Number(progress?.total ?? 0),
      lastError: null,
      canInstall: false,
    });
  });

  updater.on('update-downloaded', (info: UpdateInfoLike) => {
    updateState({
      phase: 'downloaded',
      availableVersion: info?.version ?? state.availableVersion,
      releaseDate: info?.releaseDate ?? state.releaseDate,
      releaseName: info?.releaseName ?? state.releaseName,
      percent: 100,
      lastError: null,
      canInstall: true,
    });
    showUpdateReadyNotification(info?.version ?? state.availableVersion);
  });

  updater.on('update-not-available', () => {
    updateState({
      phase: 'not-available',
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      percent: 0,
      canInstall: false,
    });
  });

  updater.on('error', (error: Error) => {
    updateState({
      phase: 'error',
      lastError: error?.message || 'Güncelleme kontrolü başarısız oldu.',
      canInstall: false,
    });
  });
}

export function getUpdateState(): BridgeUpdateState {
  return state;
}

export async function checkForBridgeUpdates(manual = false): Promise<BridgeUpdateState> {
  if (!app.isPackaged && !FORCE_UPDATER_IN_DEV) {
    return updateState({
      phase: 'disabled',
      lastCheckedAt: new Date().toISOString(),
      lastError: manual ? 'Otomatik güncelleme sadece paketlenmiş masaüstü uygulamasında çalışır.' : null,
      canInstall: false,
    });
  }

  if (state.phase === 'checking' || state.phase === 'downloading') return state;
  if (activeCheck) return activeCheck;

  activeCheck = (async () => {
    try {
      updateState({
        phase: 'checking',
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
      });

      const updater = getUpdater();
      if (typeof updater.checkForUpdates === 'function') {
        await updater.checkForUpdates();
      } else if (typeof updater.checkForUpdatesAndNotify === 'function') {
        await updater.checkForUpdatesAndNotify();
      } else {
        throw new Error('electron-updater check API bulunamadı.');
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Güncelleme kontrolü başarısız oldu.';
      return updateState({ phase: 'error', lastError: message, canInstall: false });
    } finally {
      activeCheck = null;
    }
  })();

  return activeCheck;
}

export function installDownloadedUpdate(): BridgeUpdateState {
  if (!state.canInstall) {
    return updateState({
      phase: state.phase === 'downloaded' ? 'downloaded' : 'error',
      lastError: 'Kurulmaya hazır indirilmiş güncelleme yok.',
    });
  }

  (app as typeof app & { isQuitting?: boolean }).isQuitting = true;
  getUpdater().quitAndInstall?.(false, true);
  return state;
}

function registerUpdaterIpc(): void {
  ipcMain.handle('updater:getStatus', () => getUpdateState());
  ipcMain.handle('updater:check', () => checkForBridgeUpdates(true));
  ipcMain.handle('updater:install', () => installDownloadedUpdate());
}

export function setupBridgeAutoUpdater(getMainWindow: MainWindowGetter): void {
  mainWindowGetter = getMainWindow;
  if (setupDone) return;
  setupDone = true;

  wireAutoUpdaterEvents();
  registerUpdaterIpc();

  // Discord benzeri: başlangıçta kısa gecikme ile kontrol et, sonra periyodik kontrol et.
  setTimeout(() => { void checkForBridgeUpdates(false); }, 10_000);
  updateTimer = setInterval(() => { void checkForBridgeUpdates(false); }, UPDATE_CHECK_INTERVAL_MS);
  updateTimer.unref?.();
}

export function teardownBridgeAutoUpdater(): void {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
}
