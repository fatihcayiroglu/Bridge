// server/tests/pushSender-integration.test.ts
// APNs HTTP/2 + FCM v1 + Web Push entegrasyon testleri
// Sprint 66: pushSender.ts'in tüm kritik dallarını kapsar
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

// ── DB mock ───────────────────────────────────────────────────
import { createMockDb, makeUser } from './helpers/mockDb';
const db = createMockDb();
jest.mock('../db/index',  () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// ── http2 mock ────────────────────────────────────────────────
const mockRequests: jest.Mock[] = [];
let mockSessionDestroyed = false;

const mockHttp2Session = {
  request:   jest.fn((_headers: unknown) => {
    const req = {
      on:          jest.fn(),
      write:       jest.fn(),
      end:         jest.fn(),
      setEncoding: jest.fn(),
    };
    mockRequests.push(req as unknown as jest.Mock);
    return req;
  }),
  get destroyed() { return mockSessionDestroyed; },
  on:    jest.fn(),
  close: jest.fn(),
};

jest.mock('http2', () => ({
  connect: jest.fn(() => mockHttp2Session),
}));

function resetHttp2RequestMock(): void {
  mockRequests.length = 0;
  mockHttp2Session.request.mockReset();
  mockHttp2Session.request.mockImplementation((_headers: unknown) => {
    const req = {
      on:          jest.fn(),
      write:       jest.fn(),
      end:         jest.fn(),
      setEncoding: jest.fn(),
    };
    mockRequests.push(req as unknown as jest.Mock);
    return req;
  });
}

// ── fs mock ───────────────────────────────────────────────────
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(() => `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIOaXe+lNFMJblcoNMGCiqtHPcOL/ZH3fZx4JtJgCulimoAoGCCqGSM49
AwEHoWQDYgAEXM6Z6MYK2e3Sv4Kt3FftfJ2fWBkrjO/OYWFw4yK4p2v8Jqn9uFmn
jJLPmhT4r0pxV4dWsEJmkHLlr8mFH0xP
-----END EC PRIVATE KEY-----`),
}));

// ── crypto mock ───────────────────────────────────────────────
const mockSign = {
  update: jest.fn().mockReturnThis(),
  sign:   jest.fn().mockReturnValue('mock-signature'),
};
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createSign: jest.fn(() => mockSign),
}));

// ── fetch mock ────────────────────────────────────────────────
const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

import * as Repos from '../db/repositories';

// Helpers: APNs response simülatörü
function simulateApnsResponse(
  requestMock: jest.Mock,
  statusCode: number,
  body = '',
): void {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  requestMock.on.mockImplementation((event: string, cb: (arg?: unknown) => void) => {
    handlers[event] = handlers[event] || [];
    handlers[event].push(cb);
  });
  requestMock.end.mockImplementation(() => {
    handlers['response']?.[0]?.({ ':status': statusCode });
    handlers['data']?.[0]?.(Buffer.from(body));
    handlers['end']?.[0]?.();
  });
}

// ── Test grubları ─────────────────────────────────────────────
describe('sendWebPush — web-push kütüphanesi', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.VAPID_PUBLIC_KEY  = 'fake-pub-key';
    process.env.VAPID_PRIVATE_KEY = 'fake-priv-key';
  });

  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  it('web-push paketi yoksa sessizce döner', async () => {
    jest.mock('web-push', () => { throw new Error('module not found'); }, { virtual: true });
    const ps = require('../lib/pushSender');
    await expect(
      ps.sendWebPush({ endpoint: 'https://example.com/push', keys: {} }, { title: 'T', body: 'B' })
    ).resolves.toBeUndefined();
  });

  it('VAPID env yoksa sessizce döner', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    jest.resetModules();
    const ps = require('../lib/pushSender');
    await expect(
      ps.sendWebPush({ endpoint: 'https://example.com/push', keys: {} }, { title: 'T', body: 'B' })
    ).resolves.toBeUndefined();
  });
});

