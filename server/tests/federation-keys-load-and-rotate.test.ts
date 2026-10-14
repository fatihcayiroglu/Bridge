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
  signFederationPayload, rotateFederationKeys, _resetFederationKeyCache,
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


describe('PostgreSQL federation RSA key rotation — transaction and COMMIT acknowledgement safety', () => {
  let previousPool: unknown;

  beforeEach(() => { previousPool = db._pool; });
  afterEach(() => {
    if (previousPool === undefined) delete db._pool;
    else db._pool = previousPool;
    _resetFederationKeyCache();
  });

  function installClient(
    handler: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  ) {
    const client = {
      query: jest.fn((sql: string) => handler(sql)),
      release: jest.fn((_error?: Error) => undefined),
    };
    db._pool = { connect: jest.fn(async () => client) };
    return client;
  }

  it('updates an existing key only within the advisory-locked transaction and releases a clean session', async () => {
    const client = installClient(async sql =>
      sql.includes('SELECT "keyVersion"') ? { rows: [{ keyVersion: '5' }] } : { rows: [] });
    const result = await rotateFederationKeys();
    expect(result.keyVersion).toBe(6);
    expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    const commands = client.query.mock.calls.map(([sql]) => sql);
    expect(commands[0]).toBe('BEGIN');
    expect(commands[1]).toContain('pg_advisory_xact_lock');
    expect(commands[2]).toContain('FOR UPDATE');
    expect(commands[3]).toContain('UPDATE server_federation_keys');
    expect(commands[4]).toBe('COMMIT');
    expect(commands).not.toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('inserts the key in the same transaction when no row exists', async () => {
    const client = installClient(async () => ({ rows: [] }));
    const result = await rotateFederationKeys();
    expect(result.keyVersion).toBe(1);
    expect(client.query.mock.calls.map(([sql]) => sql))
      .toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO server_federation_keys'), 'COMMIT']));
    expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('does NOT send ROLLBACK after an unacknowledged COMMIT; rejects and discards the physical client', async () => {
    const lostAck = new Error('socket closed after COMMIT was sent');
    const client = installClient(async sql => {
      if (sql.includes('SELECT "keyVersion"')) return { rows: [{ keyVersion: 7 }] };
      if (sql === 'COMMIT') throw lostAck;
      return { rows: [] };
    });
    await expect(rotateFederationKeys()).rejects.toBe(lostAck);
    const commands = client.query.mock.calls.map(([sql]) => sql);
    expect(commands).toContain('COMMIT');
    expect(commands).not.toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    // No uncommitted signer is exposed or announced as a successful rotation.
    expect(getFederationPublicKeyDoc()).toBeNull();
  });

  it('discards a PostgreSQL session when BEGIN acknowledgement is missing', async () => {
    const unknownBegin = new Error('connection disappeared after BEGIN');
    const client = installClient(async sql => {
      if (sql === 'BEGIN') throw unknownBegin;
      return { rows: [] };
    });
    await expect(rotateFederationKeys()).rejects.toBe(unknownBegin);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN']);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(getFederationPublicKeyDoc()).toBeNull();
  });

  it('rolls back a failure before COMMIT and returns a normally reusable client', async () => {
    const writeFailed = new Error('unique constraint or disk write failed');
    const client = installClient(async sql => {
      if (sql.includes('SELECT "keyVersion"')) return { rows: [{ keyVersion: 7 }] };
      if (sql.includes('UPDATE server_federation_keys')) throw writeFailed;
      return { rows: [] };
    });
    await expect(rotateFederationKeys()).rejects.toBe(writeFailed);
    const commands = client.query.mock.calls.map(([sql]) => sql);
    expect(commands.at(-1)).toBe('ROLLBACK');
    expect(commands).not.toContain('COMMIT');
    expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('discards the client if a pre-COMMIT ROLLBACK also fails, preserving the original write error', async () => {
    const writeFailed = new Error('pre-commit write failure');
    const client = installClient(async sql => {
      if (sql.includes('SELECT "keyVersion"')) return { rows: [{ keyVersion: 3 }] };
      if (sql.includes('UPDATE server_federation_keys')) throw writeFailed;
      if (sql === 'ROLLBACK') throw new Error('session unusable');
      return { rows: [] };
    });
    await expect(rotateFederationKeys()).rejects.toBe(writeFailed);
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(getFederationPublicKeyDoc()).toBeNull();
  });
});


describe('single-process fallback federation key rotation without a PostgreSQL pool', () => {
  let originalPool: unknown;

  beforeEach(() => {
    originalPool = db._pool;
    delete db._pool;
  });
  afterEach(() => {
    if (originalPool === undefined) delete db._pool;
    else db._pool = originalPool;
    _resetFederationKeyCache();
  });

  it('initializes a missing canonical key once, with its private half encrypted at rest', async () => {
    const rotated = await rotateFederationKeys();
    expect(rotated.keyVersion).toBe(1);
    expect(rotated.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(await db.serverFederationKeys.count({})).toBe(1);
    const row = await db.serverFederationKeys.findOne({ _id: 'instance' });
    expect(row).toMatchObject({
      publicKeyPem: rotated.publicKeyPem,
      privateKeyEnc: expect.stringMatching(/^enc:-----BEGIN PRIVATE KEY-----/),
      keyVersion: 1,
    });
    expect(row).not.toHaveProperty('privateKeyPem');
    expect(getFederationPublicKeyDoc()).toMatchObject({
      publicKeyPem: rotated.publicKeyPem,
    });
    expect(JSON.stringify(getFederationPublicKeyDoc())).not.toContain('BEGIN PRIVATE KEY');
  });

  it('serializes concurrent fallback rotations and preserves strictly increasing canonical versions', async () => {
    const results = await Promise.all([
      rotateFederationKeys(),
      rotateFederationKeys(),
      rotateFederationKeys(),
    ]);
    expect(results.map(x => x.keyVersion)).toEqual([1, 2, 3]);
    expect(new Set(results.map(x => x.publicKeyPem)).size).toBe(3);
    const row = await db.serverFederationKeys.findOne({ _id: 'instance' });
    expect(await db.serverFederationKeys.count({})).toBe(1);
    expect(row?.keyVersion).toBe(3);
    expect(row?.publicKeyPem).toBe(results[2].publicKeyPem);
    expect(getFederationPublicKeyDoc()?.publicKeyPem).toBe(results[2].publicKeyPem);
  });

  it('preserves the previous signer on a failed update, then permits a safe retry', async () => {
    const initial = await getOrCreateFederationKeys();
    const storedBefore = await db.serverFederationKeys.findOne({ _id: 'instance' });
    const failedWrite = new Error('federation key storage temporarily unavailable');
    const update = jest.spyOn(db.serverFederationKeys, 'update').mockRejectedValueOnce(failedWrite);
    try {
      await expect(rotateFederationKeys()).rejects.toBe(failedWrite);
      expect(await db.serverFederationKeys.findOne({ _id: 'instance' }))
        .toEqual(storedBefore);
      expect(getFederationPublicKeyDoc()?.publicKeyPem).toBe(initial.publicKeyPem);
    } finally {
      update.mockRestore();
    }
    const retried = await rotateFederationKeys();
    expect(retried.keyVersion).toBe(initial.keyVersion + 1);
    expect(retried.publicKeyPem).not.toBe(initial.publicKeyPem);
    expect((await db.serverFederationKeys.findOne({ _id: 'instance' }))?.publicKeyPem)
      .toBe(retried.publicKeyPem);
  });

  it('releases the fallback serialization lock after a failed rotation', async () => {
    const initial = await getOrCreateFederationKeys();
    const update = jest.spyOn(db.serverFederationKeys, 'update')
      .mockRejectedValueOnce(new Error('injected storage error'));
    try {
      const [failed, recovered] = await Promise.allSettled([
        rotateFederationKeys(),
        rotateFederationKeys(),
      ]);
      expect(failed.status).toBe('rejected');
      if (failed.status === 'rejected') {
        expect(failed.reason).toBeInstanceOf(Error);
        expect(String(failed.reason)).toContain('injected storage error');
      }
      expect(recovered.status).toBe('fulfilled');
      if (recovered.status === 'fulfilled') {
        expect(recovered.value.keyVersion).toBe(initial.keyVersion + 1);
        expect((await db.serverFederationKeys.findOne({ _id: 'instance' }))?.publicKeyPem)
          .toBe(recovered.value.publicKeyPem);
      }
    } finally {
      update.mockRestore();
    }
  });
});
