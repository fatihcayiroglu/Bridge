// server/tests/http-signature-cache-and-header-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// HTTP SIGNATURE — ANAHTAR ÖNBELLEĞİ, BAŞLIK OKUMA VE EŞ ANAHTAR ÇÖZÜMÜ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/http-signature-key-resolution-branches.test.ts` aktör bağlamayı,
// SSRF'yi ve replay'i ölçer. Bu tamamlayıcı takım aynı modülün ÖNBELLEK ve
// BAŞLIK katmanını ölçer — sessiz kabul/ret hatalarının çıktığı yer:
//
//   · ÖNBELLEK ÖMRÜ. Süresi dolmuş bir anahtar hâlâ kabul edilirse, uzak
//     sunucu anahtarını DÖNDÜRDÜKTEN sonra bile eski (belki sızmış) anahtarla
//     imzalanmış istekler 10 dakikadan uzun süre geçerli kalırdı.
//   · ÖNBELLEK SINIRI. Sınırsız bir anahtar önbelleği, keyId'i saldırgan
//     belirlediği için sınırsız bellek demektir.
//   · BAŞLIK OKUMA. HTTP başlıkları TEKRARLANABİLİR ve büyük/küçük harf
//     duyarsızdır. Yalnız `headers[name]` okumak, dizi olarak gelen ya da
//     farklı harflendirilmiş bir başlığı GÖRMEZ ve imza doğrulaması
//     nedensiz başarısız olur.
//   · UZAK ANAHTAR BELGESİ. Alanı bulunmayan bir belge önbelleğe YAZILMAZ;
//     aksi hâlde `null` bir anahtar 10 dakika boyunca yeniden denemeyi
//     engellerdi.

process.env.NODE_ENV = 'test';

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
  verifyFederationRequest,
  verifyHttpSignature,
} from '../lib/httpSignature';

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
  body?: unknown;
  headerList?: string[];
  extraHeaders?: Headers;
  headerCase?: (name: string) => string;
}) {
  const method = 'post';
  const url = '/api/federation/users/alice/inbox';
  const body = 'body' in options ? options.body : { type: 'Follow' };
  const date = new Date().toUTCString();
  const headerList = options.headerList ?? ['(request-target)', 'host', 'date', 'digest'];
  const values: Record<string, string> = { host: 'bridge.test', date, digest: digestOf(body) };

  const signingString = headerList.map(h => (
    h === '(request-target)' ? `(request-target): ${method} ${url}` : `${h}: ${values[h] ?? ''}`
  )).join('\n');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString);
  const signature = signer.sign(privateKeyPem, 'base64');

  const headers: Headers = {};
  const rename = options.headerCase ?? ((name: string) => name);
  for (const [name, value] of Object.entries(values)) headers[rename(name)] = value;
  headers[rename('signature')] = [
    `keyId="${options.keyId}"`, 'algorithm="rsa-sha256"',
    `headers="${headerList.join(' ')}"`, `signature="${signature}"`,
  ].join(',');
  Object.assign(headers, options.extraHeaders ?? {});

  return { method: 'POST', url, originalUrl: url, headers, body };
}

const previousInstanceUrl = process.env.INSTANCE_URL;
const previousPort = process.env.PORT;
const previousNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  jest.clearAllMocks();
  _resetSignatureReplayCache();
  process.env.NODE_ENV = 'test';
  process.env.INSTANCE_URL = 'https://bridge.test';
  delete process.env.PORT;
  delete process.env.FEDERATION_SECRET;
  users.findOne.mockResolvedValue(null);
  federation.findPeerByUrl.mockResolvedValue(null);
  setIfAbsentAuthoritative.mockResolvedValue(true);
  federationKeys.parseBridgeSignatureHeader.mockReturnValue(null);
  federationKeys.getOrCreateFederationKeys.mockResolvedValue({ publicKeyPem: 'LOCAL-PEM' });
});

afterAll(() => {
  process.env.NODE_ENV = previousNodeEnv!;
  if (previousInstanceUrl === undefined) delete process.env.INSTANCE_URL;
  else process.env.INSTANCE_URL = previousInstanceUrl;
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
});

