// client/tests/web-push-client-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// web-push-client — SAHTE BAŞARI OLMADAN ABONELİK YAŞAM DÖNGÜSÜ
// ════════════════════════════════════════════════════════════════════════════
//
// Bu modül "bildirimler açık" iddiasının TEK sahibidir. Ölçülmemiş 48 dalın
// taşıdığı riskler:
//
//   · SAHTE BAŞARI — tarayıcıda abonelik oluşup SUNUCUYA yazılamazsa kullanıcı
//     bildirim alacağını sanır ama almaz. Bu yüzden sunucuya yazma
//     BAŞARISIZSA, bu çağrının OLUŞTURDUĞU abonelik geri alınır.
//   · SIRA — kapatmada önce SUNUCU teslimi durdurulur, sonra yerel abonelik
//     emekliye ayrılır; ters sıra "kapattım" denip push almaya devam etmektir.
//   · YEREL BAYRAK — "abone" durumu yalnız tarayıcı aboneliğine bakarak
//     bildirilmez: izin verilmiş VE sunucu eşitlemesi yapılmış olmalıdır.
//   · DEPO — `localStorage` kapalıysa modül çökmez, güvenli tarafa düşer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disableWebPush, enableWebPush, getWebPushState, sendTestWebPush, type ApiFetch,
} from '../js/core/notifications/web-push-client.ts';

const SERVER_SYNC_KEY = 'bridge_web_push_server_synced_v1';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface FakeSubscription {
  endpoint: string;
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON(): { endpoint: string; keys: Record<string, string> };
}

let api: ReturnType<typeof vi.fn>;
let subscription: FakeSubscription | null;
let getSubscription: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let readyValue: Promise<unknown>;
let permission: NotificationPermission;
let requestPermission: ReturnType<typeof vi.fn>;

function makeSubscription(endpoint = 'https://push.test/abc'): FakeSubscription {
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: 'k1', auth: 'k2' } }),
  };
}

/** Gerçek base64url VAPID anahtarı: dönüştürücü de ölçülmüş olur. */
const VAPID = btoa('bridge-test-application-server-key-0123456789')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function installBrowser(options: { support?: boolean } = {}): void {
  const support = options.support ?? true;
  if (!support) {
    // `undefined` ATAMAK yetmez: `'Notification' in window` hâlâ doğru kalır ve
    // destek denetimi yanlışlıkla geçerdi. Alanlar gerçekten KALDIRILIR.
    Reflect.deleteProperty(globalThis, 'Notification');
    Reflect.deleteProperty(globalThis, 'PushManager');
    Reflect.deleteProperty(navigator, 'serviceWorker');
    return;
  }
  vi.stubGlobal('Notification', {
    get permission() { return permission; },
    requestPermission: (...args: unknown[]) => requestPermission(...args),
  });
  vi.stubGlobal('PushManager', function PushManagerStub() { /* varlık işareti */ });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { get ready() { return readyValue; } },
  });
}

const registration = () => ({
  pushManager: {
    getSubscription: (...args: unknown[]) => getSubscription(...args),
    subscribe: (...args: unknown[]) => subscribe(...args),
  },
});

