// server/tests/federation-keys-load-and-rotate.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/federationKeys — ORNEK ANAHTARININ YUKLENMESI VE DONDURULMESI
// ════════════════════════════════════════════════════════════════════════════
// Bu anahtar cifti, Bridge'in federasyonda KIM OLDUGUDUR. Uzak orneklerin
// gonderdigimiz her aktiviteyi dogrulamak icin kullandigi imza buradan cikar.
//
// Uc sozlesme olculur:
//
// 1. KANONIK KAYIT OTORITEDIR. `getOrCreateFederationKeys` her cagrida DB
//    satirini YENIDEN okur — surec-ici bir onbellege guvenmez. Baska bir
//    dugum anahtari dondurmus olabilir; eski anahtarla imzalamak, uzak
//    tarafta REDDEDILEN aktiviteler demektir.
//
// 2. YAZILMAMIS ANAHTARLA IMZALANMAZ. Ilk olusturma "ilk yazan kazanir"
//    kuralina tabidir: yarisi kaybeden dugum, kendi urettigi (ve KALICI
//    OLMAYAN) ozel anahtari onbellege ALMAZ; kalici satiri kullanir.
//
// 3. OKUNAMAYAN SATIR SESSIZ GECILMEZ. Cozulemeyen ya da bozuk surumlu bir
//    kayit `null` degil HATA uretir — bozuk bir kimlikle federasyona
//    devam etmek, sessizce imzasiz/gecersiz trafik demektir.
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const encryptApPrivateKey = jest.fn((pem: string) => `enc:${pem}`);
const decryptApPrivateKey = jest.fn((enc: string) =>
  (enc.startsWith('enc:') ? enc.slice(4) : null));
jest.mock('../lib/apKeyEncryption', () => ({
  encryptApPrivateKey: (...a: unknown[]) => encryptApPrivateKey(...(a as [string])),
  decryptApPrivateKey: (...a: unknown[]) => decryptApPrivateKey(...(a as [string])),
}));

import {
  getFederationKeyId, getFederationPublicKeyDoc, getOrCreateFederationKeys,
  formatBridgeSignatureHeader, parseBridgeSignatureHeader,
  signFederationPayload, _resetFederationKeyCache,
} from '../lib/federationKeys';

const db = require('../db/loader');

beforeEach(() => {
  db._reset?.();
  _resetFederationKeyCache();
  encryptApPrivateKey.mockClear();
  decryptApPrivateKey.mockClear();
  decryptApPrivateKey.mockImplementation((enc: string) =>
    (enc.startsWith('enc:') ? enc.slice(4) : null));
});

describe('the instance key pair is created once and then re-read', () => {
  it('generates and persists a key pair on first use', async () => {
    const keys = await getOrCreateFederationKeys();

    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(keys.keyVersion).toBe(1);

    const row = await db.serverFederationKeys.findOne({}) as Record<string, unknown>;
    // Ozel anahtar DUZ saklanmaz.
    expect(String(row.privateKeyEnc)).toMatch(/^enc:/);
    expect(row).not.toHaveProperty('privateKeyPem');
  });

  it('re-reads the canonical row instead of trusting a process cache', async () => {
    const first = await getOrCreateFederationKeys();

    // Baska bir dugum anahtari dondurdu: satir degisti.
    await db.serverFederationKeys.update({ _id: 'instance' }, { $set: { keyVersion: 9 } });

    const second = await getOrCreateFederationKeys();
    // Eski surumle imzalamak, uzak tarafta REDDEDILEN aktiviteler uretirdi.
    expect(second.keyVersion).toBe(9);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  it('does not regenerate a second pair on a later call', async () => {
    const first = await getOrCreateFederationKeys();
    const second = await getOrCreateFederationKeys();
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
    expect(await db.serverFederationKeys.count({})).toBe(1);
  });
});

describe('an unusable persisted row is an error, never a silent skip', () => {
  it('refuses a row whose private key cannot be decrypted', async () => {
    await getOrCreateFederationKeys();
    decryptApPrivateKey.mockReturnValue(null);

    // Cozulemeyen anahtar => satir YOK sayilir ve yeni bir cift yazilmaya
    // calisilir; ama yazma da ayni sekilde okunamaz oldugu icin ACIK hata.
    await expect(getOrCreateFederationKeys())
      .rejects.toThrow(/Persisted federation key row is unreadable/);
  });

  it('refuses a row carrying an impossible key version', async () => {
    await getOrCreateFederationKeys();
    await db.serverFederationKeys.update({ _id: 'instance' }, { $set: { keyVersion: -3 } });
    await expect(getOrCreateFederationKeys()).rejects.toThrow();
  });

  it('treats a row missing its public half as absent and recreates it', async () => {
    await getOrCreateFederationKeys();
    await db.serverFederationKeys.update({ _id: 'instance' }, { $set: { publicKeyPem: '' } });

    const keys = await getOrCreateFederationKeys();
    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });
});

describe('the published key document mirrors the loaded pair', () => {
  it('reports nothing before any key has been loaded', () => {
    _resetFederationKeyCache();
    expect(getFederationPublicKeyDoc()).toBeNull();
  });

  it('publishes the id, owner and public half only', async () => {
    const keys = await getOrCreateFederationKeys();
    const doc = getFederationPublicKeyDoc(keys) as Record<string, unknown>;

    expect(doc.id).toBe(getFederationKeyId());
    expect(doc.publicKeyPem).toBe(keys.publicKeyPem);
    // Ozel anahtar HICBIR kosulda yayimlanmaz.
    expect(JSON.stringify(doc)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('uses the cached pair when none is supplied', async () => {
    const keys = await getOrCreateFederationKeys();
    const doc = getFederationPublicKeyDoc() as Record<string, unknown>;
    expect(doc.publicKeyPem).toBe(keys.publicKeyPem);
  });
});

describe('signature headers round-trip exactly', () => {
  it('formats and parses a header', () => {
    const header = formatBridgeSignatureHeader('https://bridge.test/api/federation/key', 'AbC+/=');
    expect(parseBridgeSignatureHeader(header)).toEqual({
      keyId: 'https://bridge.test/api/federation/key', signature: 'AbC+/=',
    });
  });

  it.each([
    ['an empty header', ''],
    ['a header with no keyId', 'RSA-SHA256 signature="abc"'],
    ['a header with no signature', 'RSA-SHA256 keyId="abc"'],
    ['unrelated text', 'Bearer abc'],
  ])('refuses %s', (_label, header) => {
    expect(parseBridgeSignatureHeader(header)).toBeNull();
  });

  it('produces a verifiable signature over the timestamp and body', async () => {
    const keys = await getOrCreateFederationKeys();
    const crypto = require('crypto');
    const ts = '1700000000';
    const body = { type: 'Follow', actor: 'https://a.test/u/x' };

    const signature = signFederationPayload(keys.privateKeyPem, ts, body);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(ts + JSON.stringify(body));
    expect(verifier.verify(keys.publicKeyPem, signature, 'base64')).toBe(true);

    // Govde degisirse imza TUTMAZ.
    const tampered = crypto.createVerify('RSA-SHA256');
    tampered.update(ts + JSON.stringify({ ...body, actor: 'https://saldirgan.test/u/x' }));
    expect(tampered.verify(keys.publicKeyPem, signature, 'base64')).toBe(false);
  });
});
