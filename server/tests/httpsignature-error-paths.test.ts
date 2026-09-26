// server/tests/httpsignature-error-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/httpSignature.ts — RET, SSRF VE REPLAY DALLARI
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR: `lib/httpSignature.ts` federasyonun kimlik doğrulama
// sınırıdır — uzak bir sunucunun gönderdiği isteğin GERÇEKTEN o sunucudan
// geldiğini kanıtlar. Dal kapsamı %57.9 idi (61 kapsanmayan dal) ve
// kapsanmayanların neredeyse tamamı RET yollarıydı: SSRF engelleri, protokol
// kısıtı, zaman penceresi, replay talebi, bozuk başlıklar.
//
// Bir imza doğrulayıcıda kapsanmayan bir RET dalı, sessizce KABUL EDEN bir dal
// olabilir. Mevcut süitler mutlu yolu ve birkaç reddi ölçüyordu; bu dosya kalan
// reddleri açıkça ölçer.
//
// KRİPTOGRAFİ SAHTE DEĞİLDİR: gerçek RSA-2048 anahtar çiftleri üretilir ve
// imzalar `crypto` ile üretilip doğrulanır. Yalnızca ağ (`fetchT`), paylaşımlı
// önbellek (`cache`) ve veritabanı sınırları taklit edilir.

process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';
process.env.PORT = '3001';
process.env.FEDERATION_SECRET = 'test-federation-secret-32-characters-long';

import crypto from 'crypto';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

const mockFindPeerByUrl = jest.fn();
jest.mock('../db/repositories', () => ({
  Federation: { findPeerByUrl: (...a: unknown[]) => mockFindPeerByUrl(...a) },
}));

const mockFetchT = jest.fn();
jest.mock('../lib/fetch', () => ({ fetchT: (...a: unknown[]) => mockFetchT(...a) }));

const mockCache = { get: jest.fn(), set: jest.fn(), setIfAbsentAuthoritative: jest.fn(), del: jest.fn() };
jest.mock('../lib/redisAdapter', () => ({ cache: mockCache, isRedisAvailable: () => false }));

// ── Gerçek RSA-2048 anahtar çiftleri ────────────────────────────────────────
function keypair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
const remote   = keypair();   // meşru uzak sunucu
const attacker = keypair();   // imzayı taklit etmeye çalışan taraf
const instance = keypair();   // bizim kendi federasyon anahtarımız

// Yalnızca DB'ye dokunan `getOrCreateFederationKeys` taklit edilir; imzalama,
// header biçimlendirme ve ayrıştırma GERÇEK üretim kodudur.
jest.mock('../lib/federationKeys', () => ({
  ...jest.requireActual('../lib/federationKeys'),
  getOrCreateFederationKeys: jest.fn(async () => ({
    publicKeyPem:  instance.publicKey,
    privateKeyPem: instance.privateKey,
    keyVersion: 1,
  })),
}));

import {
  verifyHttpSignature,
  verifyFederationRequest,
  buildFederationAuthHeaders,
  signFederationRequest,
  _resetSignatureReplayCache,
} from '../lib/httpSignature';

const FED_SECRET = 'test-federation-secret-32-characters-long';
const PATH = '/api/federation/inbox';
const REMOTE_KEY = 'https://remote.test/users/ayse#main-key';

type Req = Parameters<typeof verifyHttpSignature>[0];

function makeReq(headers: Record<string, unknown>, body: unknown = {}): Req {
  return { headers, method: 'POST', url: PATH, body } as unknown as Req;
}