describe('sendFCM — FCM HTTP v1', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.FCM_PROJECT_ID = 'test-project';
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      private_key:  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      client_email: 'test@test-project.iam.gserviceaccount.com',
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.FCM_PROJECT_ID;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  });

  it('FCM_PROJECT_ID yoksa sessizce döner', async () => {
    delete process.env.FCM_PROJECT_ID;
    jest.resetModules();
    const ps = require('../lib/pushSender');
    await expect(ps.sendFCM('token-xyz', { title: 'T', body: 'B' })).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('OAuth2 token alınamadığında sessizce döner', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const ps = require('../lib/pushSender');
    await expect(ps.sendFCM('token-xyz', { title: 'T', body: 'B' })).resolves.toBeUndefined();
  });

  it('OAuth2 token alındıktan sonra FCM isteği atılır', async () => {
    // Token isteği başarılı
    mockFetch
      .mockResolvedValueOnce({
        ok:   true,
        json: async () => ({ access_token: 'ya29.testtoken' }),
      })
      // FCM mesaj isteği başarılı
      .mockResolvedValueOnce({ ok: true });

    const ps = require('../lib/pushSender');
    await ps.sendFCM('device-token-123', { title: 'Bridge', body: 'Yeni mesaj', badge: 3 });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [fcmUrl, fcmOpts] = mockFetch.mock.calls[1];
    expect(fcmUrl).toContain('fcm.googleapis.com');
    const body = JSON.parse(fcmOpts.body as string);
    expect(body.message.token).toBe('device-token-123');
    expect(body.message.notification.title).toBe('Bridge');
  });

  it('404/UNREGISTERED → token DB\'den kaldırılır', async () => {
    const removeNativeSpy = jest.spyOn(require('../db/repositories').Notifications, 'removeNativeTokenWhere').mockResolvedValue(undefined as never);
    const removeFcmSpy    = jest.spyOn(require('../db/repositories').Notifications, 'removeFcmTokenWhere').mockResolvedValue(undefined as never);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'ya29.test' }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'UNREGISTERED' });

    const ps = require('../lib/pushSender');
    await ps.sendFCM('dead-token', { title: 'T', body: 'B' });

    expect(removeNativeSpy).toHaveBeenCalledWith({ token: 'dead-token' });
    expect(removeFcmSpy).toHaveBeenCalledWith({ token: 'dead-token' });
  });

  it('FCM_SERVICE_ACCOUNT_PATH dosyasından servis hesabı okunur', async () => {
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    process.env.FCM_SERVICE_ACCOUNT_PATH = '/tmp/fake-sa.json';

    const fs = require('fs');
    (fs.readFileSync as jest.Mock).mockReturnValueOnce(JSON.stringify({
      private_key:  '-----BEGIN RSA PRIVATE KEY-----\nMIIEo\n-----END RSA PRIVATE KEY-----',
      client_email: 'sa@project.iam.gserviceaccount.com',
    }));

    mockFetch.mockRejectedValueOnce(new Error('imza hatası — sadece dosya okumayı test ediyoruz'));
    const ps = require('../lib/pushSender');
    await ps.sendFCM('token', { title: 'T', body: 'B' }); // hata yutulur
    expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/fake-sa.json', 'utf8');

    delete process.env.FCM_SERVICE_ACCOUNT_PATH;
  });
});

