// server/tests/httpSignatureV3.test.ts
// Sprint 113 — ADR-0006 Faz 3: RSA-only, HMAC fallback kaldırıldı
// Test framework: Jest 29 (ts-jest) — projeyle tutarlı

import crypto from 'crypto';

// ── Anahtar çifti (testler için) ─────────────────────────────────────────

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_PEER_URL = 'https://peer.bridge.test';
const TEST_PAYLOAD  = JSON.stringify({ event: 'test', data: 'merhaba' });

// ── Mock'lar ─────────────────────────────────────────────────────────────

const mockPeer = {
  _id:       'peer-1',
  url:       TEST_PEER_URL,
  publicKey: publicKey,
};

jest.mock('../db/loader', () => ({
  __esModule: true,
  default: {
    federationPeers: {
      findOne: jest.fn(async ({ url }: { url: string }) =>
        url === TEST_PEER_URL ? mockPeer : null,
      ),
    },
  },
}));

jest.mock('../db/repositories', () => ({
  Federation: {
    getPeerByUrl: jest.fn(async (url: string) =>
      url === TEST_PEER_URL ? mockPeer : null,
    ),
  },
}));

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Import (mock'lardan sonra) ─────────────────────────────────────────────

import { verifyFederationRequestV3, buildFederationHeadersV3 } from '../lib/httpSignatureV3';

// ── Yardımcı: geçerli header'lar üret ────────────────────────────────────

function validHeaders(payload = TEST_PAYLOAD) {
  return buildFederationHeadersV3(payload, privateKey, 'key-1');
}

// ── Testler ───────────────────────────────────────────────────────────────

describe('verifyFederationRequestV3 — başarılı RSA doğrulama', () => {
  it('geçerli RSA imzası kabul edilir', async () => {
    const headers = validHeaders();
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('rsa');
    expect(result.peerId).toBeDefined();
  });

  it('başarılı sonuçta reason undefined', async () => {
    const headers = validHeaders();
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.reason).toBeUndefined();
  });
});

describe('verifyFederationRequestV3 — timestamp kontrolü', () => {
  it('timestamp eksikse reddedilir', async () => {
    const headers = validHeaders();
    delete (headers as Record<string, string>)['x-bridge-ts'];
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Timestamp');
  });

  it('süresi geçmiş timestamp reddedilir', async () => {
    const headers = validHeaders();
    (headers as Record<string, string>)['x-bridge-ts'] = String(Date.now() - 10 * 60 * 1000); // 10 dk önce
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('geçersiz timestamp formatı reddedilir', async () => {
    const headers = validHeaders();
    (headers as Record<string, string>)['x-bridge-ts'] = 'gecersiz';
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
  });

  it('gelecekteki timestamp (5dk içinde) kabul edilir', async () => {
    const headers = validHeaders();
    (headers as Record<string, string>)['x-bridge-ts'] = String(Date.now() + 2 * 60 * 1000); // 2 dk sonra
    // imzayı yeniden üret
    const sign = crypto.createSign('sha256');
    sign.update(TEST_PAYLOAD);
    (headers as Record<string, string>)['x-bridge-rsa-sig'] = sign.sign(privateKey, 'base64');
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(true);
  });
});

describe('verifyFederationRequestV3 — bilinmeyen peer', () => {
  it('bilinmeyen peer URL reddedilir', async () => {
    const headers = validHeaders();
    const result = await verifyFederationRequestV3('https://unknown.peer', TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Unknown peer');
  });
});

describe('verifyFederationRequestV3 — RSA anahtar eksikliği (HMAC yok)', () => {
  it('peer publicKey yoksa HMAC header olsa bile reddedilir', async () => {
    // publicKey'siz peer mock'u
    const noPubKeyPeer = { _id: 'p2', url: TEST_PEER_URL, publicKey: null };
    const db = require('../db/loader').default;
    (db.federationPeers.findOne as jest.Mock).mockResolvedValueOnce(
      noPubKeyPeer as unknown as typeof mockPeer,
    );

    const headers = validHeaders();
    // HMAC header ekle — kabul edilmemeli
    (headers as Record<string, string>)['x-bridge-sig'] = 'fake-hmac-signature';

    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('RSA public key not registered');
  });

  it('HMAC-only header (rsa-sig yok, ts geçerli) reddedilir', async () => {
    const headers: Record<string, string> = {
      'x-bridge-ts':  String(Date.now()),
      'x-bridge-sig': 'fake-hmac', // eski Faz 2 header'ı
      // 'x-bridge-rsa-sig' kasıtlı yok
    };
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('RSA signature header missing');
  });
});

describe('verifyFederationRequestV3 — geçersiz RSA imzası', () => {
  it('bozuk imza reddedilir', async () => {
    const headers = validHeaders();
    (headers as Record<string, string>)['x-bridge-rsa-sig'] = 'bozuk-imza==';
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('invalid');
  });

  it('farklı payload ile imzalanmış header reddedilir', async () => {
    const headers = validHeaders('{"baska":"payload"}');
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
  });

  it('farklı özel anahtar ile imzalanmış header reddedilir', async () => {
    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const headers = buildFederationHeadersV3(TEST_PAYLOAD, otherKey, 'key-2');
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('invalid');
  });
});

describe('buildFederationHeadersV3 — header üretimi', () => {
  it('gerekli headerlar üretilir', () => {
    const headers = buildFederationHeadersV3(TEST_PAYLOAD, privateKey, 'key-1');
    expect(headers['x-bridge-ts']).toBeDefined();
    expect(headers['x-bridge-rsa-sig']).toBeDefined();
    expect(headers['x-bridge-keyid']).toBe('key-1');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('HMAC header (x-bridge-sig) üretilmez', () => {
    const headers = buildFederationHeadersV3(TEST_PAYLOAD, privateKey, 'key-1');
    expect((headers as Record<string, string>)['x-bridge-sig']).toBeUndefined();
  });

  it('timestamp sayısal string', () => {
    const headers = buildFederationHeadersV3(TEST_PAYLOAD, privateKey, 'key-1');
    const ts = parseInt(headers['x-bridge-ts'], 10);
    expect(isNaN(ts)).toBe(false);
    expect(Math.abs(Date.now() - ts)).toBeLessThan(3000);
  });

  it('geçersiz özel anahtar hata fırlatır', () => {
    expect(() =>
      buildFederationHeadersV3(TEST_PAYLOAD, 'gecersiz-pem', 'key-1'),
    ).toThrow();
  });

  it('üretilen header kendisi tarafından doğrulanabilir (round-trip)', async () => {
    const headers = buildFederationHeadersV3(TEST_PAYLOAD, privateKey, 'key-1');
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.ok).toBe(true);
  });
});

describe('federationAuth middleware — ADR-0006 Faz 3 uyumluluk', () => {
  it('HMAC başlığı geçen isteğe rsa method döner (HMAC yok sayılır)', async () => {
    const headers = validHeaders();
    (headers as Record<string, string>)['x-bridge-sig'] = 'hmac-token-eskiden-calisiyordu';
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    // RSA geçerliyse ok=true, ama HMAC yok sayılır
    expect(result.ok).toBe(true);
    expect(result.method).toBe('rsa');
  });

  it('method her zaman rsa döner (hiçbir zaman hmac değil)', async () => {
    const headers = validHeaders();
    const result = await verifyFederationRequestV3(TEST_PEER_URL, TEST_PAYLOAD, headers);
    expect(result.method).toBe('rsa');
    expect((result as Record<string, unknown>).method).not.toBe('hmac');
  });
});
