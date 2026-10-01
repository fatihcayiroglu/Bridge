// server/tests/jobs-federationHeartbeat.test.ts
// federationHeartbeat job — unit tests (network mocked)
process.env.NODE_ENV = 'test';
process.env.FEDERATION_SECRET = 'test-secretxxxxxxxxxxxxxxxxxxxxx';
process.env.INSTANCE_URL = 'http://localhost:3001';
process.env.AP_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.FEDERATION_HEARTBEAT_CONCURRENCY = '3';

const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), error: (...args: unknown[]) => mockLoggerError(...args), fatal: jest.fn() },
}));

// P5 FED-03: the heartbeat now signs with the instance-peer (V3) signer for
// real; only the key store, replay store and peer lookup are doubles, so the
// round-trip test below exercises the SAME verifier the receiving node runs.
jest.mock('../lib/federationKeys', () => {
  const crypto = require('crypto');
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    __keys: pair,
    getOrCreateFederationKeys: jest.fn(async () => ({ publicKeyPem: pair.publicKey, privateKeyPem: pair.privateKey, keyVersion: 1 })),
    getFederationKeyId: () => 'http://localhost:3001/api/federation/key',
    getInstanceUrl: () => 'http://localhost:3001',
  };
});

const mockReplay = new Set<string>();
jest.mock('../lib/httpSignature', () => ({
  claimSignatureReplay: jest.fn(async (raw: string) => {
    if (mockReplay.has(raw)) return false;
    mockReplay.add(raw);
    return true;
  }),
}));

// What the RECEIVING installation has registered for us.
const mockReceiverPeers = new Map<string, Record<string, unknown>>();
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { federationPeers: { findOne: jest.fn(async ({ url }: { url: string }) => mockReceiverPeers.get(url) ?? null) } },
}));
jest.mock('../db/repositories', () => ({
  Federation: { getPeerByUrl: jest.fn(async () => null) },
}));

jest.mock('../lib/fetch', () => ({
  fetchT: jest.fn((...args: Parameters<typeof fetch>) => global.fetch(...args)),
}));

// Yayilim (`...args`) ile cagrilan bir ikiz, PARAMETRE ALAN bir imzayla
// yazilmak zorundadir; parametresiz `jest.fn(async () => true)` TS2556
// veriyordu. Argumanlar bu testte OKUNMUYOR — o yuzden `_args`.
const mockHeartbeatClaim = jest.fn(async (..._args: unknown[]) => true);
jest.mock('../lib/redisAdapter', () => ({
  cache: { setIfAbsentAuthoritative: (...args: unknown[]) => mockHeartbeatClaim(...args) },
}));

import { createMockDb, requireDoc } from './helpers/mockDb';
import type { MockDb, MockDoc } from './helpers/mockDb';
import { headerFrom } from './helpers/fetchDouble';
import type { DbHandle, FederationPeer } from '../jobs/federationHeartbeat';
import { v4 as uuidv4 } from 'uuid';

// ══════════════════════════════════════════════════════════════════════════
// MOCK DB — URUN SOZLESMESINE BAGLI, `as any` OLMADAN
// ══════════════════════════════════════════════════════════════════════════
// Eskiden burada `createMockDb() as any` vardi. O tek kelime iki seyi birden
// yok ediyordu: `db.federation_peers`in gercekten `DbHandle`a uydugunun
// kaniti ve testin geri kalanindaki her `db.` erisiminin tip denetimi.
//
// Is aslinda basit: is (`federationHeartbeat`) KENDI dar sozlesmesini yaziyor
// (`DbHandle`, snake_case `federation_peers`), mock DB ise ayni tabloyu
// camelCase (`federationPeers`) adiyla sunuyor. Ikisini bir adaptor birlestirir.
//
// `find` donusu DOGRULANIR, iddia EDILMEZ: mock koleksiyon `MockDoc`
// dondurur ve bir `MockDoc`un `url`/`verified` tasidigi garanti degildir.
// Tasimayan bir satir sessizce gecmek yerine ACIK bir hata firlatir.

/** `MockDoc` -> `FederationPeer`; alanlar DOGRULANIR. */
function toFederationPeer(doc: MockDoc): FederationPeer {
  const { _id, url, verified, lastSeen } = doc;
  if (typeof url !== 'string') {
    throw new Error(`federation_peers satiri 'url' tasimiyor: ${JSON.stringify(doc)}`);
  }
  if (typeof verified !== 'boolean') {
    throw new Error(`federation_peers satiri 'verified' tasimiyor: ${JSON.stringify(doc)}`);
  }
  return {
    _id,
    url,
    verified,
    ...(typeof lastSeen === 'number' ? { lastSeen } : {}),
  };
}