describe('sendAPNs — HTTP/2 native', () => {
  let pushSender: typeof import('../lib/pushSender');

  beforeEach(async () => {
    jest.resetModules();
    mockSessionDestroyed = false;
    resetHttp2RequestMock();
    mockHttp2Session.close.mockClear();

    process.env.APNS_KEY_PATH  = '/tmp/fake.p8';
    process.env.APNS_KEY_ID    = 'KEY123';
    process.env.APNS_TEAM_ID   = 'TEAM456';
    process.env.APNS_BUNDLE_ID = 'com.bridge.app';
    process.env.APNS_ENV       = 'sandbox';

    pushSender = require('../lib/pushSender');
  });

  afterEach(() => {
    ['APNS_KEY_PATH','APNS_KEY_ID','APNS_TEAM_ID','APNS_BUNDLE_ID','APNS_ENV'].forEach(k => delete process.env[k]);
  });

  it('200 → başarılı, DB\'ye dokunulmaz', async () => {
    const removeSpy = jest.spyOn(require('../db/repositories').Notifications, 'removeNativeTokenWhere').mockResolvedValue(undefined as never);
    // Doğrudan event simülasyonu yapacağız
    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    const fakeReq = {
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 200 });
        responseHandlers['data']?.(Buffer.from(''));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    };
    mockHttp2Session.request.mockReturnValueOnce(fakeReq);

    await pushSender.sendAPNs('device-abc', { title: 'Test', body: 'Merhaba' });
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('410 Unregistered → token DB\'den kaldırılır', async () => {
    const removeSpy = jest.spyOn(require('../db/repositories').Notifications, 'removeNativeTokenWhere').mockResolvedValue(undefined as never);

    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    const fakeReq = {
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 410 });
        responseHandlers['data']?.(Buffer.from(JSON.stringify({ reason: 'Unregistered' })));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    };
    mockHttp2Session.request.mockReturnValueOnce(fakeReq);

    await pushSender.sendAPNs('dead-device-token', { title: 'T', body: 'B' });
    expect(removeSpy).toHaveBeenCalledWith({ token: 'dead-device-token' });
  });

  it('BadDeviceToken → token DB\'den kaldırılır', async () => {
    const removeSpy = jest.spyOn(require('../db/repositories').Notifications, 'removeNativeTokenWhere').mockResolvedValue(undefined as never);

    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    const fakeReq = {
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 400 });
        responseHandlers['data']?.(Buffer.from(JSON.stringify({ reason: 'BadDeviceToken' })));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    };
    mockHttp2Session.request.mockReturnValueOnce(fakeReq);

    await pushSender.sendAPNs('bad-token', { title: 'T', body: 'B' });
    expect(removeSpy).toHaveBeenCalledWith({ token: 'bad-token' });
  });

  it('5xx hatası → token korunur, hata loglanır', async () => {
    const removeSpy = jest.spyOn(require('../db/repositories').Notifications, 'removeNativeTokenWhere').mockResolvedValue(undefined as never);

    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    const fakeReq = {
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 503 });
        responseHandlers['data']?.(Buffer.from('Service Unavailable'));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    };
    mockHttp2Session.request.mockReturnValueOnce(fakeReq);

    await pushSender.sendAPNs('valid-token', { title: 'T', body: 'B' });
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('production env → api.push.apple.com kullanılır', async () => {
    process.env.APNS_ENV = 'production';
    jest.resetModules();
    const http2 = require('http2');
    const ps = require('../lib/pushSender');

    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    mockHttp2Session.request.mockReturnValueOnce({
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 200 });
        responseHandlers['data']?.(Buffer.from(''));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    });

    await ps.sendAPNs('token-prod', { title: 'T', body: 'B' });
    expect(http2.connect).toHaveBeenCalledWith('https://api.push.apple.com');
  });

  it('sandbox env → api.sandbox.push.apple.com kullanılır', async () => {
    process.env.APNS_ENV = 'sandbox';
    jest.resetModules();
    const http2 = require('http2');
    const ps = require('../lib/pushSender');

    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    mockHttp2Session.request.mockReturnValueOnce({
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 200 });
        responseHandlers['data']?.(Buffer.from(''));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    });

    await ps.sendAPNs('token-sandbox', { title: 'T', body: 'B' });
    expect(http2.connect).toHaveBeenCalledWith('https://api.sandbox.push.apple.com');
  });

  it('HTTP/2 istek hatası → throw edilmez, hata loglanır', async () => {
    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    const fakeReq = {
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => { responseHandlers['error']?.(new Error('network timeout')); }),
      setEncoding: jest.fn(),
    };
    mockHttp2Session.request.mockReturnValueOnce(fakeReq);

    await expect(pushSender.sendAPNs('token', { title: 'T', body: 'B' })).resolves.toBeUndefined();
  });

  it('closeApnsConnections bağlantıları kapatır', async () => {
    // Önce bir bağlantı kur
    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    mockHttp2Session.request.mockReturnValueOnce({
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 200 });
        responseHandlers['data']?.(Buffer.from(''));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    });
    await pushSender.sendAPNs('token-close-test', { title: 'T', body: 'B' });

    pushSender.closeApnsConnections();
    expect(mockHttp2Session.close).toHaveBeenCalled();
  });
});

