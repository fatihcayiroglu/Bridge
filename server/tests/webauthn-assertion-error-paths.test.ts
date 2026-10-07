// server/tests/webauthn-assertion-error-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// routes/webauthn.ts — KAYIT VE GİRİŞ TÖRENLERİNİN RET DALLARI
// ════════════════════════════════════════════════════════════════════════════
// Passkey girişi PAROLASIZ BİR KİMLİK SINIRIDIR: `login/complete` başarılı
// dönerse çağırana oturum jetonu verilir. Dolayısıyla bu dosyadaki her ret
// dalı, atlanırsa KİMLİK DOĞRULAMA ATLAMASI anlamına gelir.
//
// `routes/webauthn.ts` dal kapsamı %65 idi (55 kapsanmayan dal) ve
// kapsanmayanların hemen hepsi ret yollarıydı: bozuk CBOR, eksik bayraklar,
// RP kimliği uyuşmazlığı, klonlanmış authenticator, imza doğrulama hatası.
//
// ── KRİPTOGRAFİ SAHTE DEĞİLDİR ──────────────────────────────────────────────
// Gerçek bir P-256 anahtar çifti üretilir; `authData || SHA256(clientDataJSON)`
// gerçekten imzalanır ve rota bunu gerçekten doğrular. Bu olmadan "imza
// doğrulaması çalışıyor" iddiası ölçülemezdi — yalnızca reddedilen girdilerle
// test etmek, HER ŞEYİ reddeden bir doğrulayıcıyla da yeşil kalırdı.

process.env.NODE_ENV = 'test';
process.env.WEBAUTHN_RP_ID  = 'bridge.test';
process.env.WEBAUTHN_ORIGIN = 'https://bridge.test';
// `lib/authCookies` ve `lib/mediaCookie` GERCEK kodlardir (mock DEGIL):
// basarili giris yolunun cerez sozlesmesi de olculsun.
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';

// ── SURE SINIRI: BU PAKET KRIPTO-BAGIMLIDIR, GECIKME OLCMEZ ────────────────
// Kayit/giris toreni gercek COSE ayristirma, PEM donusumu ve ECDSA/RSA imza
// dogrulamasi calistirir; tek bir 'it' bloku onlarca anahtar sekli dener.
// Bu is KASITLI olarak pahalidir — dogrulamanin maliyeti guvenligin kendisidir.
//
// Jest paketleri paralel kostugunda ayni CPU'yu paylasan bu isler varsayilan
// 10 sn'lik siniri asabiliyor (izole kosumda 68/68 gecer). Olculen sey
// BOZUK ANAHTARIN REDDEDILMESI'dir, gecikme DEGIL; sinir gercek ise gore
// yukseltilir, hicbir kripto adimi ATLANMAZ.
jest.setTimeout(60_000);
process.env.REFRESH_SECRET = 'test-refresh-secret-key-at-least-32-chars';

import { makeJwtUser } from './helpers/userDoubles';
import { setCookiesOf } from './helpers/httpDoubles';
import request from 'supertest';
import crypto from 'crypto';
import express from 'express';

const RP_ID  = 'bridge.test';
const ORIGIN = 'https://bridge.test';

// ── Sahte depolar ───────────────────────────────────────────────────────────
const users = new Map<string, Record<string, unknown>>();
const creds = new Map<string, Record<string, unknown>>();
const cacheStore = new Map<string, unknown>();

jest.mock('../db/loader', () => ({
  users: {
    findOne: jest.fn(async (q: Record<string, string>) => {
      if (q._id) return users.get(q._id) ?? null;
      if (q.username) for (const u of users.values()) if (u.username === q.username) return u;
      return null;
    }),
    update: jest.fn(async (q: { _id: string }, upd: { $set?: object }) => {
      const u = users.get(q._id); if (u && upd.$set) Object.assign(u, upd.$set);
    }),
    insert: jest.fn(async (d: Record<string, unknown>) => { users.set(d._id as string, d); return d; }),
  },
  webauthnCredentials: {
    findOne: jest.fn(async (q: Record<string, string>) => {
      for (const c of creds.values()) {
        if (q._id && c._id === q._id) return c;
        if (q.credentialId && c.credentialId === q.credentialId) return c;
      }
      return null;
    }),
    find:   jest.fn(async (q: Record<string, string>) =>
      [...creds.values()].filter(c => (q.userId ? c.userId === q.userId : true))),
    insert: jest.fn(async (d: Record<string, unknown>) => { creds.set(d._id as string, d); return d; }),
    update: jest.fn(async (q: { _id: string }, upd: { $set?: object }) => {
      const c = creds.get(q._id); if (c && upd.$set) Object.assign(c, upd.$set);
    }),
    remove: jest.fn(async (q: { _id: string }) => { creds.delete(q._id); }),
  },
}));

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(async (k: string) => cacheStore.get(k) ?? null),
    take: jest.fn(async (k: string) => { const v = cacheStore.get(k) ?? null; cacheStore.delete(k); return v; }),
    takeAuthoritative: jest.fn(async (k: string) => { const v = cacheStore.get(k) ?? null; cacheStore.delete(k); return v; }),
    set: jest.fn(async (k: string, v: unknown) => { cacheStore.set(k, v); }),
    setAuthoritative: jest.fn(async (k: string, v: unknown) => { cacheStore.set(k, v); }),
    del: jest.fn(async (k: string) => { cacheStore.delete(k); }),
    mget: jest.fn(async () => new Map()), mset: jest.fn(async () => {}),
  },
  sessionCache: { invalidateToken: jest.fn(), isRevoked: jest.fn(async () => false) },
  isRedisAvailable: () => false,
}));

