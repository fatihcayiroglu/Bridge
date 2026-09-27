import { BridgeRegistry } from './bridge-registry.ts';
import { t } from './i18n/index.ts';

// client/js/core/desktop-updater.ts
// Electron preload üzerinden gelen güncelleme durumunu Discord benzeri küçük bir panel/toast ile gösterir.

interface BridgeUpdateState {
  phase:
    | 'idle'
    | 'disabled'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  releaseName: string | null;
  percent: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  canInstall: boolean;
  isPackaged: boolean;
}

interface BridgeUpdaterAPI {
  getStatus(): Promise<BridgeUpdateState>;
  check(): Promise<BridgeUpdateState>;
  install(): Promise<BridgeUpdateState>;
  onStatus(cb: (data: BridgeUpdateState) => void): (() => void) | void;
}

declare global {
  interface Window {
    bridgeUpdater?: BridgeUpdaterAPI;
    electronBridge?: {
      onOpenSurface?(cb: (surface: 'voice-check' | 'system-health') => void): (() => void) | void;
    };
  }
}

const TOAST_ID = 'bridge-desktop-updater-toast';
const STYLE_ID = 'bridge-desktop-updater-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${TOAST_ID} {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483000;
      width: min(360px, calc(100vw - 40px));
      padding: 14px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 14px;
      background: rgba(25, 26, 32, .96);
      color: #fff;
      box-shadow: 0 18px 60px rgba(0,0,0,.35);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      backdrop-filter: blur(12px);
    }
    #${TOAST_ID}[hidden] { display: none; }
    #${TOAST_ID} strong { display: block; margin-bottom: 4px; font-size: 15px; }
    #${TOAST_ID} p { margin: 0 0 12px; color: rgba(255,255,255,.78); }
    #${TOAST_ID} .bridge-updater-actions { display: flex; gap: 8px; justify-content: flex-end; }
    #${TOAST_ID} button {
      border: 0;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
      color: #fff;
      background: rgba(88,101,242,.96);
      font-weight: 700;
    }
    #${TOAST_ID} button.secondary { background: rgba(255,255,255,.12); }
    #${TOAST_ID} progress { width: 100%; height: 8px; margin: 0 0 12px; accent-color: var(--brand, #2d9cdb); }
  `;
  document.head.appendChild(style);
}

function ensureToast(): HTMLElement {
  ensureStyles();
  let el = document.getElementById(TOAST_ID);
  if (!el) {
    el = document.createElement('section');
    el.id = TOAST_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function formatVersion(version: string | null): string {
  return version ? `v${version}` : t('updater_new_version', 'yeni sürüm');
}

function shouldHide(state: BridgeUpdateState): boolean {
  return state.phase === 'idle' || state.phase === 'disabled' || state.phase === 'not-available';
}

function appendAction(toast: HTMLElement, label: string, action: 'hide' | 'check' | 'install', secondary = false): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.textContent = label;
  if (secondary) button.classList.add('secondary');
  toast.appendChild(button);
}

function renderUpdaterToast(state: BridgeUpdateState): void {
  const toast = ensureToast();
  if (shouldHide(state)) {
    toast.hidden = true;
    return;
  }

  let title = t('updater_checking_title', 'Güncelleme kontrol ediliyor');
  let body = t('updater_checking_body', 'Bridge yeni sürüm olup olmadığını kontrol ediyor.');
  let showProgress = false;
  let actions: Array<{ label: string; action: 'hide' | 'check' | 'install'; secondary?: boolean }> = [
    { label: t('close', 'Kapat'), action: 'hide', secondary: true },
  ];

  if (state.phase === 'available') {
    title = t('updater_available_title', '{version} bulundu', { version: formatVersion(state.availableVersion) });
    body = t('updater_available_body', 'Güncelleme arka planda indiriliyor. Bittiğinde yeniden başlatma düğmesi çıkacak.');
  } else if (state.phase === 'downloading') {
    title = t('updater_downloading_title', '{version} indiriliyor', { version: formatVersion(state.availableVersion) });
    body = t('updater_downloading_body', 'Uygulamayı kullanmaya devam edebilirsin.');
    showProgress = true;
  } else if (state.phase === 'downloaded') {
    title = t('updater_ready_title', 'Güncelleme hazır');
    body = t('updater_ready_body', '{version} indirildi. Kurulum için Bridge yeniden başlatılacak.', { version: formatVersion(state.availableVersion) });
    actions = [
      { label: t('updater_later', 'Sonra'), action: 'hide', secondary: true },
      { label: t('updater_restart_install', 'Yeniden başlat ve kur'), action: 'install' },
    ];
  } else if (state.phase === 'error') {
    title = t('updater_failed_title', 'Güncelleme kontrolü başarısız');
    body = t('updater_server_unreachable', 'Güncelleme sunucusuna ulaşılamadı.');
    actions = [
      { label: t('close', 'Kapat'), action: 'hide', secondary: true },
      { label: t('retry', 'Tekrar dene'), action: 'check' },
    ];
  }

  // Updater metadata ultimately comes from a remote release feed. Never inject
  // it via innerHTML; keep every externally-derived value in textContent.
  toast.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = title;
  toast.appendChild(strong);

  const paragraph = document.createElement('p');
  paragraph.textContent = body;
  toast.appendChild(paragraph);

  if (showProgress) {
    const progress = document.createElement('progress');
    progress.max = 100;
    const rawPercent = Number.isFinite(state.percent) ? state.percent : 0;
    progress.value = Math.max(0, Math.min(100, Math.round(rawPercent)));
    toast.appendChild(progress);
  }

  const actionContainer = document.createElement('div');
  actionContainer.className = 'bridge-updater-actions';
  for (const action of actions) appendAction(actionContainer, action.label, action.action, Boolean(action.secondary));
  toast.appendChild(actionContainer);
  toast.hidden = false;
}

let actionsBound = false;
let boundUpdater: BridgeUpdaterAPI | null = null;
let statusUnsubscribe: (() => void) | null = null;

function bindToastActions(): void {
  if (actionsBound) return;
  actionsBound = true;
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>(`#${TOAST_ID} button[data-action]`);
    const updater = window.bridgeUpdater;
    if (!button || !updater) return;

    const action = button.dataset.action;
    if (action === 'hide') {
      const toast = document.getElementById(TOAST_ID);
      if (toast) toast.hidden = true;
    } else if (action === 'check') {
      void updater.check().then(renderUpdaterToast).catch(() => {
        renderUpdaterToast({
          phase: 'error', currentVersion: '', availableVersion: null, releaseDate: null,
          releaseName: null, percent: 0, lastCheckedAt: null,
          lastError: t('updater_server_unreachable', 'Güncelleme sunucusuna ulaşılamadı.'), canInstall: false, isPackaged: true,
        });
      });
    } else if (action === 'install') {
      // The updater process owns user-facing installation errors. Still attach
      // a rejection handler here so preload/process failures cannot surface as
      // an unhandled renderer promise rejection.
      void updater.install().catch(() => undefined);
    }
  });
}

export function initDesktopUpdater(): void {
  window.electronBridge?.onOpenSurface?.((surface) => {
    if (surface === 'voice-check') BridgeRegistry.call('openVoiceCheck');
    else if (surface === 'system-health') BridgeRegistry.call('openServerSettings', 'health');
  });

  const updater = window.bridgeUpdater;
  if (!updater) return;
  bindToastActions();

  // Re-initialization can happen during hot reload or shell remounts. Keep a
  // single status subscription per preload API instance.
  if (boundUpdater !== updater) {
    statusUnsubscribe?.();
    statusUnsubscribe = updater.onStatus((state) => renderUpdaterToast(state)) || null;
    boundUpdater = updater;
  }
  void updater.getStatus().then(renderUpdaterToast).catch(() => {});
}