describe('clearBadge — iOS APNs + FCM', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSessionDestroyed = false;
    process.env.APNS_KEY_PATH  = '/tmp/fake.p8';
    process.env.APNS_KEY_ID    = 'KEY123';
    process.env.APNS_TEAM_ID   = 'TEAM456';
    process.env.APNS_BUNDLE_ID = 'com.bridge.app';
    process.env.APNS_ENV       = 'sandbox';
    process.env.FCM_PROJECT_ID = 'test-project';
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      private_key:  '-----BEGIN RSA PRIVATE KEY-----\nMIIEo\n-----END RSA PRIVATE KEY-----',
      client_email: 'sa@project.iam.gserviceaccount.com',
    });
    mockFetch.mockReset();
    resetHttp2RequestMock();
  });

  afterEach(() => {
    ['APNS_KEY_PATH','APNS_KEY_ID','APNS_TEAM_ID','APNS_BUNDLE_ID','APNS_ENV',
     'FCM_PROJECT_ID','FCM_SERVICE_ACCOUNT_JSON'].forEach(k => delete process.env[k]);
  });

  it('iOS token için APNs badge sıfırlama isteği atılır', async () => {
    const nativeSpy = jest.spyOn(require('../db/repositories').Notifications, 'findNativeTokensForUser')
      .mockResolvedValue([{ token: 'ios-tok', platform: 'ios' }] as never);

    // FCM token isteği (token refresh) + badge clear
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'ya29.token' }) })
      .mockResolvedValueOnce({ ok: true });

    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    mockHttp2Session.request.mockReturnValueOnce({
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn(),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 200 });
        responseHandlers['data']?.(Buffer.from(''));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    });

    const ps = require('../lib/pushSender');
    await ps.clearBadge('user-ios');

    // APNs isteği atılmış olmalı
    expect(mockHttp2Session.request).toHaveBeenCalled();
    const headers = mockHttp2Session.request.mock.calls[0][0];
    expect(headers['apns-push-type']).toBe('background');
  });

  it('APNS yapılandırılmamışsa FCM üzerinden badge sıfırlanır', async () => {
    delete process.env.APNS_KEY_PATH;
    jest.resetModules();

    const nativeSpy = jest.spyOn(require('../db/repositories').Notifications, 'findNativeTokensForUser')
      .mockResolvedValue([{ token: 'fcm-tok', platform: 'android' }] as never);

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'ya29.token' }) })
      .mockResolvedValueOnce({ ok: true });

    const ps = require('../lib/pushSender');
    await ps.clearBadge('user-android');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url] = mockFetch.mock.calls[1];
    expect(url).toContain('fcm.googleapis.com');
  });
});

describe('sendPushToUser — E2E mesaj gizleme', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.APNS_KEY_PATH  = '/tmp/fake.p8';
    process.env.APNS_KEY_ID    = 'KEY123';
    process.env.APNS_TEAM_ID   = 'TEAM456';
    process.env.APNS_BUNDLE_ID = 'com.bridge.app';
    mockFetch.mockReset();
    resetHttp2RequestMock();
  });

  afterEach(() => {
    ['APNS_KEY_PATH','APNS_KEY_ID','APNS_TEAM_ID','APNS_BUNDLE_ID'].forEach(k => delete process.env[k]);
  });

  it('body "🔒e2e:" ile başlıyorsa gönderilen body "🔒 Şifreli mesaj" olur', async () => {
    jest.spyOn(require('../db/repositories').Notifications, 'findPushSubscriptionsForUser').mockResolvedValue([] as never);
    jest.spyOn(require('../db/repositories').Notifications, 'findNativeTokensForUser')
      .mockResolvedValue([{ token: 'ios-tok', platform: 'ios' }] as never);
    jest.spyOn(require('../db/repositories').Notifications, 'findFcmTokensForUser').mockResolvedValue([] as never);
    jest.spyOn(require('../db/repositories').Members, 'findByUser').mockResolvedValue([] as never);
    jest.spyOn(require('../db/repositories').Dms, 'findConversationsByUser').mockResolvedValue([] as never);

    let capturedBody = '';
    let responseHandlers: Record<string, ((arg?: unknown) => void)> = {};
    mockHttp2Session.request.mockReturnValueOnce({
      on:          jest.fn((ev: string, cb: (arg?: unknown) => void) => { responseHandlers[ev] = cb; }),
      write:       jest.fn((data: string) => { capturedBody += data; }),
      end:         jest.fn(() => {
        responseHandlers['response']?.({ ':status': 200 });
        responseHandlers['data']?.(Buffer.from(''));
        responseHandlers['end']?.();
      }),
      setEncoding: jest.fn(),
    });

    const ps = require('../lib/pushSender');
    await ps.sendPushToUser('user-e2e', {
      title: 'Ali',
      body:  '🔒e2e:eyJhbGciOiJFQ0RILUVTK...', // şifreli içerik
    });

    const parsed = JSON.parse(capturedBody);
    expect(parsed.aps.alert.body).toBe('🔒 Şifreli mesaj');
  });
});
