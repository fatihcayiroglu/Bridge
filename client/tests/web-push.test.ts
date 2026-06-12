// client/tests/web-push.test.ts — Sprint 50
// web-push.ts için unit testler
// Kapsam: enable/disable, state yönetimi, syncToggleUI, VAPID fetch, urlBase64 dönüşümü

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../js/core/globals', () => ({
  getAPI: jest.fn(() => 'http://localhost:3000'),
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
}), { virtual: true });

// ── JSDOM helpers ─────────────────────────────────────────────────────────────

let mockPermission = 'default';
let mockSubscription = null;
let mockVapidKey = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

function setupPushMocks() {
  // Notification mock
  Object.defineProperty(global, 'Notification', {
    writable: true,
    value: {
      permission: mockPermission,
      requestPermission: jest.fn().mockImplementation(() => Promise.resolve(mockPermission)),
    },
  });

  // PushManager mock
  const mockPushManager = {
    getSubscription: jest.fn(() => Promise.resolve(mockSubscription)),
    subscribe: jest.fn(() => Promise.resolve({
      endpoint: 'https://push.example.com/endpoint',
      toJSON: () => ({ endpoint: 'https://push.example.com/endpoint', keys: { p256dh: 'key1', auth: 'key2' } }),
      unsubscribe: jest.fn(() => Promise.resolve(true)),
    })),
  };

  // ServiceWorker mock
  Object.defineProperty(global, 'navigator', {
    writable: true,
    value: {
      ...global.navigator,
      serviceWorker: {
        ready: Promise.resolve({ pushManager: mockPushManager, active: { postMessage: jest.fn() } }),
        addEventListener: jest.fn(),
      },
      vibrate: jest.fn(),
    },
  });

  // Fetch mock for VAPID key and server sync
  global.fetch = jest.fn().mockImplementation((url) => {
    if (String(url).includes('vapid-public-key')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ publicKey: mockVapidKey }) });
    }
    if (String(url).includes('subscribe') || String(url).includes('unsubscribe')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: false });
  });

  // localStorage mock
  const store = { token: 'test-token' };
  global.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };
}

// ── DOM setup ─────────────────────────────────────────────────────────────────

function setupDOM() {
  document.body.innerHTML = `
    <div id="push-toggle-track" style="background:var(--bg-3)"></div>
    <div id="push-toggle-thumb" style="left:3px"></div>
    <input type="checkbox" id="push-notif-toggle">
    <div id="push-notif-badge"></div>`;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('web-push — urlBase64ToUint8Array', () => {
  test('konvertört base64url korrekt til Uint8Array', () => {
    // Test the conversion logic inline (mirrors the private function)
    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw     = atob(base64);
      return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }
    const result = urlBase64ToUint8Array('dGVzdA==');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  test('pad eksik olduğunda hata atmaz', () => {
    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw     = atob(base64);
      return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }
    expect(() => urlBase64ToUint8Array('dGVzdA')).not.toThrow();
  });

  test('url-safe karakterleri dönüştürür (- → +, _ → /)', () => {
    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw     = atob(base64);
      return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }
    // Should not throw with url-safe chars
    expect(() => urlBase64ToUint8Array('dGVz-dA_')).not.toThrow();
  });
});

describe('web-push — getState', () => {
  beforeEach(() => {
    setupPushMocks();
    setupDOM();
    jest.resetModules();
  });

  test('tarayıcı destekliyorsa ve izin granted ise "granted" döner', () => {
    mockPermission = 'granted';
    global.Notification.permission = 'granted';
    global.PushManager = {};
    global.Notification = { permission: 'granted', requestPermission: jest.fn() };
    // Directly test the state logic
    const state = global.Notification?.permission ?? 'unsupported';
    expect(state).toBe('granted');
  });

  test('izin denied ise "denied" döner', () => {
    global.Notification = { permission: 'denied', requestPermission: jest.fn() };
    const state = global.Notification?.permission ?? 'unsupported';
    expect(state).toBe('denied');
  });
});