describe('the public key cache respects its own lifetime', () => {
  it('re-reads a key once the cached entry has expired', async () => {
    const keyId = 'https://bridge.test/api/federation/users/alice#main-key';
    users.findOne.mockResolvedValue({ username: 'alice', apPublicKey: publicKeyPem });

    await expect(verifyHttpSignature(signRequest({ keyId }))).resolves.toMatchObject({ ok: true });
    expect(users.findOne).toHaveBeenCalledTimes(1);

    // A second verification inside the TTL is served from cache.
    await expect(verifyHttpSignature(signRequest({ keyId }))).resolves.toMatchObject({ ok: true });
    expect(users.findOne).toHaveBeenCalledTimes(1);

    const realNow = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60 * 1000);
    try {
      // The Date header is checked against the same clock, so re-sign at the
      // shifted time; only the KEY lookup is under test here.
      const stale = signRequest({ keyId });
      stale.headers.date = new Date(realNow + 11 * 60 * 1000).toUTCString();
      await verifyHttpSignature(stale);
    } finally { clock.mockRestore(); }

    expect(users.findOne).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry rather than growing without bound', async () => {
    // keyId is attacker-controlled, so an unbounded cache is unbounded memory.
    users.findOne.mockImplementation(async (q: { username: string }) => ({
      username: q.username, apPublicKey: publicKeyPem,
    }));

    for (let i = 0; i < 501; i += 1) {
      const keyId = `https://bridge.test/api/federation/users/u${i}#main-key`;
      await verifyHttpSignature(signRequest({ keyId }));
    }
    const lookupsAfterFill = users.findOne.mock.calls.length;
    expect(lookupsAfterFill).toBe(501);

    // The very first key was evicted and must be resolved again...
    await verifyHttpSignature(signRequest({ keyId: 'https://bridge.test/api/federation/users/u0#main-key' }));
    expect(users.findOne.mock.calls.length).toBe(lookupsAfterFill + 1);

    // ...while the newest key is still cached.
    await verifyHttpSignature(signRequest({ keyId: 'https://bridge.test/api/federation/users/u500#main-key' }));
    expect(users.findOne.mock.calls.length).toBe(lookupsAfterFill + 1);
  });

  it('a local key without a fragment is cached with no actor binding', async () => {
    const keyId = 'https://bridge.test/api/federation/users/alice';
    users.findOne.mockResolvedValue({ username: 'alice', apPublicKey: publicKeyPem });

    const first = await verifyHttpSignature(signRequest({ keyId }));
    expect(first.ok).toBe(true);
    expect(first.signerActor).toBeFalsy();

    // Served from cache the second time, and still without an actor claim.
    const second = await verifyHttpSignature(signRequest({ keyId }));
    expect(second.ok).toBe(true);
    expect(second.signerActor).toBeFalsy();
    expect(users.findOne).toHaveBeenCalledTimes(1);
  });

  it('a fragment key id keeps its actor binding across a cache hit', async () => {
    const keyId = 'https://bridge.test/api/federation/users/alice#main-key';
    users.findOne.mockResolvedValue({ username: 'alice', apPublicKey: publicKeyPem });

    const first = await verifyHttpSignature(signRequest({ keyId }));
    const second = await verifyHttpSignature(signRequest({ keyId }));
    expect(first.signerActor).toBe('https://bridge.test/api/federation/users/alice');
    expect(second.signerActor).toBe(first.signerActor);
  });

  it('an unknown local user is not resolved through the remote fetch path', async () => {
    users.findOne.mockResolvedValue(null);
    const result = await verifyHttpSignature(
      signRequest({ keyId: 'https://bridge.test/api/federation/users/ghost#main-key' }));
    expect(result.ok).toBe(false);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('without INSTANCE_URL the local namespace falls back to the configured port', async () => {
    delete process.env.INSTANCE_URL;
    process.env.PORT = '4100';
    users.findOne.mockResolvedValue({ username: 'alice', apPublicKey: publicKeyPem });

    const result = await verifyHttpSignature(
      signRequest({ keyId: 'http://localhost:4100/api/federation/users/alice#main-key' }));

    expect(result.ok).toBe(true);
    expect(fetchT).not.toHaveBeenCalled();
    expect(users.findOne).toHaveBeenCalledWith({ username: 'alice' });
  });
});

describe('request headers are read the way HTTP actually delivers them', () => {
  it('a listed header that is absent contributes an empty value on both sides', async () => {
    const keyId = 'https://bridge.test/api/federation/users/alice#main-key';
    users.findOne.mockResolvedValue({ username: 'alice', apPublicKey: publicKeyPem });

    const req = signRequest({
      keyId,
      headerList: ['(request-target)', 'host', 'date', 'digest', 'content-type'],
    });

    await expect(verifyHttpSignature(req)).resolves.toMatchObject({ ok: true });
  });

  it('a repeated header arriving as an array is joined rather than ignored', async () => {
    federation.findPeerByUrl.mockResolvedValue({ publicKey: publicKeyPem });
    const ts = String(Date.now());
    const body = { url: 'https://peer.test' };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(ts + JSON.stringify(body));
    const signature = signer.sign(privateKeyPem, 'base64');
    federationKeys.parseBridgeSignatureHeader.mockReturnValue({ keyId: undefined, signature });

    const ok = await verifyFederationRequest({
      method: 'POST', url: '/x', headers: {
        'x-bridge-signature': ['keyId="k",signature="s"'] as never,
        'x-bridge-ts': ts,
      }, body,
    } as never);

    expect(ok).toBe(true);
  });

  it('an unusually cased header is still found', async () => {
    // Node lower-cases incoming headers, but this module is also called with
    // synthesised requests (proxies, tests, other transports); a case-sensitive
    // read would silently reject an otherwise valid federation request.
    const ts = String(Date.now());
    const body = { hello: 'cased' };
    const sig = crypto.createHmac('sha256', 'test-federation-secret')
      .update(ts + JSON.stringify(body)).digest('hex');

    await expect(verifyFederationRequest({
      method: 'POST', url: '/x',
      headers: { 'X-Bridge-Sig': sig, 'X-Bridge-Ts': ts } as never,
      body,
    } as never)).resolves.toBe(true);
  });

  it('a request with no body at all still has a verifiable digest', async () => {
    const keyId = 'https://bridge.test/api/federation/users/alice#main-key';
    users.findOne.mockResolvedValue({ username: 'alice', apPublicKey: publicKeyPem });

    const req = signRequest({ keyId, body: undefined });
    // JSON.stringify(undefined) is undefined, so the module must fall back to
    // the empty string on BOTH sides or an empty POST could never be verified.
    expect(req.headers.digest).toBe(`SHA-256=${crypto.createHash('sha256').update('""').digest('base64')}`);
    await expect(verifyHttpSignature(req)).resolves.toMatchObject({ ok: true });
  });
});

describe('peer public key resolution for Bridge-to-Bridge federation', () => {
  function rsaRequest(options: { keyId?: string; body?: unknown; ts?: string }) {
    const ts = options.ts ?? String(Date.now());
    const body = 'body' in options ? options.body : { url: 'https://peer.test' };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(ts + JSON.stringify(body ?? {}));
    const signature = signer.sign(privateKeyPem, 'base64');
    federationKeys.parseBridgeSignatureHeader.mockReturnValue({ keyId: options.keyId, signature });
    return {
      method: 'POST', url: '/x',
      headers: { 'x-bridge-signature': 'keyId="k",signature="s"', 'x-bridge-ts': ts },
      body,
    } as never;
  }

  it('a known peer key wins before any key id is considered', async () => {
    federation.findPeerByUrl.mockResolvedValue({ publicKey: publicKeyPem });
    await expect(verifyFederationRequest(rsaRequest({ keyId: 'https://peer.test/keys/1' }))).resolves.toBe(true);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('an unknown peer and no key id cannot be verified', async () => {
    federation.findPeerByUrl.mockResolvedValue(null);
    await expect(verifyFederationRequest(rsaRequest({ keyId: undefined }))).resolves.toBe(false);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('a key id inside this instance resolves to the local federation key', async () => {
    federation.findPeerByUrl.mockResolvedValue(null);
    federationKeys.getOrCreateFederationKeys.mockResolvedValue({ publicKeyPem });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://bridge.test/api/federation/keys/main' }))).resolves.toBe(true);
    expect(federationKeys.getOrCreateFederationKeys).toHaveBeenCalledTimes(1);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('without INSTANCE_URL the local key id namespace falls back to localhost', async () => {
    delete process.env.INSTANCE_URL;
    delete process.env.PORT;
    federation.findPeerByUrl.mockResolvedValue(null);
    federationKeys.getOrCreateFederationKeys.mockResolvedValue({ publicKeyPem });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'http://localhost:3001/api/federation/keys/main' }))).resolves.toBe(true);
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('a remote key document is accepted in either published shape', async () => {
    federation.findPeerByUrl.mockResolvedValue(null);
    fetchT.mockResolvedValue({ ok: true, json: async () => ({ publicKeyPem }) });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://peer.test/keys/flat' }))).resolves.toBe(true);

    fetchT.mockResolvedValue({ ok: true, json: async () => ({ publicKey: { publicKeyPem } }) });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://peer.test/keys/nested' }))).resolves.toBe(true);
  });

  it('a key document with no key material is not cached, so a later fetch can succeed', async () => {
    federation.findPeerByUrl.mockResolvedValue(null);
    fetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'no key here' }) });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://peer.test/keys/empty' }))).resolves.toBe(false);

    fetchT.mockResolvedValueOnce({ ok: true, json: async () => ({ publicKeyPem }) });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://peer.test/keys/empty' }))).resolves.toBe(true);
    expect(fetchT).toHaveBeenCalledTimes(2);
  });

  it('a non-2xx key document response is a refusal, not a crash', async () => {
    federation.findPeerByUrl.mockResolvedValue(null);
    fetchT.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://peer.test/keys/missing' }))).resolves.toBe(false);
  });

  it('plain HTTP key ids are refused in production', async () => {
    federation.findPeerByUrl.mockResolvedValue(null);
    process.env.NODE_ENV = 'production';
    try {
      await expect(verifyFederationRequest(
        rsaRequest({ keyId: 'http://peer.test/keys/1' }))).resolves.toBe(false);
      expect(fetchT).not.toHaveBeenCalled();
    } finally { process.env.NODE_ENV = 'test'; }
  });

  it('a remote key is cached, so a second request does not refetch it', async () => {
    federation.findPeerByUrl.mockResolvedValue(null);
    fetchT.mockResolvedValue({ ok: true, json: async () => ({ publicKeyPem }) });
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://peer.test/keys/cached' }))).resolves.toBe(true);
    await expect(verifyFederationRequest(
      rsaRequest({ keyId: 'https://peer.test/keys/cached' }))).resolves.toBe(true);
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('a peer key cached without an owner still yields a fragment-derived actor', async () => {
    // The federation path caches PEMs with no owner. An ActivityPub
    // verification that later hits that same entry must still be able to bind
    // the actor from the key id fragment rather than losing the evidence.
    const keyId = 'https://peer.test/users/bob#main-key';
    federation.findPeerByUrl.mockResolvedValue(null);
    fetchT.mockResolvedValue({ ok: true, json: async () => ({ publicKeyPem }) });
    await expect(verifyFederationRequest(rsaRequest({ keyId }))).resolves.toBe(true);

    const result = await verifyHttpSignature(signRequest({ keyId }));
    expect(result.ok).toBe(true);
    expect(result.signerActor).toBe('https://peer.test/users/bob');
    // Served from the federation-populated cache: no second fetch.
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('an RSA request with no body verifies against an empty object payload', async () => {
    // With no body there is no sender url either, so the key can only come
    // from the key id — and the signed payload must be a stable `{}`.
    federation.findPeerByUrl.mockResolvedValue(null);
    federationKeys.getOrCreateFederationKeys.mockResolvedValue({ publicKeyPem });
    await expect(verifyFederationRequest(rsaRequest({
      body: undefined, keyId: 'https://bridge.test/api/federation/keys/main',
    }))).resolves.toBe(true);
    expect(federation.findPeerByUrl).not.toHaveBeenCalled();
  });
});

describe('HMAC fallback', () => {
  it('is refused outright when either header is missing', async () => {
    const base = { method: 'POST', url: '/x', body: {} };
    await expect(verifyFederationRequest({ ...base, headers: {} } as never)).resolves.toBe(false);
    await expect(verifyFederationRequest({ ...base, headers: { 'x-bridge-sig': 'abc' } } as never)).resolves.toBe(false);
    await expect(verifyFederationRequest({ ...base, headers: { 'x-bridge-ts': String(Date.now()) } } as never)).resolves.toBe(false);
  });

  it('accepts a correctly computed HMAC and rejects a tampered one', async () => {
    const ts = String(Date.now());
    const body = { hello: 'world' };
    const good = crypto.createHmac('sha256', 'test-federation-secret')
      .update(ts + JSON.stringify(body)).digest('hex');

    await expect(verifyFederationRequest({
      method: 'POST', url: '/x', headers: { 'x-bridge-sig': good, 'x-bridge-ts': ts }, body,
    } as never)).resolves.toBe(true);

    const tampered = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    await expect(verifyFederationRequest({
      method: 'POST', url: '/x', headers: { 'x-bridge-sig': tampered, 'x-bridge-ts': ts }, body,
    } as never)).resolves.toBe(false);
  });

  it('a non-production, non-test runtime uses the explicit dev-only placeholder', async () => {
    process.env.NODE_ENV = 'development';
    try {
      const ts = String(Date.now());
      const body = { hello: 'dev' };
      const sig = crypto.createHmac('sha256', 'bridge-federation-dev-only-NOT-FOR-PRODUCTION')
        .update(ts + JSON.stringify(body)).digest('hex');
      await expect(verifyFederationRequest({
        method: 'POST', url: '/x', headers: { 'x-bridge-sig': sig, 'x-bridge-ts': ts }, body,
      } as never)).resolves.toBe(true);
    } finally { process.env.NODE_ENV = 'test'; }
  });

  it('production without a configured secret has no fallback at all', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const ts = String(Date.now());
      const body = {};
      const sig = crypto.createHmac('sha256', 'test-federation-secret')
        .update(ts + JSON.stringify(body)).digest('hex');
      await expect(verifyFederationRequest({
        method: 'POST', url: '/x', headers: { 'x-bridge-sig': sig, 'x-bridge-ts': ts }, body,
      } as never)).resolves.toBe(false);
    } finally { process.env.NODE_ENV = 'test'; }
  });
});
