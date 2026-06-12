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
    #${TOAST_ID} progress { width: 100%; height: 8px; margin: 0 0 12px; accent-color: #5865f2; }
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
  return version ? `v${version}` : 'yeni sürüm';
}

function shouldHide(state: BridgeUpdateState): boolean {
  return state.phase === 'idle' || state.phase === 'disabled' || state.phase === 'not-available';
}

function renderUpdaterToast(state: BridgeUpdateState): void {
  const toast = ensureToast();
  if (shouldHide(state)) {
    toast.hidden = true;
    return;
  }

  let title = 'Güncelleme kontrol ediliyor';
  let body = 'Bridge yeni sürüm olup olmadığını kontrol ediyor.';
  let progress = '';
  let actions = '<button class="secondary" type="button" data-action="hide">Kapat</button>';

  if (state.phase === 'available') {
    title = `${formatVersion(state.availableVersion)} bulundu`;
    body = 'Güncelleme arka planda indiriliyor. Bittiğinde yeniden başlatma düğmesi çıkacak.';
  } else if (state.phase === 'downloading') {
    title = `${formatVersion(state.availableVersion)} indiriliyor`;
    body = 'Uygulamayı kullanmaya devam edebilirsin.';
    progress = `<progress max="100" value="${Math.round(state.percent)}"></progress>`;
  } else if (state.phase === 'downloaded') {
    title = 'Güncelleme hazır';
    body = `${formatVersion(state.availableVersion)} indirildi. Kurulum için Bridge yeniden başlatılacak.`;
    actions = '<button class="secondary" type="button" data-action="hide">Sonra</button><button type="button" data-action="install">Yeniden başlat ve kur</button>';
  } else if (state.phase === 'error') {
    title = 'Güncelleme kontrolü başarısız';
    body = state.lastError || 'Güncelleme sunucusuna ulaşılamadı.';
    actions = '<button class="secondary" type="button" data-action="hide">Kapat</button><button type="button" data-action="check">Tekrar dene</button>';
  }

  toast.hidden = false;
  toast.innerHTML = `
    <strong>${title}</strong>
    <p>${body}</p>
    ${progress}
    <div class="bridge-updater-actions">${actions}</div>
  `;
}

function bindToastActions(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>(`#${TOAST_ID} button[data-action]`);
    if (!button || !window.bridgeUpdater) return;

    const action = button.dataset.action;
    if (action === 'hide') {
      const toast = document.getElementById(TOAST_ID);
      if (toast) toast.hidden = true;
    } else if (action === 'check') {
      void window.bridgeUpdater.check().then(renderUpdaterToast);
    } else if (action === 'install') {
      void window.bridgeUpdater.install();
    }
  });
}

export function initDesktopUpdater(): void {
  if (!window.bridgeUpdater) return;
  bindToastActions();

  window.bridgeUpdater.onStatus((state) => renderUpdaterToast(state));
  void window.bridgeUpdater.getStatus().then(renderUpdaterToast).catch(() => {});
}
