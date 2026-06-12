// server/tests/apns.test.ts
// APNs HTTP/2 native entegrasyon unit testleri
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

// ── DB mock ───────────────────────────────────────────────────
import { createMockDb, makeUser } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index',  () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// ── http2 mock ────────────────────────────────────────────────
const mockHttp2Request = jest.fn();
const mockHttp2Session = {
  request:   mockHttp2Request,
  destroyed: false,
  on:        jest.fn(),
  close:     jest.fn(),
};
jest.mock('http2', () => ({
  connect: jest.fn(() => mockHttp2Session),
}));

// ── fs mock ───────────────────────────────────────────────────
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(),
}));

// ── crypto mock (ES256 imzalama) ──────────────────────────────
const mockSign = {
  update: jest.fn().mockReturnThis(),
  sign:   jest.fn().mockReturnValue('mock-signature'),
};
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createSign: jest.fn(() => mockSign),
}));

import fs     from 'fs';
import http2  from 'http2';
import crypto from 'crypto';

function currentHttp2(): typeof import('http2') { return require('http2'); }
function currentCrypto(): typeof import('crypto') { return require('crypto'); }

// pushSender her testten önce fresh import edilsin
let pushSender: typeof import('../lib/pushSender');

function makeMockRequest(statusCode: number, responseBody = ''): void {
  const mockReq = {
    on: jest.fn((event: string, cb: (data?: unknown) => void) => {
      if (event === 'response') cb({ ':status': statusCode } as unknown);
      if (event === 'data')     cb(Buffer.from(responseBody));
      if (event === 'end')      cb();
      return mockReq;
    }),
    setEncoding: jest.fn(),
    write:       jest.fn(),
    end:         jest.fn(),
  };
  mockHttp2Request.mockReturnValue(mockReq);
}

beforeEach(async () => {
  jest.resetModules();

  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'),  db);

  // APNs env değişkenlerini ayarla
  process.env.APNS_KEY_PATH  = '/fake/AuthKey.p8';
  process.env.APNS_KEY_ID    = 'TESTKEY1234';
  process.env.APNS_TEAM_ID   = 'TEAMID5678';
  process.env.APNS_BUNDLE_ID = 'com.test.bridge';
  process.env.APNS_ENV       = 'sandbox';

  // fs mock — p8 key içeriği
  (fs.readFileSync as jest.Mock).mockReturnValue(
    '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtest\n-----END PRIVATE KEY-----\n'
  );

  jest.clearAllMocks();
  mockHttp2Session.destroyed = false;

  pushSender = require('../lib/pushSender');
});

afterEach(() => {
  delete process.env.APNS_KEY_PATH;
  delete process.env.APNS_KEY_ID;
  delete process.env.APNS_TEAM_ID;
  delete process.env.APNS_BUNDLE_ID;
  delete process.env.APNS_ENV;
});