/** Test tarafinda kullanilan DB: mock yuzeyi + isin bekledigi sozlesme. */
type FederationTestDb = MockDb & DbHandle & {
  federation_peers: {
    insert(doc: Partial<MockDoc>): Promise<MockDoc>;
    findOne(query: Record<string, unknown>): Promise<MockDoc | null>;
  };
};

function buildDb(): FederationTestDb {
  const db = createMockDb();
  const peers = db.federationPeers;
  return Object.assign(db, {
    federation_peers: {
      find:    async (query: object) =>
        (await peers.find(query as Record<string, unknown>)).map(toFederationPeer),
      update:  async (query: object, update: object) => {
        await peers.update(query as Record<string, unknown>, update as Record<string, unknown>);
      },
      insert:  (doc: Partial<MockDoc>) => peers.insert(doc),
      findOne: (query: Record<string, unknown>) => peers.findOne(query),
    },
  });
}

type FetchImpl = (...args: Parameters<typeof fetch>) => unknown;
let _fetchImpl: FetchImpl;
global.fetch = jest.fn((...args: Parameters<typeof fetch>) => _fetchImpl(...args)) as typeof fetch;

const { startFederationHeartbeat, stopFederationHeartbeat, pingPeer, _runHeartbeatForTest, _runClaimedHeartbeatForTest } =
  require('../jobs/federationHeartbeat');

// ── helpers ──────────────────────────────────────────────────────
function makePeer(overrides = {}) {
  return { _id: uuidv4(), url: 'http://remote.example', verified: true, lastSeen: 0, ...overrides };
}

function okResponse() {
  return Promise.resolve({ ok: true, status: 200 });
}
function failResponse() {
  return Promise.reject(new Error('ECONNREFUSED'));
}
function notOkResponse(status = 500) {
  return Promise.resolve({ ok: false, status });
}

beforeEach(() => {
  mockHeartbeatClaim.mockReset();
  mockHeartbeatClaim.mockResolvedValue(true);
});

// ── Tests ─────────────────────────────────────────────────────────
// Not: pingPeer closure üzerinden _db'yi okur (this değil).
// startFederationHeartbeat(db) çağrısı _db'yi set eder — her testte önce o çağrılır.

