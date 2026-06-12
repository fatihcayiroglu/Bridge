// server/tests/jobs-federationHeartbeat.test.ts
// federationHeartbeat job — unit tests (network mocked)
process.env.NODE_ENV = 'test';
process.env.FEDERATION_SECRET = 'test-secret';
process.env.INSTANCE_URL = 'http://localhost:3001';
process.env.AP_ENCRYPTION_KEY = 'b'.repeat(64);

jest.mock('../lib/httpSignature', () => {
  const crypto = require('crypto');
  return {
    buildFederationAuthHeaders: jest.fn(async (body: object) => {
      const ts = String(Date.now());
      const payload = ts + JSON.stringify(body);
      const sig = crypto.createHmac('sha256', process.env.FEDERATION_SECRET)
        .update(payload).digest('hex');
      return {
        'x-bridge-ts':        ts,
        'x-bridge-sig':       sig,
        'X-Bridge-Signature': 'RSA-SHA256 keyId="http://localhost:3001/api/federation/key",signature="mock"',
      };
    }),
    verifyFederationRequest: jest.fn(),
  };
});

import { createMockDb } from './helpers/mockDb';
import { v4 as uuidv4 } from 'uuid';

// ── Build a minimal mock DB with federation_peers ─────────────────
function buildDb() {
  return createMockDb();
}

let _fetchImpl;
global.fetch = jest.fn((...args) => _fetchImpl(...args));

const { startFederationHeartbeat, stopFederationHeartbeat, pingPeer } =
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

// ── Tests ─────────────────────────────────────────────────────────
// Not: pingPeer closure üzerinden _db'yi okur (this değil).
// startFederationHeartbeat(db) çağrısı _db'yi set eder — her testte önce o çağrılır.

describe('pingPeer — successful response', () => {
  let db;
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
    const [url, opts] = _fetchImpl.mock.calls[0];
    expect(url).toContain('/api/federation/ping');
    expect(opts.method).toBe('POST');
  });

  it('sets verified=true and updates lastSeen on success', async () => {
    const peer = makePeer({ lastSeen: 0, verified: false });
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    _fetchImpl = jest.fn(okResponse);
    const result = await pingPeer(peer);
    expect(result).toBe(true);

    const updated = await db.federation_peers.findOne({ _id: peer._id });
    expect(updated.verified).toBe(true);
    expect(updated.lastSeen).toBeGreaterThan(0);
  });

  it('includes x-bridge-sig and x-bridge-ts headers', async () => {
    const peer = makePeer();
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    _fetchImpl = jest.fn(okResponse);
    await pingPeer(peer);

    const [, opts] = _fetchImpl.mock.calls[0];
    expect(opts.headers['x-bridge-sig']).toBeDefined();
    expect(opts.headers['x-bridge-ts']).toBeDefined();
  });
});

describe('pingPeer — network failure', () => {
  let db;
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
  let db;
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
    jest.useFakeTimers();
    const db = buildDb();
    startFederationHeartbeat(db);
    startFederationHeartbeat(db); // second call should be no-op
    stopFederationHeartbeat();
    jest.useRealTimers();
  });
});

describe('HMAC signature', () => {
  afterEach(() => stopFederationHeartbeat());

  it('generates a non-empty signature', async () => {
    const db = buildDb();
    _fetchImpl = jest.fn(okResponse);
    const peer = makePeer();
    await db.federation_peers.insert(peer);
    startFederationHeartbeat(db);

    await pingPeer(peer);

    const [, opts] = _fetchImpl.mock.calls[0];
    expect(opts.headers['x-bridge-sig'].length).toBeGreaterThan(10);
  });
});