// ═══════════════════════════════════════════════════════════════
// getApnsConfig (dolaylı — sendAPNs üzerinden)
// ═══════════════════════════════════════════════════════════════
describe('APNs yapılandırma kontrolü', () => {
  it('env değişkenleri eksikse sendAPNs sessizce döner', async () => {
    delete process.env.APNS_KEY_PATH;
    jest.resetModules();
    const ps = require('../lib/pushSender');

    await expect(
      ps.sendAPNs('device-token-abc', { title: 'Test', body: 'Merhaba' })
    ).resolves.toBeUndefined();

    expect(http2.connect).not.toHaveBeenCalled();
  });

  it('tüm env değişkenleri mevcutsa http2 bağlantısı kurulur', async () => {
    makeMockRequest(200);
    await pushSender.sendAPNs('device-token-abc', { title: 'Test', body: 'Merhaba' });
    expect(currentHttp2().connect).toHaveBeenCalledWith('https://api.sandbox.push.apple.com');
  });

  it('production env kullanıldığında doğru host seçilir', async () => {
    process.env.APNS_ENV = 'production';
    jest.resetModules();
    const ps = require('../lib/pushSender');
    makeMockRequest(200);
    await ps.sendAPNs('device-token-abc', { title: 'Test', body: 'Merhaba' });
    expect(currentHttp2().connect).toHaveBeenCalledWith('https://api.push.apple.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// JWT imzalama
// ═══════════════════════════════════════════════════════════════
describe('APNs JWT üretimi', () => {
  it('ES256 ile imzalanır ve doğru header içerir', async () => {
    makeMockRequest(200);
    await pushSender.sendAPNs('device-token-abc', { title: 'T', body: 'B' });

    expect(currentCrypto().createSign).toHaveBeenCalledWith('SHA256');
    expect(mockSign.sign).toHaveBeenCalledWith(
      expect.objectContaining({ dsaEncoding: 'ieee-p1363' }),
      'base64url'
    );
  });

  it('p8 dosyası okunamazsa hata loglanır, throw edilmez', async () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: dosya bulunamadı');
    });

    await expect(
      pushSender.sendAPNs('device-token-abc', { title: 'T', body: 'B' })
    ).resolves.toBeUndefined();

    expect(http2.connect).not.toHaveBeenCalled();
  });

  it('JWT Authorization header olarak gönderilir', async () => {
    makeMockRequest(200);
    await pushSender.sendAPNs('device-token-abc', { title: 'T', body: 'B' });

    const callArgs = mockHttp2Request.mock.calls[0][0] as Record<string, string>;
    expect(callArgs['authorization']).toMatch(/^bearer /);
    expect(callArgs[':path']).toBe('/3/device/device-token-abc');
    expect(callArgs['apns-topic']).toBe('com.test.bridge');
  });
});

// ═══════════════════════════════════════════════════════════════
// HTTP/2 istek gönderimi
// ═══════════════════════════════════════════════════════════════
describe('APNs HTTP/2 istek', () => {
  it('200 döndüğünde başarılı sayılır', async () => {
    makeMockRequest(200);
    await expect(
      pushSender.sendAPNs('valid-token', { title: 'T', body: 'B', badge: 3 })
    ).resolves.toBeUndefined();
  });

  it('payload badge ve data alanlarını içerir', async () => {
    makeMockRequest(200);
    await pushSender.sendAPNs('valid-token', {
      title: 'Yeni mesaj',
      body:  'Merhaba!',
      badge: 5,
      data:  { channelId: 'ch1', serverId: 'srv1' },
    });

    const written = (mockHttp2Request.mock.results[0].value.write as jest.Mock).mock.calls[0][0] as string;
    const parsed  = JSON.parse(written) as { aps: { badge: number }; channelId?: string };
    expect(parsed.aps.badge).toBe(5);
    expect(parsed.channelId).toBe('ch1');
  });

  it('410 Unregistered — token DB\'den silinir', async () => {
    const removeToken = jest.spyOn(
      require('../db/repositories').Notifications,
      'removeNativeTokenWhere'
    ).mockResolvedValue(undefined);

    makeMockRequest(410, JSON.stringify({ reason: 'Unregistered' }));
    await pushSender.sendAPNs('stale-token', { title: 'T', body: 'B' });

    expect(removeToken).toHaveBeenCalledWith({ token: 'stale-token' });
  });

  it('BadDeviceToken — token DB\'den silinir', async () => {
    const removeToken = jest.spyOn(
      require('../db/repositories').Notifications,
      'removeNativeTokenWhere'
    ).mockResolvedValue(undefined);

    makeMockRequest(400, JSON.stringify({ reason: 'BadDeviceToken' }));
    await pushSender.sendAPNs('bad-token', { title: 'T', body: 'B' });

    expect(removeToken).toHaveBeenCalledWith({ token: 'bad-token' });
  });

  it('5xx sunucu hatası — token silinmez, hata loglanır', async () => {
    const removeToken = jest.spyOn(
      require('../db/repositories').Notifications,
      'removeNativeTokenWhere'
    ).mockResolvedValue(undefined);

    makeMockRequest(500, JSON.stringify({ reason: 'InternalServerError' }));
    await pushSender.sendAPNs('valid-token', { title: 'T', body: 'B' });

    expect(removeToken).not.toHaveBeenCalled();
  });

  it('http2 istek hatası — throw edilmez', async () => {
    mockHttp2Request.mockImplementation(() => {
      throw new Error('HTTP/2 bağlantı hatası');
    });

    await expect(
      pushSender.sendAPNs('valid-token', { title: 'T', body: 'B' })
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// HTTP/2 client havuzu
// ═══════════════════════════════════════════════════════════════
describe('HTTP/2 client havuzu', () => {
  it('aynı host için tek bağlantı kullanılır', async () => {
    makeMockRequest(200);
    await pushSender.sendAPNs('token-1', { title: 'T', body: 'B' });

    makeMockRequest(200);
    await pushSender.sendAPNs('token-2', { title: 'T', body: 'B' });

    // http2.connect yalnızca bir kez çağrılmalı (cache hit)
    expect(currentHttp2().connect).toHaveBeenCalledTimes(1);
  });

  it('destroyed session yeniden bağlanır', async () => {
    makeMockRequest(200);
    await pushSender.sendAPNs('token-1', { title: 'T', body: 'B' });

    mockHttp2Session.destroyed = true;
    makeMockRequest(200);
    await pushSender.sendAPNs('token-2', { title: 'T', body: 'B' });

    expect(currentHttp2().connect).toHaveBeenCalledTimes(2);
  });

  it('closeApnsConnections bağlantıları kapatır', async () => {
    makeMockRequest(200);
    await pushSender.sendAPNs('token-1', { title: 'T', body: 'B' });

    pushSender.closeApnsConnections();
    expect(mockHttp2Session.close).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// sendPushToUser — platform yönlendirme
// ═══════════════════════════════════════════════════════════════
describe('sendPushToUser platform yönlendirme', () => {
  let sendAPNsSpy: jest.SpyInstance;
  let sendFCMSpy:  jest.SpyInstance;

  beforeEach(() => {
    const user = makeUser({ username: 'pushuser' });
    db.users.insert(user);

    sendAPNsSpy = jest.spyOn(pushSender, 'sendAPNs').mockResolvedValue(undefined);
    sendFCMSpy  = jest.spyOn(pushSender, 'sendFCM').mockResolvedValue(undefined);

    jest.spyOn(require('../db/repositories').Notifications, 'findPushSubscriptionsForUser').mockResolvedValue([]);
    jest.spyOn(require('../db/repositories').Notifications, 'findFcmTokensForUser').mockResolvedValue([]);
    jest.spyOn(require('../db/repositories').Members, 'findByUser').mockResolvedValue([]);
    jest.spyOn(require('../db/repositories').Dms, 'findConversationsByUser').mockResolvedValue([]);
  });

  it('iOS token → sendAPNs, android token → sendFCM', async () => {
    jest.spyOn(require('../db/repositories').Notifications, 'findNativeTokensForUser')
      .mockResolvedValue([
        { token: 'ios-token-abc', platform: 'ios' },
        { token: 'fcm-token-xyz', platform: 'android' },
      ]);

    await pushSender.sendPushToUser('user-id', { title: 'Test', body: 'Merhaba' });

    expect(sendAPNsSpy).toHaveBeenCalledWith('ios-token-abc', expect.any(Object));
    expect(sendFCMSpy).toHaveBeenCalledWith('fcm-token-xyz', expect.any(Object));
    expect(sendAPNsSpy).toHaveBeenCalledTimes(1);
    expect(sendFCMSpy).toHaveBeenCalledTimes(1);
  });

  it('APNs yapılandırılmamışsa iOS token da FCM\'e gider', async () => {
    delete process.env.APNS_KEY_PATH;
    jest.resetModules();
    const ps = require('../lib/pushSender');
    const apnsSpy = jest.spyOn(ps, 'sendAPNs').mockResolvedValue(undefined);
    const fcmSpy  = jest.spyOn(ps, 'sendFCM').mockResolvedValue(undefined);

    jest.spyOn(require('../db/repositories').Notifications, 'findNativeTokensForUser')
      .mockResolvedValue([{ token: 'ios-token-abc', platform: 'ios' }]);
    jest.spyOn(require('../db/repositories').Notifications, 'findPushSubscriptionsForUser').mockResolvedValue([]);
    jest.spyOn(require('../db/repositories').Notifications, 'findFcmTokensForUser').mockResolvedValue([]);
    jest.spyOn(require('../db/repositories').Members, 'findByUser').mockResolvedValue([]);
    jest.spyOn(require('../db/repositories').Dms, 'findConversationsByUser').mockResolvedValue([]);

    await ps.sendPushToUser('user-id', { title: 'Test', body: 'Merhaba' });

    expect(apnsSpy).not.toHaveBeenCalled();
    expect(fcmSpy).toHaveBeenCalledWith('ios-token-abc', expect.any(Object));
  });
});