describe('pingPeer — successful response', () => {
  let db: FederationTestDb;
  beforeEach(() => {
    db = buildDb();
    _fetchImpl = jest.fn(okResponse);
  });
  afterEach(() => stopFederationHeartbeat());

  it('sends POST to /api/federation/ping endpoint', async () => {
    const peer = makePeer();
    await db.federation_peers.insert(peer);

    // Inject db into module by starting the job (sets _db via closure)
    startFederationHeartbeat(db);

    await pingPeer(peer);

    expect(_fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = jest.mocked(_fetchImpl).mock.calls[0];
    expect(url).toContain('/api/federation/ping');
    expect(opts?.method).toBe('POST');
  });

  it('sets verified=true and updates lastSeen on success', async () => {
    const peer = makePeer({ lastSeen: 0, verified: false });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    _fetchImpl = jest.fn(okResponse);
    const result = await pingPeer(peer);
    expect(result).toBe(true);

    const updated = await requireDoc(db.federation_peers, { _id: peer._id });
    expect(updated.verified).toBe(true);
    expect(updated.lastSeen).toBeGreaterThan(0);
  });

  it('includes the instance-peer signature headers', async () => {
    const peer = makePeer();
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    _fetchImpl = jest.fn(okResponse);
    await pingPeer(peer);

    const [, opts] = jest.mocked(_fetchImpl).mock.calls[0];
    expect(headerFrom(opts, 'x-bridge-rsa-sig')).toBeDefined();
    expect(headerFrom(opts, 'x-bridge-ts')).toMatch(/^\d+$/);
    expect(headerFrom(opts, 'x-bridge-instance-url')).toBe('http://localhost:3001');
  });
});

describe('pingPeer — network failure', () => {
  let db: FederationTestDb;
  beforeEach(() => {
    db = buildDb();
    _fetchImpl = jest.fn(failResponse);
  });
  afterEach(() => stopFederationHeartbeat());

  it('sets verified=false on network error and returns false', async () => {
    const peer = makePeer({ verified: true });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    const result = await pingPeer(peer);
    expect(result).toBe(false);
  });

  it('does not throw on network error', async () => {
    const peer = makePeer();
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    await expect(pingPeer(peer)).resolves.toBe(false);
  });
});

describe('pingPeer — non-2xx response', () => {
  let db: FederationTestDb;
  beforeEach(() => {
    db = buildDb();
  });
  afterEach(() => stopFederationHeartbeat());

  it('sets verified=false for 500 response', async () => {
    _fetchImpl = jest.fn(() => notOkResponse(500));
    const peer = makePeer({ verified: true });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    const result = await pingPeer(peer);
    expect(result).toBe(false);
  });
});

describe('startFederationHeartbeat / stopFederationHeartbeat', () => {
  it('can be started and stopped without error', () => {
    jest.useFakeTimers();
    const db = buildDb();
    expect(() => startFederationHeartbeat(db)).not.toThrow();
    expect(() => stopFederationHeartbeat()).not.toThrow();
    jest.useRealTimers();
  });

  it('does not start a second timer if already running', () => {
    // ONCEDEN HICBIR IDDIA YOKTU: iki kez baslatilip durduruluyor ve test
    // gecmis sayiliyordu. Cift zamanlayici gercekten kurulsaydi bile test
    // yesil kalirdi. Artik `setInterval` cagri SAYISI olculur.
    // Sahte zamanlayicilar `setInterval`i degistirdigi icin casusluk
    // guvenilmez; bunun yerine Jest'in AKTIF ZAMANLAYICI SAYACI okunur.
    jest.useFakeTimers();
    const db = buildDb();
    try {
      startFederationHeartbeat(db);
      const afterFirst = jest.getTimerCount();
      expect(afterFirst).toBeGreaterThan(0);  // ilk cagri GERCEKTEN kurdu
      startFederationHeartbeat(db);           // no-op olmali
      expect(jest.getTimerCount()).toBe(afterFirst);
    } finally {
      stopFederationHeartbeat();
      jest.useRealTimers();
    }
  });

  it('durdurulduktan SONRA yeniden baslatilabilir', () => {
    // Idempotent koruma, mesru yeniden baslatmayi engellememeli.
    jest.useFakeTimers();
    const db = buildDb();
    try {
      startFederationHeartbeat(db);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      stopFederationHeartbeat();
      expect(jest.getTimerCount()).toBe(0);   // durdurma GERCEKTEN temizler
      startFederationHeartbeat(db);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    } finally {
      stopFederationHeartbeat();
      jest.useRealTimers();
    }
  });
});


describe('heartbeat backpressure and failure visibility', () => {
  afterEach(() => stopFederationHeartbeat());

  it('bounds concurrent peer requests to configured concurrency', async () => {
    const db = buildDb();
    for (let i = 0; i < 8; i++) await db.federation_peers.insert(makePeer({ _id: `p-${i}`, url: `http://peer-${i}.example` }));
    startFederationHeartbeat(db);

    let active = 0;
    let maxActive = 0;
    _fetchImpl = jest.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { ok: true, status: 200 };
    });

    await _runHeartbeatForTest();
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(_fetchImpl).toHaveBeenCalledTimes(8);
  });

  it('keeps secondary offline-state persistence failures visible', async () => {
    const db = buildDb();
    const peer = makePeer({ verified: true });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);
    _fetchImpl = jest.fn(failResponse);
    jest.spyOn(db.federation_peers, 'update').mockRejectedValueOnce(new Error('db down'));
    mockLoggerError.mockClear();

    await expect(pingPeer(peer)).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: peer._id, event: 'federation.heartbeat.persist_offline_failed' }),
      expect.stringContaining('could not be persisted'),
    );
  });
});

describe('cluster heartbeat ownership', () => {
  afterEach(() => stopFederationHeartbeat());

  it('pings a peer only when this worker wins the shared claim', async () => {
    const db = buildDb();
    const peer = makePeer({ _id: 'shared-peer' });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);
    _fetchImpl = jest.fn(okResponse);

    mockHeartbeatClaim.mockResolvedValueOnce(true);
    await _runClaimedHeartbeatForTest();
    expect(_fetchImpl).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatClaim).toHaveBeenCalledWith(
      'jobs:federation-heartbeat:peer:shared-peer',
      expect.objectContaining({ claimedAt: expect.any(Number) }),
      300,
    );

    jest.mocked(_fetchImpl).mockClear();
    mockHeartbeatClaim.mockResolvedValueOnce(false);
    await _runClaimedHeartbeatForTest();
    expect(_fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on shared coordination outage instead of racing verified state', async () => {
    const db = buildDb();
    await db.federation_peers.insert(makePeer({ _id: 'coord-down-peer' }));
    startFederationHeartbeat(db);
    _fetchImpl = jest.fn(okResponse);
    mockHeartbeatClaim.mockRejectedValueOnce(new Error('redis down'));

    await _runClaimedHeartbeatForTest();
    expect(_fetchImpl).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'coord-down-peer', event: 'federation.heartbeat.claim_failed' }),
      expect.stringContaining('coordination unavailable'),
    );
  });
});

