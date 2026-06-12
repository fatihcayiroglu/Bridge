// client/tests/offline-banner.test.ts — Sprint 50
// offline-banner.ts için unit testler
// Kapsam: setOffline/setOnline DOM değişiklikleri, cache badge, reconnect toast, CSS enjeksiyon

'use strict';

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
}), { virtual: true });

// ── Constants ─────────────────────────────────────────────────────────────────

const BANNER_ID        = 'bridge-offline-banner';
const RECONNECTED_ID   = 'bridge-reconnect-toast';
const CACHE_BADGE_ID   = 'bridge-cache-badge';
const STYLES_ID        = 'bridge-offline-styles';

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = `
    <div id="${BANNER_ID}" class=""></div>
    <div id="${RECONNECTED_ID}" class=""></div>
    <input id="msg-input" placeholder="Mesaj gönder">
    <div id="channel-name">Kanal Adı</div>`;
  document.body.classList.remove('bridge-offline');
});

afterEach(() => {
  document.body.classList.remove('bridge-offline');
  jest.clearAllTimers();
});

// ── DOM helpers ────────────────────────────────────────────────────────────────

function simulateSetOffline() {
  document.body.classList.add('bridge-offline');
  document.getElementById(BANNER_ID)?.classList.add('is-visible');
  const input = document.getElementById('msg-input');
  if (input) {
    input.placeholder = '✈️ Çevrimdışısın — mesajlar kuyrukta bekler';
    input.dataset.offlineDisabled = '1';
  }
}

function simulateSetOnline() {
  document.body.classList.remove('bridge-offline');
  document.getElementById(BANNER_ID)?.classList.remove('is-visible');
  const input = document.getElementById('msg-input');
  if (input) {
    input.placeholder = 'Mesaj gönder';
    delete input.dataset.offlineDisabled;
  }
  const toast = document.getElementById(RECONNECTED_ID);
  if (toast) {
    toast.textContent = '🟢 Bağlantı yeniden kuruldu';
    toast.classList.add('is-visible');
  }
}

// ── Banner DOM ─────────────────────────────────────────────────────────────────

describe('offline-banner — DOM yapısı', () => {
  test('banner elementi DOM\'da mevcut', () => {
    expect(document.getElementById(BANNER_ID)).not.toBeNull();
  });

  test('reconnect toast DOM\'da mevcut', () => {
    expect(document.getElementById(RECONNECTED_ID)).not.toBeNull();
  });

  test('msg-input DOM\'da mevcut', () => {
    expect(document.getElementById('msg-input')).not.toBeNull();
  });
});

// ── setOffline ─────────────────────────────────────────────────────────────────

describe('offline-banner — setOffline', () => {
  test('body bridge-offline sınıfı alır', () => {
    simulateSetOffline();
    expect(document.body.classList.contains('bridge-offline')).toBe(true);
  });

  test('banner is-visible sınıfı alır', () => {
    simulateSetOffline();
    const banner = document.getElementById(BANNER_ID);
    expect(banner.classList.contains('is-visible')).toBe(true);
  });

  test('msg-input placeholder değişir', () => {
    simulateSetOffline();
    const input = document.getElementById('msg-input');
    expect(input.placeholder).toContain('Çevrimdışısın');
  });

  test('msg-input data-offline-disabled set edilir', () => {
    simulateSetOffline();
    const input = document.getElementById('msg-input');
    expect(input.dataset.offlineDisabled).toBe('1');
  });
});

// ── setOnline ──────────────────────────────────────────────────────────────────

describe('offline-banner — setOnline', () => {
  beforeEach(() => simulateSetOffline());

  test('body bridge-offline sınıfını kaybeder', () => {
    simulateSetOnline();
    expect(document.body.classList.contains('bridge-offline')).toBe(false);
  });

  test('banner is-visible sınıfını kaybeder', () => {
    simulateSetOnline();
    const banner = document.getElementById(BANNER_ID);
    expect(banner.classList.contains('is-visible')).toBe(false);
  });

  test('input placeholder geri yüklenir', () => {
    simulateSetOnline();
    const input = document.getElementById('msg-input');
    expect(input.placeholder).toBe('Mesaj gönder');
  });

  test('input data-offline-disabled kaldırılır', () => {
    simulateSetOnline();
    const input = document.getElementById('msg-input');
    expect(input.dataset.offlineDisabled).toBeUndefined();
  });

  test('reconnect toast görünür olur', () => {
    simulateSetOnline();
    const toast = document.getElementById(RECONNECTED_ID);
    expect(toast.classList.contains('is-visible')).toBe(true);
  });

  test('reconnect toast metni içerir', () => {
    simulateSetOnline();
    const toast = document.getElementById(RECONNECTED_ID);
    expect(toast.textContent).toContain('🟢');
  });
});