// GERCEK auth modulu korunur; yalnizca oturum kimligi ve DB'ye yazan
// yenileme jetonu degistirilir. `makeToken` ve `makeMediaToken` GERCEKTIR:
// medya cerezinin gercekten `purpose:'media'` tasidigini olcebilmek icin
// (bkz. middleware/uploadAuthz.ts kapsam ayrimi).
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  authMiddleware: jest.fn((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = makeJwtUser('u-ayse', { username: 'ayse' });
    next();
  }),
  makeRefreshToken: jest.fn(async () => 'mock-refresh'),
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: {
    twoFactor: () => (_q: unknown, _s: unknown, n: () => void) => n(),
    webauthn: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  },
}));

jest.mock('../middleware/asyncHandler', () =>
  (fn: (...a: unknown[]) => Promise<unknown>) =>
    async (req: unknown, res: unknown, next: (e?: unknown) => void) => {
      try { await fn(req, res, next); } catch (err) { next(err); }
    });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webauthnModule = require('../routes/webauthn');
const router = webauthnModule.default ?? webauthnModule;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webauthn', router);
  app.use((err: Error & { status?: number }, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}
const app = buildApp();

// ── Kodlama yardımcıları ────────────────────────────────────────────────────
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

/** WebAuthn authenticatorData. `flags` bit0=UP, bit2=UV, bit6=AT. */
function authData(opts: {
  rpId?: string; flags?: number; signCount?: number; credentialId?: Buffer; coseKey?: Buffer;
} = {}): Buffer {
  const rpIdHash = crypto.createHash('sha256').update(opts.rpId ?? RP_ID).digest();
  const flags = Buffer.from([opts.flags ?? 0x05]);            // UP | UV
  const count = Buffer.alloc(4); count.writeUInt32BE(opts.signCount ?? 1);
  if (!opts.credentialId) return Buffer.concat([rpIdHash, flags, count]);

  const aaguid = Buffer.alloc(16);
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(opts.credentialId.length);
  return Buffer.concat([rpIdHash, flags, count, aaguid, idLen, opts.credentialId,
    opts.coseKey ?? coseEs256(crypto.randomBytes(32), crypto.randomBytes(32))]);
}

/** COSE_Key CBOR: { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y } */
function coseEs256(x: Buffer, y: Buffer): Buffer {
  const uint = (n: number) => (n < 24 ? Buffer.from([n]) : Buffer.from([0x18, n]));
  const nint = (n: number) => { const v = n - 1; return v < 24 ? Buffer.from([0x20 | v]) : Buffer.from([0x38, v]); };
  const b32  = (b: Buffer) => Buffer.concat([Buffer.from([0x58, 32]), b]);
  return Buffer.concat([Buffer.from([0xa5]),
    uint(1), uint(2), uint(3), nint(7), nint(1), uint(1), nint(2), b32(x), nint(3), b32(y)]);
}

/** COSE_Key with an unsupported kty (OKP/Ed25519) — must be rejected. */
function coseUnsupported(): Buffer {
  const uint = (n: number) => Buffer.from([n]);
  const nint = (n: number) => Buffer.from([0x20 | (n - 1)]);
  return Buffer.concat([Buffer.from([0xa3]), uint(1), uint(1), uint(3), nint(8), nint(1), uint(6)]);
}

/** CBOR map { fmt: "none", attStmt: {}, authData: <bytes> }. */
function attestationObject(ad: Buffer): Buffer {
  const txt = (s: string) => Buffer.concat([Buffer.from([0x60 | s.length]), Buffer.from(s)]);
  const bytes = (b: Buffer) =>
    b.length < 24  ? Buffer.concat([Buffer.from([0x40 | b.length]), b]) :
    b.length < 256 ? Buffer.concat([Buffer.from([0x58, b.length]), b]) :
                     Buffer.concat([Buffer.from([0x59, b.length >> 8, b.length & 0xff]), b]);
  return Buffer.concat([Buffer.from([0xa3]),
    txt('fmt'), txt('none'), txt('attStmt'), Buffer.from([0xa0]), txt('authData'), bytes(ad)]);
}

function clientDataJSON(o: { type: string; challenge: string; origin?: string }): string {
  return b64u(Buffer.from(JSON.stringify({ type: o.type, challenge: o.challenge, origin: o.origin ?? ORIGIN })));
}

// ── Gerçek P-256 anahtar çifti ──────────────────────────────────────────────
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk = ec.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
const STORED_JWK = { kty: 'EC', crv: 'P-256', alg: 'ES256', x: ecJwk.x, y: ecJwk.y };

async function beginLogin(username?: string): Promise<string> {
  const r = await request(app).post('/api/webauthn/login/begin').send(username ? { username } : {});
  expect(r.status).toBe(200);
  return r.body.challenge as string;
}

/** Gerçek ES256 imzasıyla tam bir assertion üretir. */
function signedAssertion(opts: {
  challenge: string; credentialId: string; ad?: Buffer; origin?: string; privateKey?: crypto.KeyObject;
}) {
  const ad = opts.ad ?? authData({ signCount: 5 });
  const cd = clientDataJSON({ type: 'webauthn.get', challenge: opts.challenge, origin: opts.origin });
  const cdHash = crypto.createHash('sha256').update(Buffer.from(cd.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).digest();
  const signature = crypto.sign('sha256', Buffer.concat([ad, cdHash]), opts.privateKey ?? ec.privateKey);
  return {
    id: opts.credentialId,
    response: { clientDataJSON: cd, authenticatorData: b64u(ad), signature: b64u(signature) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  users.clear(); creds.clear(); cacheStore.clear();
  users.set('u-ayse', { _id: 'u-ayse', username: 'ayse', displayName: 'Ayşe', webauthnEnabled: true });
});

// ════════════════════════════════════════════════════════════════════════════
describe('register/complete — tören doğrulama', () => {
  async function beginRegister(): Promise<string> {
    const r = await request(app).post('/api/webauthn/register/begin').send({});
    expect(r.status).toBe(200);
    return r.body.challenge as string;
  }

  const post = (credential: unknown) =>
    request(app).post('/api/webauthn/register/complete').send({ credential });

  it('POZİTİF KONTROL: geçerli kayıt credential’ı saklar', async () => {
    const ch = await beginRegister();
    const credId = crypto.randomBytes(32);
    const r = await post({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(attestationObject(authData({ flags: 0x45, credentialId: credId }))),
      },
    });
    expect(r.status).toBe(200);
    expect(creds.size).toBe(1);
  });

  it('YANLIŞ tören tipi (webauthn.get) reddedilir', async () => {
    // Bir kayıt yanıtını giriş yanıtı gibi kullanmak tören karıştırma saldırısıdır.
    const ch = await beginRegister();
    const credId = crypto.randomBytes(32);
    const r = await post({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.get', challenge: ch }),
        attestationObject: b64u(attestationObject(authData({ flags: 0x45, credentialId: credId }))),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ceremony type/i);
  });

  it('YABANCI origin reddedilir', async () => {
    const ch = await beginRegister();
    const credId = crypto.randomBytes(32);
    const r = await post({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch, origin: 'https://kotu.example' }),
        attestationObject: b64u(attestationObject(authData({ flags: 0x45, credentialId: credId }))),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Origin mismatch/i);
  });

  it('BOZUK clientDataJSON reddedilir (çökmez)', async () => {
    await beginRegister();
    const r = await post({
      id: b64u(Buffer.from('x')),
      response: { clientDataJSON: b64u(Buffer.from('{bu json degil')), attestationObject: b64u(Buffer.from('x')) },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid clientDataJSON/i);
  });

  it('BOZUK attestationObject (CBOR) reddedilir', async () => {
    const ch = await beginRegister();
    const r = await post({
      id: b64u(Buffer.from('x')),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(Buffer.from([0xff, 0xff, 0xff])),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/attestation/i);
  });

  it('registration challenge is single-use even when the first completion is invalid later in the ceremony', async () => {
    const ch = await beginRegister();
    const credential = {
      id: b64u(Buffer.from('x')),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(Buffer.from([0xff, 0xff, 0xff])),
      },
    };
    const first = await post(credential);
    expect(first.status).toBe(400);
    expect(first.body.error).toMatch(/attestation/i);
    const replay = await post(credential);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/Challenge expired/i);
  });

  it('UP (kullanıcı mevcudiyeti) bayrağı YOKSA reddedilir', async () => {
    // UP olmadan kayıt, kullanıcı dokunmadan üretilmiş bir credential demektir.
    const ch = await beginRegister();
    const credId = crypto.randomBytes(32);
    const r = await post({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(attestationObject(authData({ flags: 0x44, credentialId: credId }))),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/User presence/i);
  });

  it('BAŞKA bir RP için üretilmiş authData reddedilir', async () => {
    // ── ÖNEMLİ ─────────────────────────────────────────────────────────────
    // rpIdHash denetlenmeseydi, saldırganın kendi sitesinde üretilmiş bir
    // credential Bridge'e kaydedilebilirdi.
    const ch = await beginRegister();
    const credId = crypto.randomBytes(32);
    const r = await post({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(attestationObject(
          authData({ rpId: 'kotu.example', flags: 0x45, credentialId: credId }))),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/RP ID hash/i);
  });

  it('AT bayrağı yoksa (credential verisi yok) reddedilir', async () => {
    const ch = await beginRegister();
    const r = await post({
      id: b64u(Buffer.from('x')),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(attestationObject(authData({ flags: 0x05 }))),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/No credential data/i);
  });

  it('AYNI credential İKİ KEZ kaydedilemez', async () => {
    const credId = crypto.randomBytes(32);
    const body = (ch: string) => ({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(attestationObject(authData({ flags: 0x45, credentialId: credId }))),
      },
    });
    expect((await post(body(await beginRegister()))).status).toBe(200);

    const second = await post(body(await beginRegister()));
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already registered/i);
  });

  it('DESTEKLENMEYEN anahtar tipi reddedilir', async () => {
    const ch = await beginRegister();
    const credId = crypto.randomBytes(32);
    const r = await post({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        attestationObject: b64u(attestationObject(
          authData({ flags: 0x45, credentialId: credId, coseKey: coseUnsupported() }))),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unsupported key type/i);
  });

  it('BAŞKA bir challenge ile tamamlanamaz', async () => {
    await beginRegister();
    const credId = crypto.randomBytes(32);
    const r = await post({
      id: b64u(credId),
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: b64u(crypto.randomBytes(32)) }),
        attestationObject: b64u(attestationObject(authData({ flags: 0x45, credentialId: credId }))),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Challenge mismatch/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('login/complete — parolasız kimlik sınırı', () => {
  const CRED_ID = b64u(Buffer.from('kayitli-credential-kimligi-32byt'));

  function storeCredential(over: Record<string, unknown> = {}) {
    creds.set('c1', {
      _id: 'c1', userId: 'u-ayse', credentialId: CRED_ID, credId: CRED_ID,
      publicKey: JSON.stringify(STORED_JWK), signCount: 1, ...over,
    });
  }

  const post = (credential: unknown) =>
    request(app).post('/api/webauthn/login/complete').send({ credential });

  it('POZİTİF KONTROL: GERÇEK ES256 imzası kabul edilir ve oturum verir', async () => {
    // Bu testin varlığı zorunludur: aşağıdaki tüm ret testleri, rota her
    // assertion'ı reddetse bile geçerdi.
    storeCredential();
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({ challenge: ch, credentialId: CRED_ID }));
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user.username).toBe('ayse');
    // P7 B2: a verified passkey assertion is a level-2 proof; one grant per scope.
    expect(r.body.stepUp).toEqual(expect.objectContaining({ level: 2, method: 'passkey', ttlMs: 600_000 }));
    expect(Object.keys(r.body.stepUp.grants).sort())
      .toEqual(['account-security', 'destructive-admin', 'moderation-burst', 'sensitive-export']);

    // Cerez sozlesmesi: yenileme cerezi httpOnly olmali, medya cerezi
    // `/uploads` ile SINIRLI olmali (bkz. middleware/uploadAuthz.ts).
    const cookies = setCookiesOf(r.headers);
    expect(cookies.join(';')).toMatch(/HttpOnly/i);
    expect(cookies.some(c => /bridge_media/.test(c) && /Path=\/uploads/i.test(c))).toBe(true);
  });

  it('username-bound ceremony cannot be completed with another account credential', async () => {
    users.set('u-baska', { _id: 'u-baska', username: 'baska', displayName: 'Başka' });
    creds.set('c-baska', {
      _id: 'c-baska', userId: 'u-baska', credentialId: CRED_ID, credId: CRED_ID,
      publicKey: JSON.stringify(STORED_JWK), signCount: 1,
    });
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({ challenge: ch, credentialId: CRED_ID }));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/requested account/i);
    expect(r.body.token).toBeUndefined();
  });

  it('login challenge is atomically single-use against assertion replay', async () => {
    storeCredential();
    const ch = await beginLogin('ayse');
    const assertion = signedAssertion({ challenge: ch, credentialId: CRED_ID });
    const first = await post(assertion);
    expect(first.status).toBe(200);
    const replay = await post(assertion);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/Challenge expired|not found/i);
  });

  it('BAŞKA anahtarla imzalanmış assertion REDDEDİLİR', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // Bu geçseydi, kayıtlı bir credential kimliğini bilen herkes o kullanıcı
    // olarak giriş yapabilirdi.
    storeCredential();
    const sahte = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({ challenge: ch, credentialId: CRED_ID, privateKey: sahte.privateKey }));
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
  });

  it('İMZA alanı YOKSA reddedilir', async () => {
    storeCredential();
    const ch = await beginLogin('ayse');
    const a = signedAssertion({ challenge: ch, credentialId: CRED_ID });
    delete (a.response as { signature?: string }).signature;
    const r = await post(a);
    expect(r.status).toBe(400);
  });

  it('eksik assertion yanıtı reddedilir', async () => {
    expect((await post({ id: 'x', response: {} })).status).toBe(400);
    expect((await post({ id: 'x' })).status).toBe(400);
  });

  it('YANLIŞ tören tipi (webauthn.create) reddedilir', async () => {
    storeCredential();
    const ch = await beginLogin('ayse');
    const ad = authData({ signCount: 5 });
    const r = await post({
      id: CRED_ID,
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.create', challenge: ch }),
        authenticatorData: b64u(ad), signature: b64u(Buffer.alloc(64)),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ceremony type/i);
  });

  it('YABANCI origin reddedilir', async () => {
    storeCredential();
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({ challenge: ch, credentialId: CRED_ID, origin: 'https://kotu.example' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Origin mismatch/i);
  });

  it('BİLİNMEYEN challenge reddedilir (oturum yok)', async () => {
    storeCredential();
    const r = await post(signedAssertion({ challenge: b64u(crypto.randomBytes(32)), credentialId: CRED_ID }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/expired or not found/i);
  });

  it('challenge TEK KULLANIMLIKTIR — aynı assertion iki kez geçmez', async () => {
    // Oturum `cache.del` ile tüketilir. Tüketilmeseydi, ağı dinleyen biri
    // aynı assertion'ı tekrar oynatarak giriş yapabilirdi.
    storeCredential();
    const ch = await beginLogin('ayse');
    const a = signedAssertion({ challenge: ch, credentialId: CRED_ID });
    expect((await post(a)).status).toBe(200);
    const second = await post(a);
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/expired or not found/i);
  });

  it('KAYITLI OLMAYAN credential 401 döner', async () => {
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({ challenge: ch, credentialId: b64u(crypto.randomBytes(32)) }));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/Credential not found/i);
  });

  it('credential var ama KULLANICI silinmişse 401', async () => {
    storeCredential({ userId: 'silinmis-kullanici' });
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({ challenge: ch, credentialId: CRED_ID }));
    expect(r.status).toBe(401);
  });

  it('UP bayrağı YOKSA reddedilir', async () => {
    storeCredential();
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({
      challenge: ch, credentialId: CRED_ID, ad: authData({ flags: 0x04, signCount: 5 }),
    }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/User presence/i);
  });

  it('BAŞKA RP için üretilmiş authData reddedilir', async () => {
    storeCredential();
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({
      challenge: ch, credentialId: CRED_ID, ad: authData({ rpId: 'kotu.example', signCount: 5 }),
    }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/RP ID mismatch/i);
  });

  it('KLONLANMIŞ authenticator (signCount gerilemesi) 401 döner', async () => {
    // signCount monoton artmalıdır. Eşit ya da küçük bir değer, anahtarın
    // kopyalandığının tek gözlemlenebilir işaretidir.
    storeCredential({ signCount: 100 });
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({
      challenge: ch, credentialId: CRED_ID, ad: authData({ signCount: 100 }),
    }));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/replay|cloned/i);
  });

  it('önceden non-zero sayaç üretmiş credential 0’a GERİ DÖNEMEZ', async () => {
    storeCredential({ signCount: 7 });
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({
      challenge: ch, credentialId: CRED_ID, ad: authData({ signCount: 0 }),
    }));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/replay|cloned/i);
  });

  it('signCount=0 authenticator’ları (sayaç tutmayanlar) engellenmez', async () => {
    // Birçok platform authenticator sayaç tutmaz ve daima 0 gönderir.
    // Bunları reddetmek meşru passkey'leri kırardı.
    storeCredential({ signCount: 0 });
    const ch = await beginLogin('ayse');
    const r = await post(signedAssertion({
      challenge: ch, credentialId: CRED_ID, ad: authData({ signCount: 0 }),
    }));
    expect(r.status).toBe(200);
  });

  it('BOZUK authenticatorData reddedilir', async () => {
    storeCredential();
    const ch = await beginLogin('ayse');
    const r = await post({
      id: CRED_ID,
      response: {
        clientDataJSON: clientDataJSON({ type: 'webauthn.get', challenge: ch }),
        authenticatorData: b64u(Buffer.from([1, 2, 3])),
        signature: b64u(Buffer.alloc(64)),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/authenticatorData/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('login/begin — kullanıcı numaralandırma', () => {
  it('OLMAYAN kullanıcı için de challenge döner (varlık sızdırılmaz)', async () => {
    // 404 dönseydi, uç nokta bir kullanıcı adı doğrulayıcısına dönüşürdü.
    const r = await request(app).post('/api/webauthn/login/begin').send({ username: 'hic-yok' });
    expect(r.status).toBe(200);
    expect(r.body.challenge).toBeTruthy();
    expect(r.body.allowCredentials).toEqual([]);
  });

  it('kullanıcı adı verilmezse discoverable akış için boş liste döner', async () => {
    const r = await request(app).post('/api/webauthn/login/begin').send({});
    expect(r.status).toBe(200);
    expect(r.body.allowCredentials).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Strict registration envelope / parser coverage
// ════════════════════════════════════════════════════════════════════════════

const cborText = (value: string): Buffer => {
  const bytes = Buffer.from(value);
  if (bytes.length < 24) return Buffer.concat([Buffer.from([0x60 | bytes.length]), bytes]);
  return Buffer.concat([Buffer.from([0x78, bytes.length]), bytes]);
};

const cborBytes = (value: Buffer): Buffer => {
  if (value.length < 24) return Buffer.concat([Buffer.from([0x40 | value.length]), value]);
  if (value.length < 256) return Buffer.concat([Buffer.from([0x58, value.length]), value]);
  return Buffer.concat([Buffer.from([0x59, value.length >> 8, value.length & 0xff]), value]);
};

type CborEntry = readonly [string, Buffer];
const cborMapPayload = (entries: readonly CborEntry[]): Buffer => Buffer.concat(
  entries.flatMap(([key, value]) => [cborText(key), value]),
);
const cborMap = (entries: readonly CborEntry[]): Buffer => Buffer.concat([
  Buffer.from([0xa0 | entries.length]),
  cborMapPayload(entries),
]);

async function beginRegistration(): Promise<string> {
  const result = await request(app).post('/api/webauthn/register/begin').send({});
  expect(result.status).toBe(200);
  return result.body.challenge as string;
}

function registrationBody(challenge: string, credId: Buffer, attestation: Buffer, extraClientData: Record<string, unknown> = {}) {
  return {
    credential: {
      id: b64u(credId),
      response: {
        clientDataJSON: b64u(Buffer.from(JSON.stringify({
          type: 'webauthn.create', challenge, origin: ORIGIN, ...extraClientData,
        }))),
        attestationObject: b64u(attestation),
      },
    },
  };
}

function strictAttestationEntries(ad: Buffer): CborEntry[] {
  return [
    ['fmt', cborText('none')],
    ['attStmt', Buffer.from([0xa0])],
    ['authData', cborBytes(ad)],
  ];
}

describe('register ceremony — strict envelope and CBOR handling', () => {
  it('returns 404 when the authenticated account disappears before either registration step', async () => {
    users.clear();
    expect((await request(app).post('/api/webauthn/register/begin').send({})).status).toBe(404);
    expect((await request(app).post('/api/webauthn/register/complete').send({})).status).toBe(404);
  });

  it('rejects blank/oversized names and malformed transport lists before consuming a challenge', async () => {
    const baseCredential = {
      id: b64u(Buffer.from('credential')),
      response: { clientDataJSON: 'AA', attestationObject: 'AA' },
    };
    for (const name of ['   ', 'x'.repeat(65)]) {
      const result = await request(app).post('/api/webauthn/register/complete').send({ credential: baseCredential, name });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/credential name/i);
    }
    for (const transports of [
      'usb', Array.from({ length: 17 }, () => 'usb'), [''], [7], ['x'.repeat(65)],
    ]) {
      const result = await request(app).post('/api/webauthn/register/complete').send({
        credential: { ...baseCredential, response: { ...baseCredential.response, transports } },
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/transports/i);
    }
  });

  it('uses safe registration fallbacks and rejects an outer credential-id mismatch', async () => {
    users.set('u-ayse', { _id: 'u-ayse', username: 'ayse' });
    creds.set('without-transports', {
      _id: 'without-transports', userId: 'u-ayse', credentialId: b64u(Buffer.from('existing')),
      publicKey: '{}', counter: 0,
    });
    const begin = await request(app).post('/api/webauthn/register/begin').send({});
    expect(begin.status).toBe(200);
    expect(begin.body.user.displayName).toBe('ayse');
    expect(begin.body.excludeCredentials[0].transports).toEqual([]);

    const credId = crypto.randomBytes(32);
    const differentOuterId = crypto.randomBytes(32);
    const body = registrationBody(
      begin.body.challenge,
      differentOuterId,
      attestationObject(authData({ flags: 0x45, credentialId: credId })),
    );
    const complete = await request(app).post('/api/webauthn/register/complete').send(body);
    expect(complete.status).toBe(400);
    expect(complete.body.error).toMatch(/does not match/i);

    // Gövde HİÇ yoksa `express.json()` `req.body`'yi ATAMAZ (undefined kalır).
    // Rotanın `(req.body ?? {})` geri düşüşü tam olarak bu durumu karşılar:
    // tören, çökmek yerine kimlik bilgisi reddiyle kapanmalıdır.
    const absentBody = await request(app).post('/api/webauthn/register/complete');
    expect(absentBody.status).toBe(400);
    expect(absentBody.body.error).toMatch(/credential response/i);

    // Gövde JSON olarak ayrıştırılabiliyor ama kimlik bilgisi taşımıyorsa da
    // aynı ret dalı çalışır — 500'e düşmez.
    const emptyObject = await request(app).post('/api/webauthn/register/complete').send({});
    expect(emptyObject.status).toBe(400);
    expect(emptyObject.body.error).toMatch(/credential response/i);

    // `null` gövdesi katı JSON ayrıştırıcısında REDDEDİLİR ve rotaya hiç
    // ulaşmaz. Burada anlamlı olan sözleşme, törenin fail-closed davranışıdır:
    // 4xx döner, asla 2xx değil.
    const nullBody = await request(app).post('/api/webauthn/register/complete')
      .set('Content-Type', 'application/json').send('null');
    expect(nullBody.status).toBe(400);
    expect(typeof nullBody.body.error).toBe('string');
  });

  it('rejects cross-origin registration ceremonies', async () => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const ad = authData({ flags: 0x45, credentialId: credId });
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, attestationObject(ad), { crossOrigin: true }));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/cross-origin/i);
  });

  it.each([
    ['one-byte map length', Buffer.from([0xb8])],
    ['two-byte map length', Buffer.from([0xb9, 0x00])],
    ['four-byte map length', Buffer.from([0xba, 0x00, 0x00, 0x00])],
    ['indefinite map', Buffer.from([0xbf])],
    ['truncated byte string', Buffer.from([0x42, 0x01])],
    ['truncated text string', Buffer.from([0x62, 0x61])],
    ['unsigned root', Buffer.from([0x00])],
    ['negative root', Buffer.from([0x20])],
    ['array root', Buffer.from([0x80])],
    ['unsupported tagged root', Buffer.from([0xc0])],
  ])('rejects malformed CBOR: %s', async (_label, encoded) => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, encoded));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/attestation/i);
  });

  it.each([
    ['uint8 map length', (payload: Buffer) => Buffer.concat([Buffer.from([0xb8, 0x03]), payload])],
    ['uint16 map length', (payload: Buffer) => Buffer.concat([Buffer.from([0xb9, 0x00, 0x03]), payload])],
    ['uint32 map length', (payload: Buffer) => Buffer.concat([Buffer.from([0xba, 0x00, 0x00, 0x00, 0x03]), payload])],
  ])('accepts a valid none attestation using %s', async (_label, wrap) => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const ad = authData({ flags: 0x45, credentialId: credId });
    const encoded = wrap(cborMapPayload(strictAttestationEntries(ad)));
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, encoded));
    expect(result.status).toBe(200);
  });

  it('rejects trailing CBOR data', async () => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const encoded = Buffer.concat([attestationObject(authData({ flags: 0x45, credentialId: credId })), Buffer.from([0])]);
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, encoded));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/trailing/i);
  });

  it.each([
    ['wrong format', (ad: Buffer) => cborMap([['fmt', cborText('packed')], ['attStmt', Buffer.from([0xa0])], ['authData', cborBytes(ad)]])],
    ['missing attStmt', (ad: Buffer) => cborMap([['fmt', cborText('none')], ['authData', cborBytes(ad)]])],
    ['string attStmt', (ad: Buffer) => cborMap([['fmt', cborText('none')], ['attStmt', cborText('bad')], ['authData', cborBytes(ad)]])],
    ['array attStmt', (ad: Buffer) => cborMap([['fmt', cborText('none')], ['attStmt', Buffer.from([0x80])], ['authData', cborBytes(ad)]])],
    ['non-empty attStmt', (ad: Buffer) => cborMap([['fmt', cborText('none')], ['attStmt', cborMap([['sig', cborBytes(Buffer.from('x'))]])], ['authData', cborBytes(ad)]])],
  ])('rejects non-none attestation structure: %s', async (_label, build) => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const encoded = build(authData({ flags: 0x45, credentialId: credId }));
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, encoded));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/none attestation/i);
  });

  it('rejects an attestation that omits authData after a valid none envelope', async () => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const encoded = cborMap([['fmt', cborText('none')], ['attStmt', Buffer.from([0xa0])]]);
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, encoded));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/Missing authData/i);
  });

  it('rejects duplicate map keys instead of accepting last-key-wins ambiguity', async () => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const ad = authData({ flags: 0x45, credentialId: credId });
    const encoded = cborMap([
      ['fmt', cborText('packed')], ['fmt', cborText('none')],
      ['attStmt', Buffer.from([0xa0])], ['authData', cborBytes(ad)],
    ]);
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, encoded));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/Duplicate CBOR map key fmt/i);
  });

  it('treats __proto__ as data rather than an inherited attestation envelope', async () => {
    const challenge = await beginRegistration();
    const credId = crypto.randomBytes(32);
    const inheritedEnvelope = cborMap(strictAttestationEntries(authData({ flags: 0x45, credentialId: credId })));
    const encoded = cborMap([['__proto__', inheritedEnvelope]]);
    const result = await request(app).post('/api/webauthn/register/complete')
      .send(registrationBody(challenge, credId, encoded));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/none attestation/i);
  });
});

