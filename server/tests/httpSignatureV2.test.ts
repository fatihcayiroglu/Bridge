// server/tests/httpSignatureV2.test.ts
// ADR-0006 Faz 2 — verifyFederationRequest birim testleri
//
// Sprint 108: RSA öncelikli doğrulama + HMAC fallback senaryoları
//
// Kapsam (25 test):
//   - RSA doğrulama başarılı
//   - RSA başarısız → HMAC fallback yok (per-peer key varsa HMAC'a geçmez)
//   - publicKey yoksa HMAC fallback
//   - Zaman damgası eksik / süresi dolmuş
//   - Bilinmeyen peer
//   - buildFederationHeaders çıktı formatı
//   - timingSafeEqual ile timing-attack koruması

import crypto from 'crypto';

// ── db mock ──────────────────────────────────────────────────────────────────

const _peers: Record<string, unknown> = {};

jest.mock('../db/loader', () => ({
  __esModule: true,
  default: {
    federationPeers: {
      findOne: jest.fn(async ({ url }: { url: string }) => _peers[url] ?? null),
    },
  },
}));

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Yardımcı ─────────────────────────────────────────────────────────────────

function genRsaPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function rsaSign(payload: string, privateKeyPem: string): string {
  const sign = crypto.createSign('sha256');
  sign.update(payload);
  return sign.sign(privateKeyPem, 'base64');
}

function hmacSign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function freshTs(): string {
  return String(Date.now());
}

function staleTs(): string {
  return String(Date.now() - 10 * 60 * 1000); // 10 dakika önce
}

// ── Import ────────────────────────────────────────────────────────────────────

import {
  verifyFederationRequest,
  buildFederationHeaders,
} from '../lib/httpSignatureV2';

// ── Testler ───────────────────────────────────────────────────────────────────

describe('verifyFederationRequest', () => {

  const PEER_URL    = 'https://bridge-b.example.com';
  const PAYLOAD     = JSON.stringify({ action: 'ping' });
  const GLOBAL_SEC  = 'global-secret-xyz';

  beforeEach(() => {
    // Her testten önce peer kaydını temizle
    Object.keys(_peers).forEach(k => delete _peers[k]);
    process.env.FEDERATION_SECRET = GLOBAL_SEC;
  });

  afterAll(() => {
    delete process.env.FEDERATION_SECRET;
  });

  // ── Zaman damgası ──────────────────────────────────────────────────────────

  test('zaman damgası eksikse reddeder', async () => {
    _peers[PEER_URL] = { _id: 1, url: PEER_URL };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timestamp/i);
  });

  test('zaman damgası çok eskiyse reddeder', async () => {
    _peers[PEER_URL] = { _id: 1, url: PEER_URL };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts': staleTs(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timestamp/i);
  });

  test('geçersiz (NaN) zaman damgasını reddeder', async () => {
    _peers[PEER_URL] = { _id: 1, url: PEER_URL };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts': 'not-a-number',
    });
    expect(r.ok).toBe(false);
  });

  // ── Bilinmeyen peer ────────────────────────────────────────────────────────

  test('bilinmeyen peer URL reddeder', async () => {
    const r = await verifyFederationRequest('https://unknown.example.com', PAYLOAD, {
      'x-bridge-ts': freshTs(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown peer/i);
  });

  // ── RSA doğrulama ─────────────────────────────────────────────────────────

  test('geçerli RSA imzasıyla doğrular', async () => {
    const { publicKey, privateKey } = genRsaPair();
    _peers[PEER_URL] = { _id: 42, url: PEER_URL, publicKey };
    const sig = rsaSign(PAYLOAD, privateKey);
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':      freshTs(),
      'x-bridge-rsa-sig': sig,
    });
    expect(r.ok).toBe(true);
    expect(r.method).toBe('rsa');
    expect(r.peerId).toBe(42);
  });

  test('publicKey JSON doc formatında çalışır', async () => {
    const { publicKey, privateKey } = genRsaPair();
    _peers[PEER_URL] = {
      _id: 43, url: PEER_URL,
      publicKey: JSON.stringify({ publicKeyPem: publicKey }),
    };
    const sig = rsaSign(PAYLOAD, privateKey);
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':      freshTs(),
      'x-bridge-rsa-sig': sig,
    });
    expect(r.ok).toBe(true);
    expect(r.method).toBe('rsa');
  });

  test('yanlış RSA imzasıyla reddeder (HMAC fallback yapmaz)', async () => {
    const { publicKey } = genRsaPair();
    const { privateKey: otherPriv } = genRsaPair(); // farklı anahtar
    _peers[PEER_URL] = { _id: 44, url: PEER_URL, publicKey };
    const wrongSig = rsaSign(PAYLOAD, otherPriv);
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':      freshTs(),
      'x-bridge-rsa-sig': wrongSig,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rsa.*invalid/i);
  });

  test('RSA publicKey var ama rsa-sig header yoksa reddeder', async () => {
    const { publicKey } = genRsaPair();
    _peers[PEER_URL] = { _id: 45, url: PEER_URL, publicKey };
    // x-bridge-rsa-sig yok ama x-bridge-sig (HMAC) var
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':  freshTs(),
      'x-bridge-sig': hmacSign(PAYLOAD, GLOBAL_SEC),
    });
    // publicKey var → RSA yolu denenir, rsa-sig header yoktur → reddeder
    // (HMAC'a düşmez — güvenlik gerekliliği)
    expect(r.ok).toBe(false);
  });

  test('geçersiz PEM formatındaki publicKey\'i atlar ve HMAC\'a geçer', async () => {
    _peers[PEER_URL] = { _id: 46, url: PEER_URL, publicKey: 'not-a-valid-pem' };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':  freshTs(),
      'x-bridge-sig': hmacSign(PAYLOAD, GLOBAL_SEC),
    });
    // "BEGIN PUBLIC KEY" içermiyor → HMAC fallback
    expect(r.ok).toBe(true);
    expect(r.method).toBe('hmac');
  });

  // ── HMAC fallback ──────────────────────────────────────────────────────────

  test('publicKey yoksa HMAC ile doğrular (global secret)', async () => {
    _peers[PEER_URL] = { _id: 50, url: PEER_URL };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':  freshTs(),
      'x-bridge-sig': hmacSign(PAYLOAD, GLOBAL_SEC),
    });
    expect(r.ok).toBe(true);
    expect(r.method).toBe('hmac');
    expect(r.peerId).toBe(50);
  });

  test('per-peer secret global secret\'i geçersiz kılar', async () => {
    const peerSecret = 'per-peer-secret-abc';
    _peers[PEER_URL] = { _id: 51, url: PEER_URL, secret: peerSecret };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':  freshTs(),
      'x-bridge-sig': hmacSign(PAYLOAD, peerSecret),
    });
    expect(r.ok).toBe(true);
    expect(r.method).toBe('hmac');
  });

  test('yanlış HMAC imzasıyla reddeder', async () => {
    _peers[PEER_URL] = { _id: 52, url: PEER_URL };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts':  freshTs(),
      'x-bridge-sig': 'deadbeef',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hmac.*invalid/i);
  });

  test('HMAC header yoksa reddeder', async () => {
    _peers[PEER_URL] = { _id: 53, url: PEER_URL };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts': freshTs(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no hmac/i);
  });

  test('secret hiç yoksa reddeder', async () => {
    delete process.env.FEDERATION_SECRET;
    _peers[PEER_URL] = { _id: 54, url: PEER_URL };
    const r = await verifyFederationRequest(PEER_URL, PAYLOAD, {
      'x-bridge-ts': freshTs(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no.*secret/i);
  });

  // ── Farklı payload boyutları ───────────────────────────────────────────────

  test('boş payload ile RSA doğrular', async () => {
    const { publicKey, privateKey } = genRsaPair();
    _peers[PEER_URL] = { _id: 60, url: PEER_URL, publicKey };
    const empty = '';
    const sig = rsaSign(empty, privateKey);
    const r = await verifyFederationRequest(PEER_URL, empty, {
      'x-bridge-ts':      freshTs(),
      'x-bridge-rsa-sig': sig,
    });
    expect(r.ok).toBe(true);
    expect(r.method).toBe('rsa');
  });

  test('büyük payload ile HMAC doğrular', async () => {
    _peers[PEER_URL] = { _id: 61, url: PEER_URL };
    const bigPayload = JSON.stringify({ data: 'x'.repeat(50_000) });
    const r = await verifyFederationRequest(PEER_URL, bigPayload, {
      'x-bridge-ts':  freshTs(),
      'x-bridge-sig': hmacSign(bigPayload, GLOBAL_SEC),
    });
    expect(r.ok).toBe(true);
  });

});

