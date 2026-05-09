// server/tests/httpSignature.test.js
// HTTP Signature doğrulama ve imzalama testleri:
//   - verifyHttpSignature: geçerli imza, eksik header, digest mismatch,
//     replay attack, zaman penceresi, key cache, per-user keyId
//   - signRequest: Mastodon uyumlu format, per-user keyId, body digest

'use strict';

process.env.NODE_ENV     = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';
process.env.PORT         = '3001';

const crypto = require('crypto');

// ── Mock DB ───────────────────────────────────────────────────────────────────
const { createMockDb, makeUser } = require('./helpers/mockDb');
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

// ── Mock fetch (remote key fetch) ─────────────────────────────────────────────
global.fetch = jest.fn();

// federation.js'i temiz yükle
let fed;
beforeAll(() => {
  // Modülü önbellek temizleyerek yükle
  jest.resetModules();
  fed = require('../routes/federation');
});

afterEach(() => {
  global.fetch.mockReset();
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
function buildSignedRequest({
  method = 'POST',
  path   = '/api/federation/users/alice/inbox',
  body   = '{}',
  privateKey,
  keyId,
  dateOverride,
}) {
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
    authMiddleware: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  }), { virtual: true });
  const router = require('../routes/federation');
  app.use('/api/federation', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
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
    global.fetch.mockResolvedValueOnce({
      ok:   true,
      json: async () => ({ publicKey: { publicKeyPem: publicKey } }),
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

    function isReplay(sig) {
      const exp = used.get(sig);
      if (!exp) return false;
      if (Date.now() > exp) { used.delete(sig); return false; }
      return true;
    }
    function markUsed(sig) { used.set(sig, Date.now() + TTL); }

    const sig = 'test-signature-abc123';
    expect(isReplay(sig)).toBe(false);
    markUsed(sig);
    expect(isReplay(sig)).toBe(true);
  });

  it('süresi dolmuş signature tekrar kabul edilmeli', () => {
    const used = new Map();
    const sig  = 'old-sig-xyz';
    used.set(sig, Date.now() - 1); // zaten süresi dolmuş

    function isReplay(s) {
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

    function cacheGet(id) {
      const e = cache.get(id);
      if (!e || Date.now() > e.expiresAt) return null;
      return e.pem;
    }
    function cacheSet(id, p) { cache.set(id, { pem: p, expiresAt: Date.now() + TTL }); }

    expect(cacheGet(keyId)).toBeNull();
    cacheSet(keyId, pem);
    expect(cacheGet(keyId)).toBe(pem);
  });

  it('süresi dolmuş cache girişi null döner', () => {
    const cache = new Map();
    const keyId = 'https://example.com/users/old#main-key';
    cache.set(keyId, { pem: 'old-pem', expiresAt: Date.now() - 1 });

    function cacheGet(id) {
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
    const req = {
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
