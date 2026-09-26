// server/tests/http-signature-key-resolution-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// HTTP SIGNATURE — ANAHTAR ÇÖZÜMÜ, AKTÖR BAĞLAMA VE FEDERASYON İMZALARI
// ════════════════════════════════════════════════════════════════════════════
//
// Federasyon girişinin TEK kimlik kanıtı bu modüldür. Ölçülmemiş dalların
// taşıdığı riskler:
//
//   · SAHTE SAHİPLİK — uzak anahtar belgesi SALDIRGAN denetimindedir.
//     `publicKey.owner` tek başına GÜVENİLMEZ; aktör bağı yalnız FRAGMENT
//     biçimli keyId'den (`actor#main-key`) türetilir. Ayrık bir anahtar URL'i
//     bağsız kalır ve gelen kutusu tarafından reddedilir.
//   · SSRF — anahtar getirme yolu özel adres aralıklarına ve metadata
//     servislerine çıkamaz; üretimde düz HTTP de kabul edilmez.
//   · ÖNBELLEK — sahiplik PEM ile BİRLİKTE önbelleklenir; aksi hâlde sıcak
//     önbellekten dönen bir doğrulama aktör kanıtını KAYBEDERDİ.
//   · REPLAY — imza yalnız kriptografik doğrulamadan SONRA, paylaşılan depoda
//     ATOMİK olarak sahiplenilir; depo belirsizse istek REDDEDİLİR.
//   · ÇİFT İMZA — RSA başlığı varsa HMAC'e GERİ DÜŞÜLMEZ; aksi hâlde aynı
//     istek ikinci bir kabul yolu kazanırdı.

process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';

import crypto from 'crypto';

const users = { findOne: jest.fn() };
const federation = { findPeerByUrl: jest.fn() };
const fetchT = jest.fn();
const setIfAbsentAuthoritative = jest.fn();
const federationKeys = {
  getFederationKeyId: jest.fn(() => 'https://bridge.test/federation#main-key'),
  getOrCreateFederationKeys: jest.fn(),
  parseBridgeSignatureHeader: jest.fn(),
  signFederationPayload: jest.fn(),
  formatBridgeSignatureHeader: jest.fn((keyId: string, signature: string) => `keyId="${keyId}",signature="${signature}"`),
};

jest.mock('../db/loader', () => ({ __esModule: true, default: { users } }));
jest.mock('../db/repositories', () => ({ Federation: federation }));
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/redisAdapter', () => ({
  cache: { setIfAbsentAuthoritative: (...args: unknown[]) => setIfAbsentAuthoritative(...args) },
}));
jest.mock('../lib/federationKeys', () => federationKeys);
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  _resetSignatureReplayCache,
  buildFederationAuthHeaders,
  signFederationRequest,
  verifyFederationRequest,
  verifyHttpSignature,
} from '../lib/httpSignature';

// ── Gerçek anahtar çifti ────────────────────────────────────────────────────
// İmza doğrulaması taklit edilmez: kriptografi gerçek olmazsa "imza
// doğrulandı" iddiası ölçülmemiş olur.
let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = pair.publicKey;
  privateKeyPem = pair.privateKey;
});

type Headers = Record<string, string | string[] | undefined>;

function digestOf(body: unknown): string {
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return `SHA-256=${crypto.createHash('sha256').update(raw).digest('base64')}`;
}