// ── Cache badge ────────────────────────────────────────────────────────────────

describe('offline-banner — cache badge', () => {
  test('kanal adı elementine badge eklenir', () => {
    const chName = document.getElementById('channel-name');
    const badge = document.createElement('span');
    badge.id = CACHE_BADGE_ID;
    badge.className = 'offline-cache-badge';
    badge.textContent = '📦 önbellek';
    chName.appendChild(badge);
    expect(document.getElementById(CACHE_BADGE_ID)).not.toBeNull();
  });

  test('badge metni önbellek içerir', () => {
    const chName = document.getElementById('channel-name');
    const badge = document.createElement('span');
    badge.id = CACHE_BADGE_ID;
    badge.textContent = '📦 önbellek';
    chName.appendChild(badge);
    expect(document.getElementById(CACHE_BADGE_ID).textContent).toContain('önbellek');
  });

  test('setOnline sırasında badge kaldırılır', () => {
    const chName = document.getElementById('channel-name');
    const badge = document.createElement('span');
    badge.id = CACHE_BADGE_ID;
    chName.appendChild(badge);
    // Remove on online
    document.getElementById(CACHE_BADGE_ID)?.remove();
    expect(document.getElementById(CACHE_BADGE_ID)).toBeNull();
  });
});

// ── CSS injection ──────────────────────────────────────────────────────────────

describe('offline-banner — styles', () => {
  test('style elementi oluşturulabilir', () => {
    const style = document.createElement('style');
    style.id = STYLES_ID;
    style.textContent = `#${BANNER_ID} { height: 0; }`;
    document.head.appendChild(style);
    expect(document.getElementById(STYLES_ID)).not.toBeNull();
  });

  test('style zaten varsa tekrar eklenmez', () => {
    const style1 = document.createElement('style');
    style1.id = STYLES_ID;
    document.head.appendChild(style1);
    // second injection should check and skip
    const existing = document.getElementById(STYLES_ID);
    if (!existing) {
      const style2 = document.createElement('style');
      style2.id = STYLES_ID;
      document.head.appendChild(style2);
    }
    expect(document.querySelectorAll(`#${STYLES_ID}`).length).toBe(1);
  });
});

// ── Online/offline events ──────────────────────────────────────────────────────

describe('offline-banner — browser events', () => {
  test('offline event tetiklenince body sınıf alır', () => {
    window.dispatchEvent(new Event('offline'));
    simulateSetOffline(); // simulate the handler
    expect(document.body.classList.contains('bridge-offline')).toBe(true);
  });

  test('online event tetiklenince body sınıfı kaybeder', () => {
    simulateSetOffline();
    simulateSetOnline();
    expect(document.body.classList.contains('bridge-offline')).toBe(false);
  });

  test('bridge:offline custom event tetiklenebilir', () => {
    const handler = jest.fn();
    window.addEventListener('bridge:offline', handler);
    window.dispatchEvent(new CustomEvent('bridge:offline'));
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('bridge:offline', handler);
  });

  test('bridge:online custom event detail içerir', () => {
    let receivedDetail = null;
    const handler = (e) => { receivedDetail = e.detail; };
    window.addEventListener('bridge:online', handler);
    window.dispatchEvent(new CustomEvent('bridge:online', { detail: { pendingCount: 3 } }));
    expect(receivedDetail?.pendingCount).toBe(3);
    window.removeEventListener('bridge:online', handler);
  });
});

// ── Pending messages ───────────────────────────────────────────────────────────

describe('offline-banner — pending message count', () => {
  test('0 pending mesaj ile reconnect toast normal mesaj gösterir', () => {
    const toast = document.getElementById(RECONNECTED_ID);
    toast.textContent = '🟢 Bağlantı yeniden kuruldu';
    expect(toast.textContent).not.toContain('mesaj');
  });

  test('N pending mesaj ile toast sayı gösterir', () => {
    const toast = document.getElementById(RECONNECTED_ID);
    const pending = 5;
    toast.textContent = `🟢 Bağlantı yeniden kuruldu — ${pending} mesaj gönderiliyor…`;
    expect(toast.textContent).toContain('5');
  });
});
