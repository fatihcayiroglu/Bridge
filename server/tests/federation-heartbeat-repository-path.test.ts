// server/tests/federation-heartbeat-repository-path.test.ts
//
// jobs/federationHeartbeat.ts pings every registered federation peer every
// five minutes and records which ones answered. Every existing test injects a
// hand-written `DbHandle`; production never does — it reads and writes peers
// through the Federation repository. That path, the scheduler that starts it
// and the "a task was rejected" accounting had never run. Here:
//   - with no injected handle, peers are read and written through the real
//     Federation repository (on the mock DB): an answering peer is marked
//     seen, a refusing one loses `verified` but keeps its last sighting, an
//     unreachable one loses `verified`;
//   - when the offline state cannot be persisted through the repository, the
//     failure is logged and the heartbeat goes on;
//   - a peer whose request cannot be SIGNED locally is a local fault, not the
//     peer being offline: its row is untouched, the task is counted as
//     rejected and logged, and the other peers are still pinged;
//   - no peers → no network traffic;
//   - the scheduler waits 30 s, then runs a cluster-claimed heartbeat every
//     5 minutes through the repository; stop() cancels a pending start and a
//     running interval alike.
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'http://localhost:3001';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const mockSign = jest.fn(async (..._args: unknown[]) => ({ 'X-Bridge-Signature': 'sig' }));
jest.mock('../lib/httpSignatureV3', () => ({ signPeerRequest: (...args: unknown[]) => mockSign(...args) }));

const mockFetch = jest.fn();
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => mockFetch(...args) }));

const mockClaim = jest.fn(async (..._args: unknown[]) => true);
jest.mock('../lib/redisAdapter', () => ({ cache: { setIfAbsentAuthoritative: (...args: unknown[]) => mockClaim(...args) } }));

import db from '../db/loader';
import { Federation } from '../db/repositories';
import {
  _runClaimedHeartbeatForTest,
  _runHeartbeatForTest,
  startFederationHeartbeat,
  stopFederationHeartbeat,
} from '../jobs/federationHeartbeat';

const peerRow = async (id: string) => (await db.federationPeers.findOne({ _id: id })) as Record<string, unknown> | null;
const pinged = () => mockFetch.mock.calls.map(c => String(c[0]));
const warned = (event: string) => mockLogger.warn.mock.calls.filter(c => (c[0] as { event?: string })?.event === event);

beforeEach(async () => {
  (db as unknown as { _reset?: () => void })._reset?.();
  stopFederationHeartbeat();
  jest.clearAllMocks();
  mockSign.mockImplementation(async () => ({ 'X-Bridge-Signature': 'sig' }));
  mockClaim.mockImplementation(async () => true);
});
afterEach(() => {
  stopFederationHeartbeat();
  jest.useRealTimers();
});

async function seedPeers() {
  await db.federationPeers.insert({ _id: 'up', url: 'https://up.example', verified: false, lastSeen: 100 });
  await db.federationPeers.insert({ _id: 'refuses', url: 'https://refuses.example/', verified: true, lastSeen: 200 });
  await db.federationPeers.insert({ _id: 'down', url: 'https://down.example', verified: true, lastSeen: 300 });
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('https://up.example')) return { ok: true, status: 200 };
    if (url.startsWith('https://refuses.example')) return { ok: false, status: 401 };
    throw new Error('ECONNREFUSED');
  });
}

describe('production path: peers through the Federation repository', () => {
  it('records an answering peer as seen, a refusing one as unverified with its old sighting, an unreachable one as unverified', async () => {
    await seedPeers();
    const before = Date.now();
    await _runHeartbeatForTest();

    expect(pinged().sort()).toEqual([
      'https://down.example/api/federation/ping',
      'https://refuses.example/api/federation/ping',
      'https://up.example/api/federation/ping',
    ]);
    const up = await peerRow('up');
    expect(up).toMatchObject({ verified: true });
    expect(up!.lastSeen as number).toBeGreaterThanOrEqual(before);
    expect(await peerRow('refuses')).toMatchObject({ verified: false, lastSeen: 200 });
    expect(await peerRow('down')).toMatchObject({ verified: false, lastSeen: 300 });
    expect(mockLogger.info).toHaveBeenCalledWith({ online: 1, rejected: 0, total: 3 }, expect.any(String));
  });

  it('an offline state that cannot be persisted is logged, and the other peers are still recorded', async () => {
    await seedPeers();
    // Only the unreachable peer's offline write fails; the others go through.
    jest.spyOn(Federation, 'updatePeer').mockImplementation(async (id: string, modifier: Record<string, unknown>) => {
      if (id === 'down') throw new Error('db down');
      return db.federationPeers.update({ _id: id }, modifier);
    });

    await _runHeartbeatForTest();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'down', event: 'federation.heartbeat.persist_offline_failed' }),
      expect.any(String),
    );
    expect(await peerRow('down')).toMatchObject({ verified: true, lastSeen: 300 });
    expect(await peerRow('up')).toMatchObject({ verified: true });
    expect(await peerRow('refuses')).toMatchObject({ verified: false });
  });

  it('a peer whose request cannot be signed is a local fault: row untouched, task counted as rejected, others still pinged', async () => {
    await seedPeers();
    mockSign.mockImplementation(async (...args: unknown[]) => {
      const target = (args[0] as { target: string }).target;
      if (target.startsWith('https://down.example')) throw new Error('signing key unavailable');
      return { 'X-Bridge-Signature': 'sig' };
    });

    await _runHeartbeatForTest();
    expect(pinged()).not.toContain('https://down.example/api/federation/ping');
    expect(await peerRow('down')).toMatchObject({ verified: true, lastSeen: 300 });
    expect(warned('federation.heartbeat.peer_rejected')).toHaveLength(1);
    expect(warned('federation.heartbeat.peer_rejected')[0]![0]).toMatchObject({ peerId: 'down' });
    expect(mockLogger.info).toHaveBeenCalledWith({ online: 1, rejected: 1, total: 3 }, expect.any(String));
  });

  it('no registered peers: no network traffic and no summary', async () => {
    await _runHeartbeatForTest();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({ total: expect.any(Number) }), expect.any(String));
  });
});

describe('scheduler', () => {
  it('waits 30 s, then runs a claimed heartbeat through the repository, then every 5 minutes', async () => {
    jest.useFakeTimers();
    await db.federationPeers.insert({ _id: 'up', url: 'https://up.example', verified: false, lastSeen: 1 });
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    startFederationHeartbeat();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockClaim).toHaveBeenCalledWith('jobs:federation-heartbeat:peer:up', expect.any(Object), 300);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await peerRow('up')).toMatchObject({ verified: true });

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels a start that has not fired yet, and a running interval', async () => {
    jest.useFakeTimers();
    await db.federationPeers.insert({ _id: 'up', url: 'https://up.example', verified: false, lastSeen: 1 });
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    startFederationHeartbeat();
    stopFederationHeartbeat();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).not.toHaveBeenCalled();

    startFederationHeartbeat();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    stopFederationHeartbeat();
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a claimed heartbeat pings only peers this worker wins', async () => {
    await seedPeers();
    mockClaim.mockImplementation(async (...args: unknown[]) => String(args[0]).endsWith(':up'));
    await _runClaimedHeartbeatForTest();
    expect(pinged()).toEqual(['https://up.example/api/federation/ping']);
  });
});
