// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/OfflineBannerPanel.svelte
//              client/js/core/offline-banner-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/offline-banner.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Çevrimdışı banner: bağlantı kesilince göster, gelince gizle.

'use strict';

// ── Tip tanımları ─────────────────────────────────────────────

export interface OfflineBannerAPI {
  readonly isOffline: boolean;
  setOffline(): void;
  setOnline(pendingCount?: number): void;
}

interface SWNetworkStatusMessage {
  type: 'SW_NETWORK_STATUS';
  online: boolean;
}

interface SWOutboxFlushedMessage {
  type: 'OUTBOX_FLUSHED';
  remaining?: number;
}

type SWMessage = SWNetworkStatusMessage | SWOutboxFlushedMessage | { type: string };

// ── Sabitler ────────────────────────────────────────────────

const BANNER_ID = 'bridge-offline-banner';
const RECONNECTED_ID = 'bridge-reconnect-toast';
const OFFLINE_INPUT_PLACEHOLDER = '✈️ Çevrimdışısın — mesajlar kuyrukta bekler';
const RECONNECT_MSG = '🟢 Bağlantı yeniden kuruldu';

const CSS = `
  #${BANNER_ID} {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 99999;
    background: #ed4245;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: .3px;
    text-align: center;
    padding: 0 12px;
    height: 0;
    overflow: hidden;
    transition: height 220ms cubic-bezier(.4,0,.2,1),
                padding-top 220ms, padding-bottom 220ms;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    pointer-events: none;
    user-select: none;
  }
  #${BANNER_ID}.is-visible {
    height: 34px;
    padding-top: 6px;
    padding-bottom: 6px;
    pointer-events: auto;
  }
  #${BANNER_ID} .ob-icon { font-size: 15px; animation: ob-pulse 1.4s ease-in-out infinite; }
  @keyframes ob-pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

  #${RECONNECTED_ID} {
    position: fixed;
    bottom: 24px; left: 50%; transform: translateX(-50%) translateY(60px);
    z-index: 99999;
    background: #3ba55d;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    padding: 9px 20px;
    border-radius: 20px;
    box-shadow: 0 4px 16px rgba(0,0,0,.35);
    transition: transform 280ms cubic-bezier(.4,0,.2,1), opacity 280ms;
    opacity: 0;
    pointer-events: none;
  }
  #${RECONNECTED_ID}.is-visible {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }

  body.bridge-offline #msg-input {
    background: var(--input-bg, #1e2124) !important;
    opacity: .6;
    cursor: not-allowed;
  }
  body.bridge-offline .msg-send-btn {
    opacity: .4;
    pointer-events: none;
  }

  .offline-cache-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(237,66,69,.18);
    color: #ed4245;
    border: 1px solid rgba(237,66,69,.3);
    border-radius: 10px;
    padding: 1px 7px;
    margin-left: 8px;
    vertical-align: middle;
    animation: ob-pulse 1.4s ease-in-out infinite;
  }
`;