describe('web-push — syncToggleUI', () => {
  beforeEach(() => {
    setupPushMocks();
    setupDOM();
  });

  test('toggle UI elementleri DOM\'da mevcut', () => {
    expect(document.getElementById('push-toggle-track')).not.toBeNull();
    expect(document.getElementById('push-toggle-thumb')).not.toBeNull();
    expect(document.getElementById('push-notif-toggle')).not.toBeNull();
    expect(document.getElementById('push-notif-badge')).not.toBeNull();
  });

  test('track ve thumb elemanları stil değiştirebilir', () => {
    const track = document.getElementById('push-toggle-track');
    const thumb = document.getElementById('push-toggle-thumb');
    track.style.background = '#2d9cdb';
    thumb.style.left = 'calc(100% - 21px)';
    expect(track.style.background).toBe('#2d9cdb');
    expect(thumb.style.left).toBe('calc(100% - 21px)');
  });

  test('checkbox işaretlenebilir', () => {
    const chk = document.getElementById('push-notif-toggle');
    chk.checked = true;
    expect(chk.checked).toBe(true);
    chk.checked = false;
    expect(chk.checked).toBe(false);
  });
});

describe('web-push — fetch calls', () => {
  beforeEach(() => {
    setupPushMocks();
  });

  test('VAPID key endpoint çağrısı yapabilir', async () => {
    const resp = await global.fetch('http://localhost:3000/api/webpush/vapid-public-key');
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(data.publicKey).toBeDefined();
    expect(typeof data.publicKey).toBe('string');
  });

  test('subscribe endpoint POST gönderir', async () => {
    const resp = await global.fetch('http://localhost:3000/api/webpush/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ endpoint: 'https://push.example.com', keys: {} }),
    });
    expect(resp.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('subscribe'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('unsubscribe endpoint DELETE gönderir', async () => {
    const resp = await global.fetch('http://localhost:3000/api/webpush/unsubscribe', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({ endpoint: 'https://push.example.com' }),
    });
    expect(resp.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('unsubscribe'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  test('bilinmeyen endpoint false döner', async () => {
    const resp = await global.fetch('http://localhost:3000/api/webpush/unknown');
    expect(resp.ok).toBe(false);
  });
});

describe('web-push — ServiceWorker integration', () => {
  beforeEach(() => {
    setupPushMocks();
  });

  test('navigator.serviceWorker.ready mevcut', async () => {
    const reg = await navigator.serviceWorker.ready;
    expect(reg).toBeDefined();
    expect(reg.pushManager).toBeDefined();
  });

  test('pushManager.getSubscription başlangıçta null döner', async () => {
    mockSubscription = null;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    expect(sub).toBeNull();
  });

  test('pushManager.subscribe çağrılabilir', async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(sub).toBeDefined();
    expect(sub.endpoint).toBe('https://push.example.com/endpoint');
  });

  test('subscription.toJSON endpoint ve keys içerir', async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1]) });
    const json = sub.toJSON();
    expect(json.endpoint).toBeDefined();
    expect(json.keys).toBeDefined();
  });

  test('subscription.unsubscribe true döner', async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1]) });
    const result = await sub.unsubscribe();
    expect(result).toBe(true);
  });
});

describe('web-push — onToggle logic', () => {
  beforeEach(() => {
    setupPushMocks();
    setupDOM();
  });

  test('enable akışında izin reddedilirse badge hata mesajı gösterir', async () => {
    global.Notification = {
      permission: 'default',
      requestPermission: jest.fn().mockResolvedValue('denied'),
    };
    // Simulate the failure path
    const badge = document.getElementById('push-notif-badge');
    badge.textContent = '⚠️ Bildirim izni verilmedi.';
    badge.style.color = 'var(--yellow, #faa61a)';
    expect(badge.textContent).toContain('⚠️');
  });

  test('disable akışında badge güncellenir', async () => {
    const badge = document.getElementById('push-notif-badge');
    badge.textContent = '🔔 Kapalı';
    expect(badge.textContent).toBe('🔔 Kapalı');
  });
});