// P5 FED-03 — measured in the two-instance lab: the heartbeat signed a form
// the receiving node never verified, so EVERY ping was answered 401 and peers
// were marked unverified. This is the contract that was missing: what the
// heartbeat sends verifies under the receiver's own verifier.
describe('heartbeat signature verifies at the receiving installation', () => {
  afterEach(() => { stopFederationHeartbeat(); mockReceiverPeers.clear(); mockReplay.clear(); });

  async function sentPing(peerUrl = 'https://receiver.example') {
    const db = buildDb();
    _fetchImpl = jest.fn(okResponse);
    const peer = makePeer({ url: peerUrl });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);
    await pingPeer(peer);
    const [url, opts] = jest.mocked(_fetchImpl).mock.calls[0];
    const headers = {
      'x-bridge-rsa-sig': headerFrom(opts, 'x-bridge-rsa-sig'),
      'x-bridge-ts':      headerFrom(opts, 'x-bridge-ts'),
      'x-bridge-keyid':   headerFrom(opts, 'x-bridge-keyid'),
    };
    return { url: String(url), body: String(opts?.body), headers, sender: headerFrom(opts, 'x-bridge-instance-url') };
  }

  it('round trip: the receiver accepts it once, and only as a ping to itself', async () => {
    const { verifyFederationRequestV3 } = jest.requireActual('../lib/httpSignatureV3');
    const { __keys } = jest.requireMock('../lib/federationKeys');
    mockReceiverPeers.set('http://localhost:3001', { _id: 'us', url: 'http://localhost:3001', publicKey: __keys.publicKey });

    const sent = await sentPing();
    expect(sent.url).toBe('https://receiver.example/api/federation/ping');
    expect(JSON.parse(sent.body)).toEqual({ url: 'http://localhost:3001' });
    const ctx = { method: 'POST', path: '/api/federation/ping', target: 'https://receiver.example' };

    await expect(verifyFederationRequestV3(sent.sender, sent.body, sent.headers, ctx)).resolves.toMatchObject({ ok: true, peerId: 'us' });
    // Replayed: refused.
    await expect(verifyFederationRequestV3(sent.sender, sent.body, sent.headers, ctx)).resolves.toMatchObject({ ok: false, reason: 'Replay: signature already used' });
  });

  it('negative control: a receiver at another url refuses it', async () => {
    const { verifyFederationRequestV3 } = jest.requireActual('../lib/httpSignatureV3');
    const { __keys } = jest.requireMock('../lib/federationKeys');
    mockReceiverPeers.set('http://localhost:3001', { _id: 'us', url: 'http://localhost:3001', publicKey: __keys.publicKey });

    const sent = await sentPing();
    const ctx = { method: 'POST', path: '/api/federation/ping', target: 'https://somewhere-else.example' };
    await expect(verifyFederationRequestV3(sent.sender, sent.body, sent.headers, ctx)).resolves.toMatchObject({ ok: false, reason: 'RSA signature invalid' });
  });

  it('no HMAC header is sent (ADR-0006 Faz 3: receivers ignore it)', async () => {
    const db = buildDb();
    _fetchImpl = jest.fn(okResponse);
    const peer = makePeer();
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);
    await pingPeer(peer);
    const [, opts] = jest.mocked(_fetchImpl).mock.calls[0];
    expect(headerFrom(opts, 'x-bridge-sig')).toBeUndefined();
  });

  it('a peer that ANSWERS with a refusal is not "seen": lastSeen is kept, verified drops', async () => {
    const db = buildDb();
    _fetchImpl = jest.fn(() => notOkResponse(401));
    const peer = makePeer({ verified: true, lastSeen: 1234 });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    await expect(pingPeer(peer)).resolves.toBe(false);

    const updated = await requireDoc(db.federation_peers, { _id: peer._id });
    expect(updated.verified).toBe(false);
    expect(updated.lastSeen).toBe(1234);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.heartbeat.peer_refused', status: 401 }),
      expect.any(String),
    );
  });
});
});