/** Gerçek RSA ile imzalanmış, Mastodon uyumlu bir Signature başlığı üretir. */
function signHttp(opts: {
  keyId: string;
  body?: unknown;
  date?: string;
  privateKeyPem?: string;
  algorithm?: string;
}): Record<string, string> {
  const body = opts.body ?? {};
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const digest = 'SHA-256=' + crypto.createHash('sha256').update(bodyStr).digest('base64');
  const date = opts.date ?? new Date().toUTCString();
  const signingString =
    `(request-target): post ${PATH}\nhost: bridge.test\ndate: ${date}\ndigest: ${digest}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString);
  const signature = signer.sign(opts.privateKeyPem ?? remote.privateKey, 'base64');
  const alg = opts.algorithm ?? 'rsa-sha256';
  return {
    host: 'bridge.test',
    date,
    digest,
    signature:
      `keyId="${opts.keyId}",algorithm="${alg}",` +
      `headers="(request-target) host date digest",signature="${signature}"`,
  };
}

/** Uzak anahtar belgesini döndüren bir fetch yanıtı. */
function keyDocResponse(pem: string | null, wrapped = true) {
  const doc = pem === null
    ? { id: 'x' }
    : wrapped ? { publicKey: { publicKeyPem: pem } } : { publicKeyPem: pem };
  return { ok: true, status: 200, url: 'https://remote.test/key', json: async () => doc };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCache.setIfAbsentAuthoritative.mockResolvedValue(true);   // varsayılan: replay talebi kazanılır
  mockCache.get.mockResolvedValue(null);
  mockFindPeerByUrl.mockResolvedValue(null);
  mockDb._reset();
  _resetSignatureReplayCache();                     // anahtar + replay önbelleğini temizle
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyHttpSignature — başlık ve yük doğrulama', () => {
  it('YANLIŞ POZİTİF KONTROLÜ: geçerli imza kabul edilir', async () => {
    // Bu test olmadan aşağıdaki tüm ret testleri, doğrulayıcı her şeyi
    // reddetse bile geçerdi ve hiçbir şey kanıtlamazlardı.
    mockFetchT.mockResolvedValue(keyDocResponse(remote.publicKey));
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(true);
    expect(r.keyId).toBe(REMOTE_KEY);
    expect(r.signerActor).toBe('https://remote.test/users/ayse');
  });

  it('untrusted publicKey.owner cannot override the actor encoded by fragment keyId', async () => {
    mockFetchT.mockResolvedValue({
      ok: true, status: 200, url: REMOTE_KEY,
      json: async () => ({
        publicKey: {
          publicKeyPem: remote.publicKey,
          owner: 'https://victim.example/users/victim',
        },
      }),
    });
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(true);
    expect(r.signerActor).toBe('https://remote.test/users/ayse');
  });

  it('Signature başlığı YOKSA reddeder', async () => {
    const r = await verifyHttpSignature(makeReq({ host: 'bridge.test' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No Signature header/i);
  });

  it('keyId eksikse reddeder', async () => {
    const r = await verifyHttpSignature(makeReq({
      signature: 'algorithm="rsa-sha256",headers="(request-target)",signature="AA=="',
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Missing signature params/i);
  });

  it('İZİN VERİLMEYEN algoritma reddedilir (downgrade koruması)', async () => {
    // Saldırgan `algorithm="hmac-sha256"` ilan edip doğrulamayı zayıf bir
    // ilkele düşürebilseydi, açık anahtar doğrulaması atlanırdı.
    const r = await verifyHttpSignature(
      makeReq(signHttp({ keyId: REMOTE_KEY, algorithm: 'hmac-sha256' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Desteklenmeyen algoritma/i);
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('hs2019 takma adı KABUL edilir (RFC 9421 geçiş adı)', async () => {
    mockFetchT.mockResolvedValue(keyDocResponse(remote.publicKey));
    const r = await verifyHttpSignature(
      makeReq(signHttp({ keyId: REMOTE_KEY, algorithm: 'hs2019' })));
    expect(r.ok).toBe(true);
  });

  it('(request-target) İMZALANMAMIŞSA reddeder', async () => {
    // ── ÖNEMLİ ─────────────────────────────────────────────────────────────
    // (request-target) imzalı değilse, saldırgan `/inbox` için üretilmiş
    // geçerli bir imzayı başka bir endpoint üzerine replay edebilirdi.
    const h = signHttp({ keyId: REMOTE_KEY });
    h.signature = h.signature.replace('headers="(request-target) host date digest"',
                                      'headers="host date digest"');
    const r = await verifyHttpSignature(makeReq(h));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/request-target/);
  });

  it('Date başlığı YOKSA reddeder', async () => {
    const h = signHttp({ keyId: REMOTE_KEY });
    delete h.date;
    const r = await verifyHttpSignature(makeReq(h));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Date header required/i);
  });

  it('ÇOK ESKİ Date reddeder (±5 dk penceresi)', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY, date: old })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too old/i);
  });

  it('GELECEKTEKİ Date reddeder (saat kayması istismarı)', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toUTCString();
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY, date: future })));
    expect(r.ok).toBe(false);
  });

  it('AYRIŞTIRILAMAYAN Date reddeder', async () => {
    const r = await verifyHttpSignature(
      makeReq(signHttp({ keyId: REMOTE_KEY, date: 'bir ara' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid/i);
  });

  it('Digest başlığı YOKSA reddeder', async () => {
    const h = signHttp({ keyId: REMOTE_KEY });
    delete h.digest;
    const r = await verifyHttpSignature(makeReq(h));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Digest header required/i);
  });

  it('GÖVDE DEĞİŞTİRİLMİŞSE reddeder (digest uyuşmazlığı)', async () => {
    const h = signHttp({ keyId: REMOTE_KEY, body: { tip: 'Note' } });
    const r = await verifyHttpSignature(makeReq(h, { tip: 'Delete', hedef: 'herkes' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tampered/i);
  });

  it('BAŞKA bir anahtarla üretilmiş imza reddedilir', async () => {
    // Doğrulayıcı gerçekten kriptografik kontrol yapıyor mu?
    mockFetchT.mockResolvedValue(keyDocResponse(remote.publicKey));
    const h = signHttp({ keyId: REMOTE_KEY, privateKeyPem: attacker.privateKey });
    const r = await verifyHttpSignature(makeReq(h));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cryptographically invalid/i);
  });

  it('BOZUK Signature başlığı çökmez, reddeder', async () => {
    const r = await verifyHttpSignature(makeReq({
      host: 'bridge.test', date: new Date().toUTCString(), signature: 'bu-gecerli-degil',
    }));
    expect(r.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('_resolvePublicKey — SSRF ve protokol kısıtları', () => {
  it('HTTP (TLS’siz) uzak anahtar URL’si REDDEDİLİR', async () => {
    // Aksi hâlde ağdaki bir saldırgan anahtar belgesini değiştirip istediği
    // her imzayı doğrulatabilirdi.
    const r = await verifyHttpSignature(
      makeReq(signHttp({ keyId: 'http://remote.test/users/a#k' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HTTPS/i);
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it.each([
    ['localhost',           'https://localhost/users/a#k'],
    ['127.0.0.1 loopback',  'https://127.0.0.1/users/a#k'],
    ['10/8 özel ağ',        'https://10.0.0.5/users/a#k'],
    ['172.16/12 özel ağ',   'https://172.16.3.9/users/a#k'],
    ['192.168/16 özel ağ',  'https://192.168.1.7/users/a#k'],
    ['169.254 link-local',  'https://169.254.169.254/users/a#k'],
    ['GCP metadata',        'https://metadata.google.internal/users/a#k'],
    ['0.0.0.0/8',           'https://0.0.0.1/users/a#k'],
  ])('SSRF: %s hedefi engellenir', async (_label, keyId) => {
    // `169.254.169.254` bulut metadata uç noktasıdır; oraya giden bir fetch
    // örnek kimlik bilgilerini sızdırabilirdi.
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/engellendi/i);
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('AYRIŞTIRILAMAYAN keyId reddeder', async () => {
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: 'bu bir url degil' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parse hatası/i);
  });

  it('3xx YÖNLENDİRME reddedilir (engellenen hedefe atlama)', async () => {
    // redirect:'manual' + açık ret olmasaydı, izin verilen bir host 302 ile
    // 169.254.169.254'e yönlendirip SSRF kontrolünü atlatabilirdi.
    mockFetchT.mockResolvedValue({
      ok: false, status: 302,
      headers: { get: () => 'https://169.254.169.254/' },
      json: async () => ({}),
    });
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/yönlendirme reddedildi/i);
  });

  it('anahtar sunucusu 5xx dönerse reddeder', async () => {
    mockFetchT.mockResolvedValue({ ok: false, status: 500, url: REMOTE_KEY, json: async () => ({}) });
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Key fetch başarısız/i);
  });

  it('ağ hatası REDDE dönüşür, istisnaya değil', async () => {
    mockFetchT.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it('uzak belge PEM İÇERMİYORSA reddeder', async () => {
    mockFetchT.mockResolvedValue(keyDocResponse(null));
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Public key not found/i);
  });

  it('DÜZ `publicKeyPem` biçimi de kabul edilir (sarmalanmamış belge)', async () => {
    mockFetchT.mockResolvedValue(keyDocResponse(remote.publicKey, false));
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(true);
  });

  it('anahtar ÖNBELLEĞE alınır — ikinci istek yeniden fetch etmez', async () => {
    mockFetchT.mockResolvedValue(keyDocResponse(remote.publicKey));
    await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(mockFetchT).toHaveBeenCalledTimes(1);

    await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(mockFetchT).toHaveBeenCalledTimes(1);   // önbellekten geldi
  });

  it('YEREL kullanıcı anahtarı DB’den çözülür, ağa çıkılmaz', async () => {
    await mockDb.users.insert({ username: 'ayse', apPublicKey: remote.publicKey });

    const r = await verifyHttpSignature(
      makeReq(signHttp({ keyId: 'https://bridge.test/users/ayse#main-key' })));

    expect(r.ok).toBe(true);
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('YEREL kullanıcının anahtarı yoksa reddeder (uzağa düşmez)', async () => {
    // Yerel bir keyId için uzak fetch'e düşmek, saldırgana kendi sunucusundan
    // anahtar servis etme fırsatı verirdi.
    // koleksiyon bos birakilir -> kullanici bulunamaz
    const r = await verifyHttpSignature(
      makeReq(signHttp({ keyId: 'https://bridge.test/users/yok#k' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Public key not found/i);
    expect(mockFetchT).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyHttpSignature — replay koruması', () => {
  beforeEach(() => { mockFetchT.mockResolvedValue(keyDocResponse(remote.publicKey)); });

  it('AYNI imza İKİNCİ kez kullanılamaz', async () => {
    const h = signHttp({ keyId: REMOTE_KEY });

    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(true);    // ilk talep kazanılır
    expect((await verifyHttpSignature(makeReq(h))).ok).toBe(true);

    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(false);   // ikinci talep kaybedilir
    const second = await verifyHttpSignature(makeReq(h));
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/Replay attack/i);
  });

  it('replay TALEBİ, kriptografik doğrulama BAŞARISIZSA hiç alınmaz', async () => {
    // Geçersiz imzalar replay deposunu doldurabilseydi, saldırgan çöp
    // göndererek depoyu şişirebilirdi.
    const h = signHttp({ keyId: REMOTE_KEY, privateKeyPem: attacker.privateKey });
    await verifyHttpSignature(makeReq(h));
    expect(mockCache.setIfAbsentAuthoritative).not.toHaveBeenCalled();
  });

  it('replay deposu ERİŞİLEMEZSE FAIL-CLOSED reddeder', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // Depo belirsizken kabul etmek, Redis'i düşürebilen bir saldırgana
    // sınırsız replay hakkı verirdi. Bu dal daha önce hiç ölçülmemişti.
    mockCache.setIfAbsentAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    const r = await verifyHttpSignature(makeReq(signHttp({ keyId: REMOTE_KEY })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Replay attack/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyFederationRequest — HMAC yolu', () => {
  function hmacHeaders(body: unknown, ts = String(Date.now()), secret = FED_SECRET) {
    const sig = crypto.createHmac('sha256', secret).update(ts + JSON.stringify(body)).digest('hex');
    return { 'x-bridge-ts': ts, 'x-bridge-sig': sig };
  }

  it('YANLIŞ POZİTİF KONTROLÜ: geçerli HMAC kabul edilir', async () => {
    const body = { tip: 'Heartbeat' };
    expect(await verifyFederationRequest(makeReq(hmacHeaders(body), body))).toBe(true);
  });

  it('x-bridge-sig veya x-bridge-ts EKSİKSE reddeder', async () => {
    expect(await verifyFederationRequest(makeReq({ 'x-bridge-sig': 'a'.repeat(64) }))).toBe(false);
    expect(await verifyFederationRequest(makeReq({ 'x-bridge-ts': String(Date.now()) }))).toBe(false);
  });

  it('YANLIŞ sır ile üretilmiş HMAC reddedilir', async () => {
    const body = { tip: 'Heartbeat' };
    const h = hmacHeaders(body, String(Date.now()), 'yanlis-sir');
    expect(await verifyFederationRequest(makeReq(h, body))).toBe(false);
  });

  it('GÖVDE değiştirilirse HMAC tutmaz', async () => {
    const h = hmacHeaders({ tip: 'Heartbeat' });
    expect(await verifyFederationRequest(makeReq(h, { tip: 'DeleteEverything' }))).toBe(false);
  });

  it('zaman damgası PENCERE DIŞINDAYSA reddeder', async () => {
    const old = String(Date.now() - 60 * 60 * 1000);
    const body = { tip: 'Heartbeat' };
    expect(await verifyFederationRequest(makeReq(hmacHeaders(body, old), body))).toBe(false);
  });

  it('SAYISAL OLMAYAN zaman damgası reddedilir', async () => {
    // ── GERİLEME TESTİ — bu bir DEFEKTTİ ───────────────────────────────────
    // Eski kod `Math.abs(Date.now() - parseInt(ts, 10)) > 300000` idi.
    // `parseInt('2026-08-29T10:00:00Z', 10)` NaN döner ve `NaN > 300000`
    // DAİMA false'tur, yani pencere kontrolü sessizce atlanıyordu. Damgasını
    // ISO-8601 gönderen bir eş için imza süresiz geçerli kalırdı: replay
    // kaydı 5 dk TTL ile düştükten sonra istek sonsuza dek yeniden kabul
    // edilebilirdi.
    //
    // Aşağıdaki damga GEÇERLİ bir HMAC taşır — yalnızca tazelik kontrolü
    // onu reddedebilir. Düzeltme geri alınırsa bu test kırmızıya döner.
    const body = { tip: 'Heartbeat' };
    expect(await verifyFederationRequest(
      makeReq(hmacHeaders(body, '2026-08-29T10:00:00Z'), body))).toBe(false);
  });

  it('SONDA ÇÖP taşıyan zaman damgası reddedilir', async () => {
    // `parseInt('1756...abc')` sondaki çöpü sessizce yutardı; `Number()` yutmaz.
    const body = { tip: 'Heartbeat' };
    expect(await verifyFederationRequest(
      makeReq(hmacHeaders(body, `${Date.now()}abc`), body))).toBe(false);
  });

  it('AYNI HMAC iki kez kullanılamaz', async () => {
    const body = { tip: 'Heartbeat' };
    const h = hmacHeaders(body);

    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(true);
    expect(await verifyFederationRequest(makeReq(h, body))).toBe(true);

    mockCache.setIfAbsentAuthoritative.mockResolvedValueOnce(false);
    expect(await verifyFederationRequest(makeReq(h, body))).toBe(false);
  });

  it('replay deposu ERİŞİLEMEZSE HMAC yolu da FAIL-CLOSED', async () => {
    const body = { tip: 'Heartbeat' };
    mockCache.setIfAbsentAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    expect(await verifyFederationRequest(makeReq(hmacHeaders(body), body))).toBe(false);
  });

  it('ÜRETİMDE sır tanımlı değilse doğrulama reddeder', async () => {
    // Geliştirme varsayılanına düşmek, üretimde herkesin bildiği bir sırla
    // federasyon isteği imzalanabilmesi demekti.
    const body = { tip: 'Heartbeat' };
    const h = hmacHeaders(body);
    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.FEDERATION_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.FEDERATION_SECRET;
    try {
      expect(await verifyFederationRequest(makeReq(h, body))).toBe(false);
    } finally {
      process.env.NODE_ENV = prevEnv;
      process.env.FEDERATION_SECRET = prevSecret;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyFederationRequest — RSA yolu önceliklidir', () => {
  it('RSA başlığı VARSA ve geçersizse HMAC’e DÜŞMEZ', async () => {
    // ── ÖNEMLİ ─────────────────────────────────────────────────────────────
    // Düşseydi, çift imzalı bir istek reddedilen RSA'dan sonra ikinci bir
    // kabul yoluna sahip olurdu.
    const body = { tip: 'Heartbeat' };
    const ts = String(Date.now());
    const hmacSig = crypto.createHmac('sha256', FED_SECRET)
      .update(ts + JSON.stringify(body)).digest('hex');

    const r = await verifyFederationRequest(makeReq({
      'x-bridge-ts': ts,
      'x-bridge-sig': hmacSig,                          // GEÇERLİ HMAC
      'X-Bridge-Signature':
        'RSA-SHA256 keyId="https://bridge.test/api/federation/key",signature="Z2FyYmFnZQ=="',
    }, body));

    expect(r).toBe(false);
  });

  it('BOZUK RSA başlığı reddedilir', async () => {
    const r = await verifyFederationRequest(makeReq({
      'x-bridge-ts': String(Date.now()),
      'X-Bridge-Signature': 'RSA-SHA256 bozuk',
    }, {}));
    expect(r).toBe(false);
  });

  it('eş (peer) anahtarı bulunamazsa reddeder', async () => {
    mockFindPeerByUrl.mockResolvedValue(null);
    mockFetchT.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const r = await verifyFederationRequest(makeReq({
      'x-bridge-ts': String(Date.now()),
      'X-Bridge-Signature': 'RSA-SHA256 keyId="https://remote.test/key",signature="AAAA"',
    }, { url: 'https://remote.test' }));
    expect(r).toBe(false);
  });

  it('KAYITLI eşin anahtarı DB’den kullanılır (ağa çıkılmaz)', async () => {
    const body = { url: 'https://remote.test', tip: 'Heartbeat' };
    const ts = String(Date.now());
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(ts + JSON.stringify(body));
    const signature = signer.sign(remote.privateKey, 'base64');

    mockFindPeerByUrl.mockResolvedValue({ publicKey: remote.publicKey });

    const r = await verifyFederationRequest(makeReq({
      'x-bridge-ts': ts,
      'X-Bridge-Signature': `RSA-SHA256 keyId="https://remote.test/key",signature="${signature}"`,
    }, body));

    expect(r).toBe(true);
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('RSA yolunda da zaman damgası penceresi uygulanır', async () => {
    const r = await verifyFederationRequest(makeReq({
      'x-bridge-ts': String(Date.now() - 60 * 60 * 1000),
      'X-Bridge-Signature': 'RSA-SHA256 keyId="https://remote.test/key",signature="AAAA"',
    }, {}));
    expect(r).toBe(false);
    expect(mockFindPeerByUrl).not.toHaveBeenCalled();   // pencere önce kapandı
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('giden istek imzalama', () => {
  it('buildFederationAuthHeaders üç başlığı da üretir', async () => {
    const h = await buildFederationAuthHeaders({ a: 1 });
    expect(h['x-bridge-ts']).toMatch(/^\d+$/);
    expect(h['x-bridge-sig']).toMatch(/^[0-9a-f]{64}$/);
    expect(h['X-Bridge-Signature']).toMatch(/^RSA-SHA256 keyId="[^"]+",signature="[^"]+"$/);
  });

  it('GİDİŞ-DÖNÜŞ: ürettiğimiz başlıklar KENDİ doğrulayıcımızdan geçer', async () => {
    // İmzalama ve doğrulama aynı sözleşmeyi paylaşmalı; sessizce ayrışırlarsa
    // federasyon çalışmayı bırakır ama hiçbir test bunu görmez.
    const body = { tip: 'Heartbeat', mesaj: 'merhaba' };
    const headers = await buildFederationAuthHeaders(body);
    expect(await verifyFederationRequest(makeReq(headers, body))).toBe(true);
  });

  it('GİDİŞ-DÖNÜŞ imzası GÖVDE değişirse geçmez', async () => {
    const headers = await buildFederationAuthHeaders({ tip: 'Heartbeat' });
    expect(await verifyFederationRequest(makeReq(headers, { tip: 'Delete' }))).toBe(false);
  });

  it('ÜRETİMDE sır yoksa imzalama AÇIKÇA HATA verir (sessiz zayıflama yok)', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.FEDERATION_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.FEDERATION_SECRET;
    try {
      await expect(signFederationRequest({ a: 1 })).rejects.toThrow(/FEDERATION_SECRET/);
    } finally {
      process.env.NODE_ENV = prevEnv;
      process.env.FEDERATION_SECRET = prevSecret;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('_reqHeader — başlık normalleştirme', () => {
  it('BÜYÜK/küçük harf farkı gözetmez', async () => {
    // Node normalde küçük harfe indirir, ama proxy ve test istemcileri indirmez.
    const body = { tip: 'Heartbeat' };
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', FED_SECRET)
      .update(ts + JSON.stringify(body)).digest('hex');
    expect(await verifyFederationRequest(
      makeReq({ 'X-Bridge-TS': ts, 'X-Bridge-Sig': sig }, body))).toBe(true);
  });

  it('DİZİ değerli başlık çökmez', async () => {
    const r = await verifyHttpSignature(
      makeReq({ date: ['a', 'b'], signature: undefined }));
    expect(r.ok).toBe(false);
  });
});