describe('login ceremony — exhaustive failure and algorithm paths', () => {
  const CREDENTIAL_ID = b64u(Buffer.from('coverage-credential-identity'));

  function storeForLogin(publicKey: unknown, overrides: Record<string, unknown> = {}) {
    const stored = {
      _id: 'coverage-credential', userId: 'u-ayse', credentialId: CREDENTIAL_ID,
      publicKey: typeof publicKey === 'string' ? publicKey : JSON.stringify(publicKey),
      signCount: 1, ...overrides,
    };
    creds.set('coverage-credential', stored);
    return stored;
  }

  async function completeWithStoredKey(publicKey: unknown, opts: {
    privateKey?: crypto.KeyObject; overrides?: Record<string, unknown>; ad?: Buffer;
  } = {}) {
    storeForLogin(publicKey, opts.overrides);
    const challenge = await beginLogin('ayse');
    return request(app).post('/api/webauthn/login/complete').send({
      credential: signedAssertion({
        challenge, credentialId: CREDENTIAL_ID,
        ad: opts.ad ?? authData({ signCount: 5 }),
        privateKey: opts.privateKey,
      }),
    });
  }

  it('rejects malformed client JSON, cross-origin use, and invalid challenge encodings', async () => {
    const minimal = (clientData: string) => ({
      id: CREDENTIAL_ID,
      response: { clientDataJSON: clientData, authenticatorData: 'AA', signature: 'AA' },
    });
    expect((await request(app).post('/api/webauthn/login/complete').send({ credential: minimal('%') })).status).toBe(400);

    const crossOrigin = b64u(Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge: b64u(crypto.randomBytes(32)), origin: ORIGIN, crossOrigin: true,
    })));
    const cross = await request(app).post('/api/webauthn/login/complete').send({ credential: minimal(crossOrigin) });
    expect(cross.status).toBe(400);
    expect(cross.body.error).toMatch(/cross-origin/i);

    for (const challenge of [7, 'short']) {
      const encoded = b64u(Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN })));
      const result = await request(app).post('/api/webauthn/login/complete').send({ credential: minimal(encoded) });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/challenge encoding/i);
    }
  });

  it('rejects blank and oversized usernames without normalizing them into another account', async () => {
    for (const username of ['   ', 'x'.repeat(65)]) {
      const result = await request(app).post('/api/webauthn/login/begin').send({ username });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/username/i);
    }
  });

  it('rejects missing/malformed/expired/mismatched authoritative sessions', async () => {
    for (const session of [
      { expiresAt: undefined },
      { expiresAt: Date.now() - 1 },
      { expiresAt: Date.now() + 60_000, challenge: b64u(crypto.randomBytes(32)) },
    ]) {
      const challenge = b64u(crypto.randomBytes(32));
      cacheStore.set(`webauthn:auth:${challenge}`, { challenge, userId: null, ...session });
      const result = await request(app).post('/api/webauthn/login/complete').send({
        credential: signedAssertion({ challenge, credentialId: CREDENTIAL_ID }),
      });
      expect(result.status).toBe(400);
    }
  });

  it('rejects malformed persisted JSON and malformed signature encoding', async () => {
    let result = await completeWithStoredKey('{');
    expect(result.status).toBe(401);
    expect(result.body.error).toMatch(/Stored credential/i);

    storeForLogin(STORED_JWK);
    const challenge = await beginLogin('ayse');
    const assertion = signedAssertion({ challenge, credentialId: CREDENTIAL_ID });
    assertion.response.signature = '%';
    result = await request(app).post('/api/webauthn/login/complete').send({ credential: assertion });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/signature encoding/i);
  });

  it('rejects every malformed ES256 key shape and PEM conversion failures', async () => {
    const badKeys = [
      { alg: 'ES256', kty: 'RSA', crv: 'P-256', x: 'x', y: 'y' },
      { alg: 'ES256', kty: 'EC', crv: 'P-384', x: 'x', y: 'y' },
      { alg: 'ES256', kty: 'EC', crv: 'P-256', x: 7, y: 'y' },
      { alg: 'ES256', kty: 'EC', crv: 'P-256', x: 'x', y: 7 },
    ];
    for (const key of badKeys) {
      const result = await completeWithStoredKey(key);
      expect(result.status).toBe(401);
      expect(result.body.error).toMatch(/Stored credential/i);
    }
    const conversionFailure = await completeWithStoredKey({
      alg: 'ES256', kty: 'EC', crv: 'P-256', x: 'A', y: 'A',
    });
    expect(conversionFailure.status).toBe(401);
    expect(conversionFailure.body.error).toMatch(/Signature verification failed/i);
  });

  it('accepts a real RS256 assertion and rejects malformed RSA key shapes', async () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = rsa.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const valid = await completeWithStoredKey(
      { alg: 'RS256', kty: 'RSA', n: jwk.n, e: jwk.e },
      { privateKey: rsa.privateKey },
    );
    expect(valid.status).toBe(200);

    for (const key of [
      { alg: 'RS256', kty: 'EC', n: jwk.n, e: jwk.e },
      { alg: 'RS256', kty: 'RSA', n: 7, e: jwk.e },
      { alg: 'RS256', kty: 'RSA', n: jwk.n, e: 7 },
    ]) {
      const result = await completeWithStoredKey(key);
      expect(result.status).toBe(401);
      expect(result.body.error).toMatch(/Stored credential/i);
    }
  });

  it('rejects unsupported algorithms rather than treating an unverified key as valid', async () => {
    const result = await completeWithStoredKey({ alg: 'EdDSA', kty: 'OKP' });
    expect(result.status).toBe(401);
    expect(result.body.error).toMatch(/Invalid signature/i);
  });

  it('supports the canonical counter field and a counterless credential', async () => {
    let result = await completeWithStoredKey(STORED_JWK, { overrides: { signCount: undefined, counter: 1 } });
    expect(result.status).toBe(200);
    result = await completeWithStoredKey(STORED_JWK, {
      overrides: { signCount: undefined, counter: undefined }, ad: authData({ signCount: 0 }),
    });
    expect(result.status).toBe(200);
  });

  it('fails closed when credential identity is absent or the atomic counter advance loses a race', async () => {
    let result = await completeWithStoredKey(STORED_JWK, { overrides: { _id: undefined } });
    expect(result.status).toBe(401);
    expect(result.body.error).toMatch(/identity missing/i);

    const db = require('../db/loader');
    const stored = storeForLogin(STORED_JWK);
    const challenge = await beginLogin('ayse');
    db.webauthnCredentials.findOne
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null);
    result = await request(app).post('/api/webauthn/login/complete').send({
      credential: signedAssertion({ challenge, credentialId: CREDENTIAL_ID }),
    });
    expect(result.status).toBe(401);
    expect(result.body.error).toMatch(/concurrent|cloned/i);
  });
});

describe('credential management — vanished account branches', () => {
  it('fails every authenticated management operation after the account is deleted', async () => {
    users.clear();
    expect((await request(app).get('/api/webauthn/credentials')).status).toBe(404);
    expect((await request(app).patch('/api/webauthn/credentials/x').send({ name: 'Key' })).status).toBe(404);
    expect((await request(app).delete('/api/webauthn/credentials/x')).status).toBe(404);
  });
});
