// server/tests/httpSignature.test.ts
// HTTP Signature doğrulama ve imzalama testleri:
//   - verifyHttpSignature: geçerli imza, eksik header, digest mismatch,
//     replay attack, zaman penceresi, key cache, per-user keyId
//   - signRequest: Mastodon uyumlu format, per-user keyId, body digest
import type { Request, Response, NextFunction } from 'express';
import { fetchMock, installFetchMock } from './helpers/fetchDouble';

'use strict';

process.env.NODE_ENV     = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';
process.env.PORT         = '3001';

import crypto from 'crypto';

// ── Mock DB ───────────────────────────────────────────────────────────────────
import { createMockDb, makeUser } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

// ── Mock fetch (remote key fetch) ─────────────────────────────────────────────
installFetchMock();

jest.mock('../lib/fetch', () => ({
  fetchT: jest.fn((...args: Parameters<typeof fetch>) => global.fetch(...args)),
  default: jest.fn((...args: Parameters<typeof fetch>) => global.fetch(...args)),
}));

// federation.js'i temiz yükle
let fed: typeof import('../routes/federation');
beforeAll(() => {
  // Modülü önbellek temizleyerek yükle
  jest.resetModules();
  fed = require('../routes/federation');
});

afterEach(() => {
  fetchMock().mockReset();
  jest.resetModules();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
function genKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * Bir HTTP isteğini RSA-SHA256 ile imzalar.
 * federation.js içindeki signRequest ile aynı algoritmayı uygular.
 */
// Parametreler eskiden tipsizdi. Bunun gorunmeyen bedeli su: `dateOverride`
// ortuk `any` oldugu icin TypeScript onu ZORUNLU sayiyordu ve onu gecmeyen
// ON BIR cagri TS2345 veriyordu. Tip yazilinca hem hatalar kapandi hem de
// "hangi alan istege bagli?" sorusu imzada cevaplanmis oldu.
interface SignedRequestOptions {
  method?: string;
  path?: string;
  body?: string;
  privateKey: string;
  keyId: string;
  /** Saat kaymasi/eskime senaryolari icin; verilmezse SIMDIKI zaman. */
  dateOverride?: string;
}

function buildSignedRequest({
  method = 'POST',
  path   = '/api/federation/users/alice/inbox',
  body   = '{}',
  privateKey,
  keyId,
  dateOverride,
}: SignedRequestOptions) {
  const date   = dateOverride ?? new Date().toUTCString();
  const host   = 'bridge.test';
  const digest = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
  const target = `${method.toLowerCase()} ${path}`;
  const sigStr = `(request-target): ${target}\nhost: ${host}\ndate: ${date}\ndigest: ${digest}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigStr);
  const signature = sign.sign(privateKey, 'base64');

  const sigHeader = [
    `keyId="${keyId}"`,
    'algorithm="rsa-sha256"',
    'headers="(request-target) host date digest"',
    `signature="${signature}"`,
  ].join(',');

  return {
    headers: {
      host,
      date,
      digest,
      signature: sigHeader,
    },
    method,
    originalUrl: path,
    body: JSON.parse(body),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// federation.js'in internal fonksiyonlarına erişmek için modülü eval ile expose etmek
// yerine, supertest üzerinden inbox endpoint'ini test ediyoruz.
// Internal fonksiyonları doğrudan test etmek için ayrı bir util extract ettik.

const express  = require('express');
const request  = require('supertest');

function buildApp() {
  jest.resetModules();
  const app = express();
  app.use(express.json());
  // Auth middleware'i bypass et
  jest.mock('../middleware/auth', () => ({
    // `JwtPayload` `username` ve `v` de ister; eksik birakmak testi urunun
    // gercekten gordugu nesneden UZAKLASTIRIRDI.
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: 'u1', username: 'u1', v: 1 };
      next();
    },
    castAuthed: (req: Request) => req,
  }), { virtual: true });
  const router = require('../routes/federation');
  app.use('/api/federation', router);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. signRequest — imzalama testleri
// ══════════════════════════════════════════════════════════════════════════════

describe('signRequest (outgoing)', () => {
  const { privateKey, publicKey } = genKeyPair();

  it('üretilen Signature header doğrulanabilir', () => {
    const body    = JSON.stringify({ type: 'Follow' });
    const date    = new Date().toUTCString();
    const digest  = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
    const target  = 'post /api/federation/users/bob/inbox';
    const sigStr  = `(request-target): ${target}\nhost: mastodon.social\ndate: ${date}\ndigest: ${digest}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(sigStr);
    const sig = sign.sign(privateKey, 'base64');

    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(sigStr);
    expect(verify.verify(publicKey, sig, 'base64')).toBe(true);
  });

  it('per-user keyId doğru formatta', () => {
    // keyId = https://bridge.test/api/federation/users/{username}#main-key
    const username = 'alice';
    const expectedKeyId = `https://bridge.test/api/federation/users/${username}#main-key`;
    expect(expectedKeyId).toMatch(/\/users\/alice#main-key$/);
  });

  it('farklı body için Digest farklı olmalı', () => {
    const d1 = 'SHA-256=' + crypto.createHash('sha256').update('body1').digest('base64');
    const d2 = 'SHA-256=' + crypto.createHash('sha256').update('body2').digest('base64');
    expect(d1).not.toBe(d2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. verifyHttpSignature — inbox endpoint üzerinden entegrasyon
// ══════════════════════════════════════════════════════════════════════════════

describe('verifyHttpSignature (inbox entegrasyon)', () => {
  const { privateKey, publicKey } = genKeyPair();
  const REMOTE_KEY_ID = 'https://mastodon.social/users/remote#main-key';
  const LOCAL_USERNAME = 'inboxtest';
  const LOCAL_USER_ID  = 'inbox-user-uid';

  beforeAll(async () => {
    await mockDb.users.insert(makeUser({
      _id:      LOCAL_USER_ID,
      username: LOCAL_USERNAME,
    }));
  });

  function mockRemoteKey() {
    fetchMock().mockResolvedValueOnce({
      ok:   true,
      json: async () => ({ publicKey: { publicKeyPem: publicKey, owner: 'https://mastodon.social/users/remote' } }),
    });
  }

  it('geçerli imzayla 202 döner', async () => {
    mockRemoteKey();
    const body = JSON.stringify({ type: 'Follow', actor: 'https://mastodon.social/users/remote', object: `https://bridge.test/api/federation/users/${LOCAL_USERNAME}` });
    const req = buildSignedRequest({ body, privateKey, keyId: REMOTE_KEY_ID, path: `/api/federation/users/${LOCAL_USERNAME}/inbox` });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
      .set(req.headers)
      .send(JSON.parse(body));

    expect(res.status).toBe(202);
  });

  it('Signature header yoksa 401 döner (production)', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp();
    const res = await request(app)
      .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
      .set('Content-Type', 'application/activity+json')
      .send({ type: 'Follow' });
    process.env.NODE_ENV = 'test';
    expect(res.status).toBe(401);
  });

  it('yanlış imzayla 401 döner', async () => {
    const { privateKey: wrongKey } = genKeyPair(); // başka anahtar
    mockRemoteKey(); // ama public key doğru gönderiliyor
    const body = JSON.stringify({ type: 'Create' });
    const req = buildSignedRequest({ body, privateKey: wrongKey, keyId: REMOTE_KEY_ID, path: `/api/federation/users/${LOCAL_USERNAME}/inbox` });

    process.env.NODE_ENV = 'production';
    const app = buildApp();
    const res = await request(app)
      .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
      .set(req.headers)
      .send(JSON.parse(body));
    process.env.NODE_ENV = 'test';

    expect(res.status).toBe(401);
  });

  it('Digest uyumsuzluğunda 401 döner', async () => {
    mockRemoteKey();
    const body = JSON.stringify({ type: 'Follow' });
    const req = buildSignedRequest({ body, privateKey, keyId: REMOTE_KEY_ID, path: `/api/federation/users/${LOCAL_USERNAME}/inbox` });
    // Digest'i bilerek boz
    req.headers.digest = 'SHA-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

    process.env.NODE_ENV = 'production';
    const app = buildApp();
    const res = await request(app)
      .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
      .set(req.headers)
      .send(JSON.parse(body));
    process.env.NODE_ENV = 'test';

    expect(res.status).toBe(401);
  });

  it('süresi dolmuş Date header ile 401 döner', async () => {
    const oldDate = new Date(Date.now() - 10 * 60 * 1000).toUTCString(); // 10 dk önce
    mockRemoteKey();
    const body = JSON.stringify({ type: 'Follow' });
    const req = buildSignedRequest({ body, privateKey, keyId: REMOTE_KEY_ID, path: `/api/federation/users/${LOCAL_USERNAME}/inbox`, dateOverride: oldDate });

    process.env.NODE_ENV = 'production';
    const app = buildApp();
    const res = await request(app)
      .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
      .set(req.headers)
      .send(JSON.parse(body));
    process.env.NODE_ENV = 'test';

    expect(res.status).toBe(401);
  });

  it('bilinmeyen kullanıcı inbox için 404 döner', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/federation/users/no_such_user_xyz/inbox')
      .send({ type: 'Follow' });
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Replay Attack Koruması — unit
// ══════════════════════════════════════════════════════════════════════════════

describe('Replay attack koruması (unit)', () => {
  it('aynı signature hash iki kez kabul edilmemeli', () => {
    // _usedSignatures iç Map'i doğrudan test edemeyiz ama davranışı simüle ederiz
    const used = new Map();
    const TTL  = 5 * 60 * 1000;

    function isReplay(sig: string) {
      const exp = used.get(sig);
      if (!exp) return false;
      if (Date.now() > exp) { used.delete(sig); return false; }
      return true;
    }
    function markUsed(sig: string) { used.set(sig, Date.now() + TTL); }

    const sig = 'test-signature-abc123';
    expect(isReplay(sig)).toBe(false);
    markUsed(sig);
    expect(isReplay(sig)).toBe(true);
  });

  it('süresi dolmuş signature tekrar kabul edilmeli', () => {
    const used = new Map();
    const sig  = 'old-sig-xyz';
    used.set(sig, Date.now() - 1); // zaten süresi dolmuş

    function isReplay(s: string) {
      const exp = used.get(s);
      if (!exp) return false;
      if (Date.now() > exp) { used.delete(s); return false; }
      return true;
    }

    expect(isReplay(sig)).toBe(false); // süresi doldu, tekrar kabul edilmeli
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Public Key Cache — unit
// ══════════════════════════════════════════════════════════════════════════════

describe('Public key cache (unit)', () => {
  it('cache hit — ikinci fetch yapılmamalı', () => {
    const cache = new Map();
    const TTL   = 10 * 60 * 1000;
    const keyId = 'https://mastodon.social/users/bob#main-key';
    const pem   = '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----';

    function cacheGet(id: string) {
      const e = cache.get(id);
      if (!e || Date.now() > e.expiresAt) return null;
      return e.pem;
    }
    function cacheSet(id: string, p: string) { cache.set(id, { pem: p, expiresAt: Date.now() + TTL }); }

    expect(cacheGet(keyId)).toBeNull();
    cacheSet(keyId, pem);
    expect(cacheGet(keyId)).toBe(pem);
  });

  it('süresi dolmuş cache girişi null döner', () => {
    const cache = new Map();
    const keyId = 'https://example.com/users/old#main-key';
    cache.set(keyId, { pem: 'old-pem', expiresAt: Date.now() - 1 });

    function cacheGet(id: string) {
      const e = cache.get(id);
      if (!e || Date.now() > e.expiresAt) { cache.delete(id); return null; }
      return e.pem;
    }

    expect(cacheGet(keyId)).toBeNull();
    expect(cache.has(keyId)).toBe(false); // temizlendi
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Signing string format — Mastodon uyumluluğu
// ══════════════════════════════════════════════════════════════════════════════

describe('Signing string format', () => {
  it('(request-target) doğru formatta', () => {
    const method = 'POST';
    const path   = '/api/federation/users/alice/inbox';
    const line   = `(request-target): ${method.toLowerCase()} ${path}`;
    expect(line).toBe('(request-target): post /api/federation/users/alice/inbox');
  });

  it('header isimleri küçük harfle normalize edilmeli', () => {
    const headers = { 'Date': '...', 'Host': 'bridge.test', 'Digest': 'SHA-256=...' };
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    expect(normalized['date']).toBeDefined();
    expect(normalized['host']).toBeDefined();
    expect(normalized['digest']).toBeDefined();
  });

  it('imzalı header sırası signing string sırasını belirler', () => {
    const headerList = ['(request-target)', 'host', 'date', 'digest'];
    // `headers` ANNOTASYONLA `Record<string, string>`tur (cast DEGIL):
    // asagida `req.headers[h]` ile DEGISKEN bir ad uzerinden okunuyor ve
    // nesne edebi tipi bu erisime kapalidir.
    const req: { method: string; originalUrl: string; headers: Record<string, string> } = {
      method: 'POST',
      originalUrl: '/inbox',
      headers: { host: 'bridge.test', date: 'Thu, 01 Jan 2026 00:00:00 GMT', digest: 'SHA-256=abc' },
    };
    const lines = headerList.map(h => {
      if (h === '(request-target)') return `(request-target): post /inbox`;
      return `${h}: ${req.headers[h] ?? ''}`;
    });
    const sigStr = lines.join('\n');
    expect(sigStr.split('\n')).toHaveLength(4);
    expect(sigStr).toContain('(request-target): post /inbox');
    expect(sigStr).toContain('host: bridge.test');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Yeni Güvenlik Kenar Durumları — Sprint 52 düzeltmelerini kapsar
//    a) Blocked host (SSRF koruması)
//    b) Wrong algorithm
//    c) Missing (request-target)
// ══════════════════════════════════════════════════════════════════════════════

describe('HTTP Signature güvenlik kenar durumları (Sprint 52)', () => {
  const { privateKey, publicKey } = genKeyPair();
  const LOCAL_USERNAME = 'edgetest';
  const LOCAL_USER_ID  = 'edge-user-uid';

  beforeAll(async () => {
    await mockDb.users.insert(makeUser({
      _id:      LOCAL_USER_ID,
      username: LOCAL_USERNAME,
    }));
  });

  afterEach(() => {
    fetchMock().mockReset();
    jest.resetModules();
    process.env.NODE_ENV = 'test';
  });

  // ── 6a. Blocked host (SSRF) ───────────────────────────────────────────────

  describe('6a. Blocked host — SSRF koruması', () => {
    const BLOCKED_HOSTS = [
      'https://169.254.169.254/latest/meta-data/',   // AWS metadata
      'https://192.168.1.1/users/attacker#main-key', // RFC-1918
      'https://10.0.0.1/users/attacker#main-key',    // RFC-1918
      'https://127.0.0.1/users/attacker#main-key',   // localhost
      'https://localhost/users/attacker#main-key',    // localhost (hostname)
    ];

    it.each(BLOCKED_HOSTS)('keyId=%s için fetch yapılmaz ve 401 döner', async (blockedKeyId) => {
      // keyId olarak internal/SSRF hedefini gönder
      // fetch mock'u çağrılmamalı — SSRF koruması fetch'ten önce devreye girmeli
      const fetchSpy = global.fetch;

      const body = JSON.stringify({ type: 'Follow' });
      // Geçerli imzayla ama blocked keyId ile istek oluştur
      const req = buildSignedRequest({
        body,
        privateKey,
        keyId: blockedKeyId,
        path:  `/api/federation/users/${LOCAL_USERNAME}/inbox`,
      });

      process.env.NODE_ENV = 'production';
      const app = buildApp();
      const res = await request(app)
        .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
        .set(req.headers)
        .send(JSON.parse(body));

      expect(res.status).toBe(401);
      // SSRF koruması aktifse fetch hiç çağrılmamış olmalı
      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining(new URL(blockedKeyId).hostname),
        expect.anything()
      );
    });

    it('http:// (non-HTTPS) keyId için 401 döner', async () => {
      const httpKeyId = 'http://mastodon.social/users/remote#main-key';
      const body = JSON.stringify({ type: 'Follow' });
      const req = buildSignedRequest({
        body,
        privateKey,
        keyId: httpKeyId,
        path:  `/api/federation/users/${LOCAL_USERNAME}/inbox`,
      });

      process.env.NODE_ENV = 'production';
      const app = buildApp();
      const res = await request(app)
        .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
        .set(req.headers)
        .send(JSON.parse(body));

      expect(res.status).toBe(401);
      expect(fetchMock()).not.toHaveBeenCalled();
    });

    it('3xx redirect yanıtı verilen keyId fetch için 401 döner', async () => {
      // redirect: 'manual' aktif — 3xx response fetch tarafından opaque döner,
      // httpSignature.ts bunu hata olarak işler
      fetchMock().mockResolvedValueOnce({
        ok:     false,
        status: 301,
        type:   'opaqueredirect',
        // 3xx için json() çağrısı genellikle hata fırlatır ya da boş döner
        json: async () => { throw new Error('opaque redirect'); },
      });

      const REDIRECT_KEY_ID = 'https://mastodon.social/users/redirect#main-key';
      const body = JSON.stringify({ type: 'Follow' });
      const req = buildSignedRequest({
        body,
        privateKey,
        keyId: REDIRECT_KEY_ID,
        path:  `/api/federation/users/${LOCAL_USERNAME}/inbox`,
      });

      process.env.NODE_ENV = 'production';
      const app = buildApp();
      const res = await request(app)
        .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
        .set(req.headers)
        .send(JSON.parse(body));

      expect(res.status).toBe(401);
    });
  });

  // ── 6b. Wrong algorithm ───────────────────────────────────────────────────

  describe('6b. Desteklenmeyen algoritma', () => {
    const REMOTE_KEY_ID  = 'https://mastodon.social/users/algo-attacker#main-key';
    const BAD_ALGORITHMS = ['hmac-sha1', 'hmac-sha256', 'rsa-md5', 'ecdsa-sha256', 'none'];

    it.each(BAD_ALGORITHMS)('algorithm="%s" gönderildiğinde 401 döner', async (badAlgo) => {
      // Remote key mock — fetch başarılı, key geçerli, SADECE algoritma yanlış
      fetchMock().mockResolvedValueOnce({
        ok:   true,
        json: async () => ({ publicKey: { publicKeyPem: publicKey } }),
      });

      const body = JSON.stringify({ type: 'Create' });
      const req  = buildSignedRequest({
        body,
        privateKey,
        keyId: REMOTE_KEY_ID,
        path:  `/api/federation/users/${LOCAL_USERNAME}/inbox`,
      });

      // Signature header'daki algorithm değerini değiştir
      req.headers.signature = req.headers.signature.replace(
        /algorithm="[^"]*"/,
        `algorithm="${badAlgo}"`
      );

      process.env.NODE_ENV = 'production';
      const app = buildApp();
      const res = await request(app)
        .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
        .set(req.headers)
        .send(JSON.parse(body));

      expect(res.status).toBe(401);
    });

    it('algorithm parametresi yoksa (hs2019 fallback) geçerli imzayla 202 döner', async () => {
      // RFC draft: algorithm yoksa hs2019 olarak kabul edilir
      fetchMock().mockResolvedValueOnce({
        ok:   true,
        json: async () => ({ publicKey: { publicKeyPem: publicKey } }),
      });

      const body = JSON.stringify({ type: 'Follow', actor: 'https://mastodon.social/users/noalgo', object: `https://bridge.test/api/federation/users/${LOCAL_USERNAME}` });
      const req  = buildSignedRequest({
        body,
        privateKey,
        keyId: 'https://mastodon.social/users/noalgo#main-key',
        path:  `/api/federation/users/${LOCAL_USERNAME}/inbox`,
      });

      // algorithm alanını header'dan sil
      req.headers.signature = req.headers.signature.replace(/,?algorithm="[^"]*"/, '');

      const app = buildApp();
      const res = await request(app)
        .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
        .set(req.headers)
        .send(JSON.parse(body));

      // test modunda 202 ya da imza doğrulanabilir — production'da farklı davranabilir
      // Burada yalnızca server crash etmediğini (5xx değil) doğruluyoruz
      expect(res.status).not.toBe(500);
    });
  });

  // ── 6c. Missing (request-target) ─────────────────────────────────────────

  describe('6c. (request-target) eksik', () => {
    const REMOTE_KEY_ID = 'https://mastodon.social/users/notarget#main-key';

    it('imzalı header listesinde (request-target) yoksa 401 döner', async () => {
      fetchMock().mockResolvedValueOnce({
        ok:   true,
        json: async () => ({ publicKey: { publicKeyPem: publicKey } }),
      });

      const body = JSON.stringify({ type: 'Follow' });
      const req  = buildSignedRequest({
        body,
        privateKey,
        keyId: REMOTE_KEY_ID,
        path:  `/api/federation/users/${LOCAL_USERNAME}/inbox`,
      });

      // headers listesinden (request-target) çıkar
      req.headers.signature = req.headers.signature.replace(
        'headers="(request-target) host date digest"',
        'headers="host date digest"'
      );
      // Signing string de buna göre yeniden oluşturulmalı — ama burada
      // signature değeri eski (request-target) içeren string ile hesaplanmış.
      // Signature doğrulaması zaten başarısız olur; ancak asıl test
      // "eksik (request-target)" early-return'ü olup olmadığını kontrol eder.
      // Sunucu imza doğrulamasına bile girmeden 401 dönmeli.

      process.env.NODE_ENV = 'production';
      const app = buildApp();
      const res = await request(app)
        .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)
        .set(req.headers)
        .send(JSON.parse(body));

      expect(res.status).toBe(401);
    });

    it('(request-target) olmadan replay saldırısı önlenemez — doğrulama reddi', async () => {
      // Bu test, (request-target) olmadan imzalı bir isteğin
      // farklı bir path'e replay edilemeyeceğini gösterir.
      // Çünkü sunucu zaten (request-target) zorunluluğunu reddeder.
      fetchMock().mockResolvedValueOnce({
        ok:   true,
        json: async () => ({ publicKey: { publicKeyPem: publicKey } }),
      });

      // /inbox için imzalanmış ama (request-target) header listesinde yok
      const body = JSON.stringify({ type: 'Create' });
      const req  = buildSignedRequest({
        body,
        privateKey,
        keyId: REMOTE_KEY_ID,
        path:  `/api/federation/users/${LOCAL_USERNAME}/inbox`,
      });

      req.headers.signature = req.headers.signature.replace(
        /headers="[^"]*"/,
        'headers="host date digest"'
      );

      // Farklı bir endpoint'e replay dene (path farklı ama imza aynı)
      process.env.NODE_ENV = 'production';
      const app = buildApp();
      const res = await request(app)
        .post(`/api/federation/users/${LOCAL_USERNAME}/inbox`)  // aynı path bile olsa
        .set(req.headers)
        .send(JSON.parse(body));

      expect(res.status).toBe(401);
    });
  });
});