// ── DOM — banner & toast ─────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('bridge-offline-styles')) return;
  const style = document.createElement('style');
  style.id = 'bridge-offline-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function createBanner(): void {
  if (document.getElementById(BANNER_ID)) return;
  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<span class="ob-icon">📡</span><span class="ob-text">Çevrimdışısın — geçmiş mesajlar önbellekten gösteriliyor</span>`;
  document.body.insertBefore(el, document.body.firstChild);
}

function createReconnectToast(): void {
  if (document.getElementById(RECONNECTED_ID)) return;
  const el = document.createElement('div');
  el.id = RECONNECTED_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  el.textContent = RECONNECT_MSG;
  document.body.appendChild(el);
}

// ── Durum yönetimi ────────────────────────────────────────────

let _isOffline = false;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _originalInputPlaceholder: string | null = null;

export function setOffline(): void {
  if (_isOffline) return;
  _isOffline = true;
  if (_reconnectTimer) clearTimeout(_reconnectTimer);

  document.body.classList.add('bridge-offline');
  document.getElementById(BANNER_ID)?.classList.add('is-visible');

  const input = document.getElementById('msg-input') as HTMLInputElement | null;
  if (input) {
    _originalInputPlaceholder = input.placeholder;
    input.placeholder = OFFLINE_INPUT_PLACEHOLDER;
    input.dataset.offlineDisabled = '1';
  }

  _attachCacheBadge();
  dispatchEvent(new CustomEvent('bridge:offline'));
}

export function setOnline(pendingCount = 0): void {
  if (!_isOffline) return;
  _isOffline = false;

  document.body.classList.remove('bridge-offline');
  document.getElementById(BANNER_ID)?.classList.remove('is-visible');

  const input = document.getElementById('msg-input') as HTMLInputElement | null;
  if (input?.dataset.offlineDisabled) {
    input.placeholder = _originalInputPlaceholder ?? 'Bir mesaj yaz…';
    delete input.dataset.offlineDisabled;
  }

  _removeCacheBadge();
  _showReconnectToast(pendingCount);
  dispatchEvent(new CustomEvent('bridge:online', { detail: { pendingCount } }));
}

function _showReconnectToast(pendingCount: number): void {
  const el = document.getElementById(RECONNECTED_ID);
  if (!el) return;
  el.textContent = pendingCount > 0
    ? `${RECONNECT_MSG} — ${pendingCount} mesaj gönderiliyor…`
    : RECONNECT_MSG;
  el.classList.add('is-visible');
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => el.classList.remove('is-visible'), 3500);
}

function _attachCacheBadge(): void {
  _removeCacheBadge();
  const channelName =
    document.getElementById('channel-name') ??
    document.querySelector('.channel-name-header') ??
    document.querySelector('[data-channel-name]');
  if (!channelName) return;
  const badge = document.createElement('span');
  badge.className = 'offline-cache-badge';
  badge.id = 'bridge-cache-badge';
  badge.textContent = '📦 önbellek';
  channelName.appendChild(badge);
}

function _removeCacheBadge(): void {
  document.getElementById('bridge-cache-badge')?.remove();
}

// ── Sinyal kaynakları ─────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<SWMessage>) => {
    const data = event.data;
    if (data.type === 'SW_NETWORK_STATUS') {
      (data as SWNetworkStatusMessage).online ? setOnline() : setOffline();
    }
    if (data.type === 'OUTBOX_FLUSHED') {
      const remaining = (data as SWOutboxFlushedMessage).remaining ?? 0;
      if (remaining === 0 && !_isOffline) _showReconnectToast(0);
    }
  });

  navigator.serviceWorker.ready
    .then(reg => reg.active?.postMessage({ type: 'REQUEST_NETWORK_STATUS' }))
    .catch(() => { /* ignore */ });
}

window.addEventListener('offline', () => setOffline());
window.addEventListener('online', () => {
  if (!('serviceWorker' in navigator)) { setOnline(); return; }
  const guard = setTimeout(() => setOnline(), 1500);
  navigator.serviceWorker.ready
    .then(reg => reg.active?.postMessage({ type: 'REQUEST_NETWORK_STATUS' }))
    .catch(() => { clearTimeout(guard); setOnline(); });
});

// ── Başlangıç ─────────────────────────────────────────────────

function init(): void {
  injectStyles();
  createBanner();
  createReconnectToast();
  if (!navigator.onLine) setOffline();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.addEventListener('bridge:messages-from-cache', () => {
  if (_isOffline) _attachCacheBadge();
});

// ── Public API ─────────────────────────────────────────────────

export const bridgeOfflineBanner: OfflineBannerAPI = {
  get isOffline() { return _isOffline; },
  setOffline,
  setOnline,
};

(window as unknown as Record<string, unknown>)['bridgeOfflineBanner'] = bridgeOfflineBanner;

export const offlineBannerReady = true;