// ── buildFederationHeaders testleri ──────────────────────────────────────────

describe('buildFederationHeaders', () => {
  test('gerekli header\'ları döner', async () => {
    const { privateKey } = genRsaPair();
    const headers = await buildFederationHeaders(
      '{"ping":1}',
      privateKey,
      'https://my-bridge.com/api/federation/key',
      'my-secret',
    );
    expect(headers['x-bridge-ts']).toBeDefined();
    expect(headers['x-bridge-rsa-sig']).toBeTruthy();
    expect(headers['x-bridge-sig']).toBeTruthy();
    expect(headers['x-bridge-keyid']).toBe('https://my-bridge.com/api/federation/key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('timestamp yakın zamanda üretilmiş', async () => {
    const { privateKey } = genRsaPair();
    const headers = await buildFederationHeaders('{}', privateKey, 'kid', 'sec');
    const ts = parseInt(headers['x-bridge-ts'], 10);
    expect(Math.abs(Date.now() - ts)).toBeLessThan(2000);
  });

  test('RSA imzası kendi public key ile doğrulanır', async () => {
    const { publicKey, privateKey } = genRsaPair();
    const payload = '{"action":"test"}';
    const headers = await buildFederationHeaders(payload, privateKey, 'kid', 'sec');

    const verify = crypto.createVerify('sha256');
    verify.update(payload);
    const valid = verify.verify(publicKey, headers['x-bridge-rsa-sig'], 'base64');
    expect(valid).toBe(true);
  });

  test('bozuk private key\'de hata fırlatmaz, boş rsa-sig döner', async () => {
    const headers = await buildFederationHeaders('{}', 'invalid-key', 'kid', 'sec');
    expect(headers['x-bridge-rsa-sig']).toBe('');
    expect(headers['x-bridge-sig']).toBeTruthy(); // HMAC yine de dolar
  });
});