beforeEach(() => {
  localStorage.clear();
  permission = 'granted';
  subscription = makeSubscription();
  getSubscription = vi.fn(async () => subscription);
  subscribe = vi.fn(async () => makeSubscription('https://push.test/yeni'));
  requestPermission = vi.fn(async () => permission);
  readyValue = Promise.resolve(registration());
  api = vi.fn(async (url: string) => {
    if (url.includes('vapid')) return response({ publicKey: VAPID });
    return response({ ok: true });
  });
  installBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ════════════════════════════════════════════════════════════════════════════
describe('getWebPushState', () => {
  it('DESTEKLENMEYEN tarayıcıda açık bir durum bildirilir', async () => {
    installBrowser({ support: false });

    expect(await getWebPushState(api as unknown as ApiFetch)).toEqual({
      supported: false, permission: 'unsupported', subscribed: false, configured: false,
    });
    expect(api).not.toHaveBeenCalled();
  });

  it('tarayıcı aboneliği TEK BAŞINA "abone" demek değildir', async () => {
    const state = await getWebPushState(api as unknown as ApiFetch);

    expect(state.supported).toBe(true);
    expect(state.configured).toBe(true);
    // Sunucu eşitlemesi yapılmadığı için abone SAYILMAZ.
    expect(state.subscribed).toBe(false);
  });

  it('izin + abonelik + SUNUCU eşitlemesi birlikte abone yapar', async () => {
    localStorage.setItem(SERVER_SYNC_KEY, 'yes');

    expect((await getWebPushState(api as unknown as ApiFetch)).subscribed).toBe(true);
  });

  it('izin geri alınmışsa abone sayılmaz', async () => {
    localStorage.setItem(SERVER_SYNC_KEY, 'yes');
    permission = 'default';

    expect((await getWebPushState(api as unknown as ApiFetch)).subscribed).toBe(false);
  });

  it('tarayıcı aboneliği kalmadıysa abone sayılmaz', async () => {
    localStorage.setItem(SERVER_SYNC_KEY, 'yes');
    subscription = null;

    expect((await getWebPushState(api as unknown as ApiFetch)).subscribed).toBe(false);
  });

  it('abonelik okunamazsa çökmez', async () => {
    getSubscription = vi.fn(async () => { throw new Error('sw down'); });

    expect((await getWebPushState(api as unknown as ApiFetch)).subscribed).toBe(false);
  });

  it('SERVİS ÇALIŞANI hazır değilse abonelik yok sayılır', async () => {
    readyValue = Promise.reject(new Error('no sw'));

    const state = await getWebPushState(api as unknown as ApiFetch);

    expect(state.supported).toBe(true);
    expect(state.subscribed).toBe(false);
  });

  it.each([
    ['uç reddederse', async () => response({}, 500)],
    ['anahtar metin değilse', async () => response({ publicKey: 42 })],
    ['anahtar boşsa', async () => response({ publicKey: '' })],
    ['uç patlarsa', async () => { throw new Error('offline'); }],
  ])('VAPID anahtarı %s yapılandırılmamış sayılır', async (_label, handler) => {
    api = vi.fn(async (url: string) => (url.includes('vapid') ? handler() : response({})) as Promise<Response>);

    expect((await getWebPushState(api as unknown as ApiFetch)).configured).toBe(false);
  });

  it('DEPO kapalıysa eşitleme bayrağı güvenli tarafa düşer', async () => {
    localStorage.setItem(SERVER_SYNC_KEY, 'yes');
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    try {
      expect((await getWebPushState(api as unknown as ApiFetch)).subscribed).toBe(false);
    } finally {
      getItem.mockRestore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('enableWebPush', () => {
  const enable = () => enableWebPush(api as unknown as ApiFetch);

  it('desteklenmeyen tarayıcıda açık nedenle reddeder', async () => {
    installBrowser({ support: false });

    expect(await enable()).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('izin REDDEDİLMİŞSE sunucuya hiç gidilmez', async () => {
    permission = 'denied';

    expect(await enable()).toEqual({ ok: false, reason: 'permission_denied' });
    expect(api).not.toHaveBeenCalled();
  });

  it('VAPID yapılandırılmamışsa izin İSTENMEZ', async () => {
    api = vi.fn(async () => response({}, 503));

    expect(await enable()).toEqual({ ok: false, reason: 'not_configured' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('kullanıcı izin vermezse abonelik OLUŞTURULMAZ', async () => {
    requestPermission = vi.fn(async () => 'default' as NotificationPermission);

    expect(await enable()).toEqual({ ok: false, reason: 'permission_denied' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('servis çalışanı yoksa açık nedenle reddeder', async () => {
    readyValue = Promise.reject(new Error('no sw'));

    expect(await enable()).toEqual({ ok: false, reason: 'service_worker_unavailable' });
  });

  it('MEVCUT abonelik yeniden kullanılır', async () => {
    const result = await enable();

    expect(result).toEqual({ ok: true });
    expect(subscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem(SERVER_SYNC_KEY)).toBe('yes');
  });

  it('abonelik yoksa VAPID anahtarıyla YENİSİ oluşturulur', async () => {
    subscription = null;

    expect(await enable()).toEqual({ ok: true });
    const options = subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: ArrayBuffer };
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey.byteLength).toBeGreaterThan(0);
  });

  it('abonelik oluşturulamazsa açık nedenle reddeder', async () => {
    subscription = null;
    subscribe = vi.fn(async () => { throw new Error('push service down'); });

    expect(await enable()).toEqual({ ok: false, reason: 'subscribe_failed' });
  });

  it('SUNUCUYA yazılamazsa BU ÇAĞRININ oluşturduğu abonelik GERİ ALINIR', async () => {
    subscription = null;
    const created = makeSubscription('https://push.test/yeni');
    subscribe = vi.fn(async () => created);
    api = vi.fn(async (url: string) => (url.includes('vapid') ? response({ publicKey: VAPID }) : response({}, 500)));

    expect(await enable()).toEqual({ ok: false, reason: 'server_unavailable' });
    expect(created.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem(SERVER_SYNC_KEY)).toBeNull();
  });

  it('ÖNCEDEN var olan abonelik sunucu hatasında geri ALINMAZ', async () => {
    const existing = subscription!;
    api = vi.fn(async (url: string) => (url.includes('vapid') ? response({ publicKey: VAPID }) : response({}, 500)));

    expect(await enable()).toEqual({ ok: false, reason: 'server_unavailable' });
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it('geri alma da PATLARSA sonuç yine başarısızdır', async () => {
    subscription = null;
    const created = makeSubscription();
    created.unsubscribe = vi.fn(async () => { throw new Error('rollback failed'); });
    subscribe = vi.fn(async () => created);
    api = vi.fn(async (url: string) => (url.includes('vapid') ? response({ publicKey: VAPID }) : response({}, 500)));

    expect(await enable()).toEqual({ ok: false, reason: 'server_unavailable' });
  });

  it('sunucu isteği PATLARSA da sahte başarı üretilmez', async () => {
    api = vi.fn(async (url: string) => {
      if (url.includes('vapid')) return response({ publicKey: VAPID });
      throw new Error('offline');
    });

    expect(await enable()).toEqual({ ok: false, reason: 'server_unavailable' });
  });

  it('sunucuya gönderilen gövde uç adresi ve anahtarları taşır', async () => {
    await enable();

    const call = api.mock.calls.find(([url]) => String(url).includes('subscribe'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      endpoint: 'https://push.test/abc', keys: { p256dh: 'k1', auth: 'k2' },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('disableWebPush', () => {
  const disable = () => disableWebPush(api as unknown as ApiFetch);

  it('desteklenmeyen tarayıcıda zaten kapalıdır', async () => {
    installBrowser({ support: false });

    expect(await disable()).toEqual({ ok: true });
  });

  it('servis çalışanı yoksa açık nedenle reddeder', async () => {
    readyValue = Promise.reject(new Error('no sw'));

    expect(await disable()).toEqual({ ok: false, reason: 'service_worker_unavailable' });
  });

  it('abonelik okunamazsa açık nedenle reddeder', async () => {
    getSubscription = vi.fn(async () => { throw new Error('sw down'); });

    expect(await disable()).toEqual({ ok: false, reason: 'unsubscribe_failed' });
  });

  it('abonelik zaten yoksa yerel bayrak TEMİZLENİR', async () => {
    localStorage.setItem(SERVER_SYNC_KEY, 'yes');
    subscription = null;

    expect(await disable()).toEqual({ ok: true });
    expect(localStorage.getItem(SERVER_SYNC_KEY)).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it('ÖNCE sunucu teslimi durdurulur, SONRA yerel abonelik emekliye ayrılır', async () => {
    localStorage.setItem(SERVER_SYNC_KEY, 'yes');
    const order: string[] = [];
    api = vi.fn(async () => { order.push('server'); return response({ ok: true }); });
    subscription!.unsubscribe = vi.fn(async () => { order.push('local'); return true; });

    expect(await disable()).toEqual({ ok: true });
    expect(order).toEqual(['server', 'local']);
    expect(localStorage.getItem(SERVER_SYNC_KEY)).toBeNull();
  });

  it('sunucu reddederse yerel abonelik KORUNUR', async () => {
    localStorage.setItem(SERVER_SYNC_KEY, 'yes');
    api = vi.fn(async () => response({}, 500));

    expect(await disable()).toEqual({ ok: false, reason: 'server_unavailable' });
    expect(subscription!.unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem(SERVER_SYNC_KEY)).toBe('yes');
  });

  it('sunucu isteği PATLARSA da yerel abonelik korunur', async () => {
    api = vi.fn(async () => { throw new Error('offline'); });

    expect(await disable()).toEqual({ ok: false, reason: 'server_unavailable' });
    expect(subscription!.unsubscribe).not.toHaveBeenCalled();
  });

  it('yerel abonelik kaldırılamazsa SUNUCU tarafı yine kapalı sayılır', async () => {
    subscription!.unsubscribe = vi.fn(async () => false);

    expect(await disable()).toEqual({ ok: true, reason: 'unsubscribe_failed' });
  });

  it('yerel kaldırma PATLARSA da sunucu tarafı kapalı sayılır', async () => {
    subscription!.unsubscribe = vi.fn(async () => { throw new Error('sw down'); });

    expect(await disable()).toEqual({ ok: true, reason: 'unsubscribe_failed' });
  });

  it('gönderilen gövde uç adresini taşır', async () => {
    await disable();

    const call = api.mock.calls[0]!;
    expect((call[1] as RequestInit).method).toBe('DELETE');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ endpoint: 'https://push.test/abc' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sendTestWebPush', () => {
  it('başarılı test isteği doğrular', async () => {
    expect(await sendTestWebPush(api as unknown as ApiFetch)).toEqual({ ok: true });
    expect(api).toHaveBeenCalledWith('/api/webpush/test', expect.objectContaining({ method: 'POST' }));
  });

  it('503 yanıtı YAPILANDIRILMAMIŞ olarak ayırt edilir', async () => {
    api = vi.fn(async () => response({}, 503));

    expect(await sendTestWebPush(api as unknown as ApiFetch)).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('diğer hatalar sunucu erişilemez olarak bildirilir', async () => {
    api = vi.fn(async () => response({}, 500));

    expect(await sendTestWebPush(api as unknown as ApiFetch)).toEqual({ ok: false, reason: 'server_unavailable' });
  });

  it('taşıma hatası da açık nedenle bildirilir', async () => {
    api = vi.fn(async () => { throw new Error('offline'); });

    expect(await sendTestWebPush(api as unknown as ApiFetch)).toEqual({ ok: false, reason: 'server_unavailable' });
  });
});