function signRequest(options: {
  keyId: string;
  method?: string;
  url?: string;
  body?: unknown;
  date?: string;
  headerList?: string[];
  algorithm?: string;
  key?: string;
  // Donus tipi ACIKCA yazilir: `headers` bir BASLIK HARITASIDIR. Aksi halde
  // TypeScript nesne literalinden `{ signature: string }` cikarir ve testlerin
  // yaptigi mesru mutasyonlar (Date'i SILMEK, `Signature` buyuk harfli varyanti
  // EKLEMEK) derlenmez — oysa olculmek istenen tam olarak bu senaryolardir.
}): {
  method: string;
  url: string;
  originalUrl: string;
  headers: Headers;
  body: unknown;
} {
  const method = options.method ?? 'post';
  const url = options.url ?? '/api/federation/users/alice/inbox';
  const body = options.body ?? { type: 'Follow' };
  const date = options.date ?? new Date().toUTCString();
  const headerList = options.headerList ?? ['(request-target)', 'host', 'date', 'digest'];
  const headers: Headers = { host: 'bridge.test', date, digest: digestOf(body) };

  const signingString = headerList.map(h => (
    h === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${url}` : `${h}: ${headers[h] ?? ''}`
  )).join('\n');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString);
  const signature = signer.sign(options.key ?? privateKeyPem, 'base64');

  const algorithm = options.algorithm === undefined ? 'rsa-sha256' : options.algorithm;
  const parts = [`keyId="${options.keyId}"`];
  if (algorithm) parts.push(`algorithm="${algorithm}"`);
  parts.push(`headers="${headerList.join(' ')}"`, `signature="${signature}"`);

  return {
    method: method.toUpperCase(),
    url,
    originalUrl: url,
    headers: { ...headers, signature: parts.join(',') },
    body,
  };
}

const keyDocument = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({ publicKey: { publicKeyPem, ...over } }),
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetSignatureReplayCache();
  process.env.INSTANCE_URL = 'https://bridge.test';
  users.findOne.mockResolvedValue(null);
  federation.findPeerByUrl.mockResolvedValue(null);
  setIfAbsentAuthoritative.mockResolvedValue(true);
  fetchT.mockResolvedValue(keyDocument());
  federationKeys.getOrCreateFederationKeys.mockResolvedValue({ publicKeyPem, privateKeyPem });
  federationKeys.parseBridgeSignatureHeader.mockReturnValue(null);
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyHttpSignature — başlık ve gövde sözleşmesi', () => {
  it.each([
    ['imza başlığı yok', {} as Headers, 'No Signature header'],
    ['parametreler eksik', { signature: 'keyId="k"' } as Headers, 'Missing signature params (keyId/headers/signature)'],
  ])('%s', async (_label, headers, reason) => {
    const result = await verifyHttpSignature({ method: 'POST', url: '/x', headers, body: {} });
    expect(result).toEqual({ ok: false, reason });
  });

  it('DESTEKLENMEYEN algoritma reddedilir', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key', algorithm: 'hmac-sha256' });

    const result = await verifyHttpSignature(req);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Desteklenmeyen algoritma');
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('hs2019 takma adı kabul edilir', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key', algorithm: 'hs2019' });

    expect((await verifyHttpSignature(req)).ok).toBe(true);
  });

  it('algoritma HİÇ gönderilmezse de kabul edilir', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key', algorithm: '' });

    expect((await verifyHttpSignature(req)).ok).toBe(true);
  });

  it('(request-target) imzalanmamışsa reddedilir', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key', headerList: ['host', 'date', 'digest'] });

    const result = await verifyHttpSignature(req);

    expect(result).toEqual({ ok: false, reason: '(request-target) imzalanmış header listesinde zorunludur' });
  });

  it.each([
    ['Date başlığı yok', undefined, 'Date header required'],
    ['Date çözülemiyor', 'dün', 'Date header too old, too new, or invalid (±5min)'],
    ['Date çok eski', new Date(Date.now() - 10 * 60_000).toUTCString(), 'Date header too old, too new, or invalid (±5min)'],
    ['Date gelecekte', new Date(Date.now() + 10 * 60_000).toUTCString(), 'Date header too old, too new, or invalid (±5min)'],
  ])('%s', async (_label, date, reason) => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });
    if (date === undefined) delete req.headers.date; else req.headers.date = date;

    expect(await verifyHttpSignature(req)).toEqual({ ok: false, reason });
  });

  it('Digest başlığı zorunludur ve GÖVDEYLE eşleşmelidir', async () => {
    const missing = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });
    delete missing.headers.digest;
    expect(await verifyHttpSignature(missing)).toEqual({ ok: false, reason: 'Digest header required' });

    const tampered = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });
    tampered.body = { type: 'Delete' };
    expect((await verifyHttpSignature(tampered)).reason).toBe('Digest mismatch — body may have been tampered');
  });

  it('METİN gövde de doğrulanır', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key', body: '{"type":"Follow"}' });

    expect((await verifyHttpSignature(req)).ok).toBe(true);
  });

  it('BAŞLIK dizisi olarak gelen değerler birleştirilir', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });
    req.headers.Signature = req.headers.signature;
    delete req.headers.signature;

    expect((await verifyHttpSignature(req)).ok).toBe(true);
  });

  it('imza kriptografik olarak geçersizse reddedilir', async () => {
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key', key: other.privateKey });

    expect(await verifyHttpSignature(req)).toEqual({ ok: false, reason: 'Signature cryptographically invalid' });
    expect(setIfAbsentAuthoritative).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyHttpSignature — anahtar çözümü ve aktör bağlama', () => {
  it('FRAGMENT biçimli keyId aktörü kanıtlar', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    const result = await verifyHttpSignature(req);

    expect(result).toMatchObject({ ok: true, signerActor: 'https://remote.test/users/bob' });
  });

  it('AYRIK anahtar URL’i aktör bağı ÜRETMEZ', async () => {
    const req = signRequest({ keyId: 'https://remote.test/keys/1' });

    const result = await verifyHttpSignature(req);

    expect(result.ok).toBe(true);
    expect(result.signerActor).toBeUndefined();
  });

  it('uzak belgenin ÇELİŞEN sahiplik iddiası kabul edilmez', async () => {
    fetchT.mockResolvedValue(keyDocument({ owner: 'https://remote.test/users/kurban' }));
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    const result = await verifyHttpSignature(req);

    expect(result.signerActor).toBe('https://remote.test/users/bob');
  });

  it('anahtar belgesi KÖK düzeyinde de PEM taşıyabilir', async () => {
    fetchT.mockResolvedValue({ ok: true, json: async () => ({ publicKeyPem }) });
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    expect((await verifyHttpSignature(req)).ok).toBe(true);
  });

  it('PEM içermeyen belge anahtar üretmez', async () => {
    fetchT.mockResolvedValue({ ok: true, json: async () => ({ publicKey: {} }) });
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    expect(await verifyHttpSignature(req)).toEqual({ ok: false, reason: 'Public key not found' });
  });

  it('anahtar belgesi reddedilirse doğrulama yapılmaz', async () => {
    fetchT.mockResolvedValue({ ok: false, status: 404, url: 'https://remote.test/users/bob', json: async () => ({}) });
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    expect((await verifyHttpSignature(req)).reason).toContain('Key fetch başarısız');
  });

  it('YÖNLENDİRME reddedilir (başka host’a taşınabilir)', async () => {
    fetchT.mockResolvedValue({
      ok: false, status: 302, url: 'https://remote.test/users/bob',
      headers: { get: () => 'https://saldirgan.test/keys' },
      json: async () => ({}),
    });
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    expect((await verifyHttpSignature(req)).reason).toContain('yönlendirme reddedildi');
  });

  it('YEREL kullanıcı anahtarı depodan çözülür', async () => {
    users.findOne.mockResolvedValue({ username: 'alice', apPublicKey: publicKeyPem });
    const req = signRequest({ keyId: 'https://bridge.test/users/alice#main-key' });

    const result = await verifyHttpSignature(req);

    expect(result).toMatchObject({ ok: true, signerActor: 'https://bridge.test/users/alice' });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('yerel kullanıcının anahtarı yoksa UZAKTAN getirilmez', async () => {
    // Kendi örneğimizin kullanıcısı için anahtar yoksa doğru davranış
    // "bulunamadı"dır. Uzağa çıkmak, kendi kimliğimizi taklit eden bir
    // belgeye kapı açardı.
    users.findOne.mockResolvedValue({ username: 'alice' });
    const req = signRequest({ keyId: 'https://bridge.test/users/alice#main-key' });

    expect((await verifyHttpSignature(req)).reason).toBe('Public key not found');
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('yerel kullanıcı kaydı yoksa da uzağa çıkılmaz', async () => {
    users.findOne.mockResolvedValue(null);
    const req = signRequest({ keyId: 'https://bridge.test/users/yok#main-key' });

    expect((await verifyHttpSignature(req)).reason).toBe('Public key not found');
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('yerel biçime uymayan kimlik depoya SORULMAZ', async () => {
    const req = signRequest({ keyId: 'https://bridge.test/keys/1' });

    await verifyHttpSignature(req);

    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('ÖNBELLEK sahipliği PEM ile birlikte saklar', async () => {
    const first = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });
    expect((await verifyHttpSignature(first)).signerActor).toBe('https://remote.test/users/bob');

    fetchT.mockClear();
    const second = signRequest({ keyId: 'https://remote.test/users/bob#main-key', body: { type: 'Like' } });
    const result = await verifyHttpSignature(second);

    expect(fetchT).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, signerActor: 'https://remote.test/users/bob' });
  });

  it.each([
    ['localhost', 'https://localhost/keys/1'],
    ['döngü adresi', 'https://127.0.0.1/keys/1'],
    ['özel ağ', 'https://10.0.0.5/keys/1'],
    ['bağlantı-yerel metadata', 'https://169.254.169.254/keys/1'],
    ['bulut metadata adı', 'https://metadata.google.internal/keys/1'],
  ])('SSRF hedefi (%s) anahtar GETİRİLMEZ', async (_label, keyId) => {
    const req = signRequest({ keyId });

    expect((await verifyHttpSignature(req)).reason).toContain('şüpheli host');
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('DÜZ HTTP anahtar adresi reddedilir', async () => {
    const req = signRequest({ keyId: 'http://remote.test/users/bob#main-key' });

    expect((await verifyHttpSignature(req)).reason).toContain('yalnızca HTTPS');
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('URL olmayan keyId çözülmez', async () => {
    const req = signRequest({ keyId: 'bu-bir-url-degil' });

    expect((await verifyHttpSignature(req)).reason).toContain('Key URL parse hatası');
  });

  it('anahtar getirme PATLARSA doğrulama açılmaz', async () => {
    fetchT.mockRejectedValue(new Error('network down'));
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    expect((await verifyHttpSignature(req)).reason).toContain('network down');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('verifyHttpSignature — replay koruması', () => {
  it('imza yalnız BİR KEZ kullanılabilir', async () => {
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });
    expect((await verifyHttpSignature(req)).ok).toBe(true);

    setIfAbsentAuthoritative.mockResolvedValue(false);
    expect(await verifyHttpSignature(req)).toMatchObject({
      ok: false, reason: 'Replay attack: signature already used',
    });
  });

  it('replay deposu BELİRSİZSE istek reddedilir (fail-closed)', async () => {
    setIfAbsentAuthoritative.mockRejectedValue(new Error('redis down'));
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key' });

    expect((await verifyHttpSignature(req)).reason).toBe('Replay attack: signature already used');
  });

  it('replay talebi yalnız DOĞRULAMADAN SONRA yapılır', async () => {
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const req = signRequest({ keyId: 'https://remote.test/users/bob#main-key', key: other.privateKey });

    await verifyHttpSignature(req);

    expect(setIfAbsentAuthoritative).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('federasyon imzaları', () => {
  const freshTs = () => String(Date.now());

  const hmacRequest = (body: unknown, ts = freshTs(), secret = 'test-federation-secret') => ({
    method: 'POST',
    url: '/api/federation/peers',
    headers: {
      'x-bridge-ts': ts,
      'x-bridge-sig': crypto.createHmac('sha256', secret).update(ts + JSON.stringify(body)).digest('hex'),
    } as Headers,
    body,
  });

  it('HMAC imzalı istek kabul edilir', async () => {
    expect(await verifyFederationRequest(hmacRequest({ url: 'https://peer.test' }))).toBe(true);
  });

  it.each([
    ['imza yok', { 'x-bridge-ts': '1' }],
    ['zaman damgası yok', { 'x-bridge-sig': 'abc' }],
  ])('%s ise reddedilir', async (_label, headers) => {
    expect(await verifyFederationRequest({
      method: 'POST', url: '/x', headers: headers as Headers, body: {},
    })).toBe(false);
  });

  it('ESKİ zaman damgası reddedilir', async () => {
    const stale = String(Date.now() - 10 * 60_000);
    expect(await verifyFederationRequest(hmacRequest({ a: 1 }, stale))).toBe(false);
  });

  it('YANLIŞ gizli anahtarla üretilen imza reddedilir', async () => {
    expect(await verifyFederationRequest(hmacRequest({ a: 1 }, freshTs(), 'baska-sir'))).toBe(false);
  });

  it('UZUNLUĞU farklı imza çökme değil RED üretir', async () => {
    const req = hmacRequest({ a: 1 });
    req.headers['x-bridge-sig'] = 'kisa';

    expect(await verifyFederationRequest(req)).toBe(false);
  });

  it('HMAC isteği YENİDEN OYNATILAMAZ', async () => {
    const req = hmacRequest({ a: 1 });
    expect(await verifyFederationRequest(req)).toBe(true);

    setIfAbsentAuthoritative.mockResolvedValue(false);
    expect(await verifyFederationRequest(req)).toBe(false);
  });

  it('RSA başlığı varsa HMAC’e GERİ DÜŞÜLMEZ', async () => {
    federationKeys.parseBridgeSignatureHeader.mockReturnValue(null);
    const req = hmacRequest({ a: 1 });
    req.headers['x-bridge-signature'] = 'keyId="k",signature="bozuk"';

    expect(await verifyFederationRequest(req)).toBe(false);
  });

  it('RSA imzası EŞ anahtarıyla doğrulanır', async () => {
    const ts = freshTs();
    const body = { url: 'https://peer.test' };
    const signature = crypto.createSign('RSA-SHA256').update(ts + JSON.stringify(body)).sign(privateKeyPem, 'base64');
    federationKeys.parseBridgeSignatureHeader.mockReturnValue({ keyId: 'https://peer.test/keys#main', signature });
    federation.findPeerByUrl.mockResolvedValue({ publicKey: publicKeyPem });

    const ok = await verifyFederationRequest({
      method: 'POST', url: '/x',
      headers: { 'x-bridge-ts': ts, 'x-bridge-signature': 'header' } as Headers,
      body,
    });

    expect(ok).toBe(true);
    expect(federation.findPeerByUrl).toHaveBeenCalledWith('https://peer.test');
  });

  it('EŞ kaydı yoksa keyId üzerinden çözülür', async () => {
    const ts = freshTs();
    const body = {};
    const signature = crypto.createSign('RSA-SHA256').update(ts + JSON.stringify(body)).sign(privateKeyPem, 'base64');
    federationKeys.parseBridgeSignatureHeader.mockReturnValue({ keyId: 'https://peer.test/keys#main', signature });

    const ok = await verifyFederationRequest({
      method: 'POST', url: '/x',
      headers: { 'x-bridge-ts': ts, 'x-bridge-signature': 'header' } as Headers,
      body,
    });

    expect(ok).toBe(true);
    expect(fetchT).toHaveBeenCalled();
  });

  it('KENDİ örneğimizin anahtarı yerelden çözülür', async () => {
    const ts = freshTs();
    const body = {};
    const signature = crypto.createSign('RSA-SHA256').update(ts + JSON.stringify(body)).sign(privateKeyPem, 'base64');
    federationKeys.parseBridgeSignatureHeader.mockReturnValue({
      keyId: 'https://bridge.test/federation#main-key', signature,
    });

    const ok = await verifyFederationRequest({
      method: 'POST', url: '/x',
      headers: { 'x-bridge-ts': ts, 'x-bridge-signature': 'header' } as Headers,
      body,
    });

    expect(ok).toBe(true);
    expect(federationKeys.getOrCreateFederationKeys).toHaveBeenCalled();
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('anahtar çözülemezse RSA doğrulaması yapılmaz', async () => {
    federationKeys.parseBridgeSignatureHeader.mockReturnValue({ keyId: 'http://10.0.0.5/keys', signature: 'x' });

    const ok = await verifyFederationRequest({
      method: 'POST', url: '/x',
      headers: { 'x-bridge-ts': freshTs(), 'x-bridge-signature': 'header' } as Headers,
      body: {},
    });

    expect(ok).toBe(false);
  });

  it('çözülemeyen RSA başlığı reddedilir', async () => {
    federationKeys.parseBridgeSignatureHeader.mockReturnValue(null);

    const ok = await verifyFederationRequest({
      method: 'POST', url: '/x',
      headers: { 'x-bridge-ts': freshTs(), 'x-bridge-signature': 'bozuk' } as Headers,
      body: {},
    });

    expect(ok).toBe(false);
  });

  it('giden istek için HMAC ve RSA başlıkları birlikte üretilir', async () => {
    federationKeys.signFederationPayload.mockReturnValue('rsa-imza');

    const headers = await buildFederationAuthHeaders({ a: 1 });

    expect(headers['x-bridge-ts']).toMatch(/^\d+$/);
    expect(headers['x-bridge-sig']).toHaveLength(64);
    expect(headers['X-Bridge-Signature']).toContain('rsa-imza');
  });

  it('gizli anahtar yoksa giden istek İMZALANAMAZ', async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.FEDERATION_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.FEDERATION_SECRET;
    try {
      await expect(signFederationRequest({ a: 1 })).rejects.toThrow('FEDERATION_SECRET is not configured');
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousSecret === undefined) delete process.env.FEDERATION_SECRET;
      else process.env.FEDERATION_SECRET = previousSecret;
    }
  });

  it('üretimde gizli anahtar yoksa gelen HMAC de doğrulanamaz', async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.FEDERATION_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.FEDERATION_SECRET;
    try {
      expect(await verifyFederationRequest(hmacRequest({ a: 1 }))).toBe(false);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousSecret === undefined) delete process.env.FEDERATION_SECRET;
      else process.env.FEDERATION_SECRET = previousSecret;
    }
  });

  it('AÇIK gizli anahtar ortam değişkeninden okunur', async () => {
    const previousSecret = process.env.FEDERATION_SECRET;
    process.env.FEDERATION_SECRET = 'acik-sirxxxxxxxxxxxxxxxxxxxxxxxx';
    try {
      expect(await verifyFederationRequest(hmacRequest({ a: 1 }, freshTs(), 'acik-sirxxxxxxxxxxxxxxxxxxxxxxxx'))).toBe(true);
    } finally {
      if (previousSecret === undefined) delete process.env.FEDERATION_SECRET;
      else process.env.FEDERATION_SECRET = previousSecret;
    }
  });
});
