// server/tests/podcast-recording-lifecycle-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PODCAST KAYDI — SAHİPLİK KİRASI, SÜREÇ OLAYLARI VE GECİKMELİ TEMİZLİK
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/podcast-cluster-behavior.test.ts` başlatma/durdurma İSTEKLERİNİ
// kapsar. Bu tamamlayıcı takım isteklerden SONRA çalışan zamanlayıcı ve süreç
// olaylarını ölçer — split-brain'in gerçekte oluştuğu yer orasıdır:
//
//   · KİRA YENİLEME — kayıt sürerken sahiplik kirası periyodik olarak
//     tazelenmelidir; yenilenmezse kira düşer ve ikinci bir düğüm aynı kanalı
//     kaydetmeye başlar.
//   · FAIL-CLOSED — kira BAŞKASINA geçmişse yerel FFmpeg DURDURULMALIDIR.
//     Çalışmaya devam etmek iki yazıcı demektir: iki dosya, bozuk bölüm.
//   · SÜREÇ OLAYLARI — `error` yerel ve paylaşılan durumu temizlemeli, `exit`
//     paylaşılan durumu "bitti" işaretleyip gecikmeli temizliği kurmalıdır.
//   · GECİKMELİ TEMİZLİK — zamanlayıcı ateşlendiğinde dosya YALNIZCA hâlâ
//     hiçbir mesajdan referans verilmiyorsa silinmelidir.
//
// Zamanlayıcılar sahte saatle değil, KURULUM ANINDA YAKALANIP elle
// çağrılarak sürülür: HTTP istekleri gerçek zamanlayıcılarla çalışmaya devam
// eder ve zamanlama yarışı kalmaz.

'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'podcast-lifecycle-test-secretxxx';
process.env.RECORDINGS_DIR = '/tmp/bridge-podcast-lifecycle-tests';
process.env.INSTANCE_ID = 'node-A';
process.env.COMPLETED_RECORDING_TTL_MS = '60000';

import { present } from './helpers/narrow';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

const mockResolvePermissions = jest.fn();
const mockHasLiveUploadReference = jest.fn();
const mockAssertUrlIsPublic = jest.fn();
const mockSpawn = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const shared = new Map<string, unknown>();
let lockFailure: unknown = null;
const mockGetAuthoritative = jest.fn(async (key: string) => (shared.has(key) ? shared.get(key) : null));
// UCUNCU parametre TTL'dir ve urun onu GECIYOR; ikizin imzasi eksikti, bu
// yuzden cagri kaydi iki elemanli tipleniyor ve TTL sinanamiyordu.
const mockSetAuthoritative = jest.fn(async (key: string, value: unknown, _ttlSeconds?: number) => { shared.set(key, value); });
const mockDelAuthoritative = jest.fn(async (key: string) => { shared.delete(key); });
const mockWithKeyLock = jest.fn(async (_key: string, fn: () => unknown | Promise<unknown>) => {
  if (lockFailure !== null) throw lockFailure;
  return await fn();
});

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: String(id), username: String(id) };
    return next();
  },
  verifyToken: (token: string) => (token ? { id: token } : null),
}));
jest.mock('../lib/permissions', () => ({
  PERMS: { MANAGE_CHANNELS: 1, MANAGE_SERVER: 2 },
  hasPermission: (p: number, b: number) => (p & b) !== 0,
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
}));
jest.mock('../lib/uploadReferenceSafety', () => ({
  hasLiveUploadReference: (...args: unknown[]) => mockHasLiveUploadReference(...args),
}));
jest.mock('../lib/ssrfGuard', () => ({ assertUrlIsPublic: (...args: unknown[]) => mockAssertUrlIsPublic(...args) }));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    getAuthoritative: (...a: unknown[]) => mockGetAuthoritative(...a as [string]),
    setAuthoritative: (...a: unknown[]) => mockSetAuthoritative(...a as [string, unknown]),
    delAuthoritative: (...a: unknown[]) => mockDelAuthoritative(...a as [string]),
    withKeyLock: (...a: unknown[]) => mockWithKeyLock(...a as [string, () => unknown]),
  },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

import express from 'express';
import request from 'supertest';
import router from '../routes/podcast';
const db: any = require('../db/loader');

const STATE_PREFIX = 'podcast:recording-state:';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR!;

function app() {
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use('/api/podcast', router);
  a.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  return a;
}

// ── Zamanlayıcı yakalama ────────────────────────────────────────────────────
// Gerçek zamanlayıcılar KORUNUR (supertest onlara güvenir); geri çağırmalar
// yalnızca kaydedilir, böylece 30 sn / 1 saat beklemeden elle sürülebilirler.
const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;
type Captured = { fn: (...args: unknown[]) => void; ms: number };
let intervals: Captured[] = [];
let timeouts: Captured[] = [];

function flush(times = 4): Promise<void> {
  return new Promise(resolve => {
    let n = 0;
    const tick = () => { n += 1; if (n >= times) resolve(); else realSetTimeout(tick, 0); };
    realSetTimeout(tick, 0);
  });
}

/** Polls for a captured timer rather than guessing how many turns a request needs. */
async function awaitCapturedTimeout(ms: number, tries = 200): Promise<Captured> {
  for (let i = 0; i < tries; i += 1) {
    const found = timeouts.find(t => t.ms === ms);
    if (found) return found;
    await new Promise(resolve => realSetTimeout(resolve, 10));
  }
  throw new Error(`no captured setTimeout(${ms}) after ${tries} polls`);
}

function fakeProc(opts: { exitOnKill?: boolean } = {}) {
  const p: any = new EventEmitter();
  p.exitCode = null; p.signalCode = null;
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.kill = jest.fn((sig: string) => {
    p.signalCode = sig;
    if (opts.exitOnKill !== false) queueMicrotask(() => { p.exitCode = 0; p.emit('exit', 0, sig); });
    return true;
  });
  p.finishExit = (code: number, signal: string | null = null) => {
    p.exitCode = code; p.signalCode = signal;
    p.emit('exit', code, signal);
  };
  return p;
}

let seq = 0;
async function seedChannel() {
  const n = ++seq;
  const channelId = `pod-life-${n}`;
  const serverId = `pod-life-server-${n}`;
  const userId = `pod-life-user-${n}`;
  await db.users.insert({ _id: userId, username: userId, displayName: userId, isAdmin: false });
  await db.servers.insert({ _id: serverId, name: 'Lifecycle', ownerId: 'someone-else' });
  await db.channels.insert({ _id: channelId, serverId, name: 'Stage', type: 'stage' });
  mockResolvePermissions.mockResolvedValue(1);
  return { channelId, serverId, userId };
}

/** Starts a recording and returns the process plus the captured heartbeat. */
async function startRecording(proc = fakeProc()) {
  const { channelId, userId } = await seedChannel();
  mockSpawn.mockReturnValueOnce(proc);
  const before = intervals.length;
  const r = await request(app()).post(`/api/podcast/${channelId}/record/start`)
    .set('x-test-user', userId).send({ title: 'Lifecycle' });
  expect(r.status).toBe(200);
  const heartbeat = intervals[before];
  expect(heartbeat).toBeDefined();
  const state = shared.get(`${STATE_PREFIX}${channelId}`) as any;
  return { channelId, userId, proc, heartbeat: heartbeat!, fileName: state.fileName as string };
}

beforeAll(() => {
  fs.rmSync(RECORDINGS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
});
afterAll(() => fs.rmSync(RECORDINGS_DIR, { recursive: true, force: true }));

beforeEach(() => {
  db._reset?.();
  jest.clearAllMocks();
  shared.clear();
  lockFailure = null;
  intervals = [];
  timeouts = [];
  jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any, ...rest: any[]) => {
    intervals.push({ fn, ms });
    return realSetInterval(fn, ms, ...rest);
  }) as never);
  jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any, ms: any, ...rest: any[]) => {
    timeouts.push({ fn, ms });
    return realSetTimeout(fn, ms, ...rest);
  }) as never);
  mockResolvePermissions.mockResolvedValue(1);
  mockHasLiveUploadReference.mockResolvedValue(false);
  mockAssertUrlIsPublic.mockResolvedValue(undefined);
  // `clearAllMocks()` clears recorded calls but NOT queued `...Once` values.
  // A leftover queued process would be handed to the NEXT test's recording and
  // silently desynchronise its process handle from the one under test.
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => fakeProc());
  delete process.env.PODCAST_INPUT_ALLOWLIST;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ownership lease heartbeat', () => {
  it('renews the lease while the local recorder still owns the channel', async () => {
    const { channelId, heartbeat, fileName } = await startRecording();
    expect(heartbeat.ms).toBe(30_000);

    mockSetAuthoritative.mockClear();
    heartbeat.fn();
    await flush();

    expect(mockSetAuthoritative).toHaveBeenCalledWith(
      `${STATE_PREFIX}${channelId}`,
      expect.objectContaining({ ownerNodeId: 'node-A', fileName, finished: false }),
      90,
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('does nothing once the recorder has finished', async () => {
    const { proc, heartbeat } = await startRecording();
    proc.finishExit(0, 'SIGTERM');
    await flush();

    mockSetAuthoritative.mockClear();
    mockGetAuthoritative.mockClear();
    heartbeat.fn();
    await flush();

    // A finished recorder must not keep renewing a lease it no longer needs.
    expect(mockGetAuthoritative).not.toHaveBeenCalled();
    expect(mockSetAuthoritative).not.toHaveBeenCalled();
  });

  const lostLeaseCases: Array<{ name: string; mutate: (channelId: string, fileName: string) => void }> = [
    {
      name: 'the lease was taken over by another node',
      mutate: (channelId, fileName) => shared.set(`${STATE_PREFIX}${channelId}`, {
        ownerNodeId: 'node-B', fileName, startedAt: Date.now(), title: 'Stolen', finished: false,
      }),
    },
    {
      name: 'the same node is recording a different file',
      mutate: (channelId) => shared.set(`${STATE_PREFIX}${channelId}`, {
        ownerNodeId: 'node-A', fileName: 'someone_elses.mp3', startedAt: Date.now(), title: 'Other', finished: false,
      }),
    },
    {
      name: 'the shared lease expired entirely',
      mutate: (channelId) => shared.delete(`${STATE_PREFIX}${channelId}`),
    },
  ];

  for (const { name, mutate } of lostLeaseCases) {
    it(`stops the local FFmpeg fail-closed when ${name}`, async () => {
      const { channelId, proc, heartbeat, fileName } = await startRecording();
      mutate(channelId, fileName);

      heartbeat.fn();
      await flush(6);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'podcast.record.heartbeat_failed' }), expect.any(String));
      // The orphaned output is offered for cleanup under its canonical key.
      expect(mockHasLiveUploadReference.mock.calls.map(call => call[1]))
        .toContain(`uploads/recordings/${fileName}`);
    });
  }

  it('a coordination outage during the heartbeat also stops the recorder', async () => {
    const { proc, heartbeat } = await startRecording();
    lockFailure = new Error('redis unavailable');

    heartbeat.fn();
    await flush(6);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'podcast.record.heartbeat_failed' }), expect.any(String));
  });

  it('a second recording on the same channel is not stopped by the first heartbeat', async () => {
    const first = await startRecording();
    // Simulate the local map already holding a different recorder for the
    // channel (restart/replacement): the stale heartbeat must not kill it.
    const replacement = fakeProc();
    shared.delete(`${STATE_PREFIX}${first.channelId}`);
    await request(app()).post(`/api/podcast/${first.channelId}/record/stop`)
      .set('x-test-user', first.userId).send({});
    mockSpawn.mockReturnValueOnce(replacement);
    await request(app()).post(`/api/podcast/${first.channelId}/record/start`)
      .set('x-test-user', first.userId).send({ title: 'Second' });

    replacement.kill.mockClear();
    first.heartbeat.fn();
    await flush(6);

    expect(replacement.kill).not.toHaveBeenCalled();
  });
});

describe('FFmpeg process events', () => {
  it('a process error clears local and shared state so the channel is recordable again', async () => {
    const { channelId, userId, proc, fileName } = await startRecording();

    proc.emit('error', new Error('ffmpeg pipe broke'));
    await flush(6);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'podcast.record.process_error' }), expect.any(String));
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
    expect(mockHasLiveUploadReference.mock.calls.map(call => call[1]))
      .toContain(`uploads/recordings/${fileName}`);

    const replacement = fakeProc();
    mockSpawn.mockReturnValueOnce(replacement);
    const restart = await request(app()).post(`/api/podcast/${channelId}/record/start`)
      .set('x-test-user', userId).send({ title: 'Retry' });
    expect(restart.status).toBe(200);
  });

  it('an error arriving after a clean exit also clears the pending cleanup timer', async () => {
    const { channelId, proc } = await startRecording();
    proc.finishExit(0, 'SIGTERM');
    await flush();
    // The exit scheduled a delayed cleanup; the later error must cancel it
    // rather than leaving a timer pointed at a released recording.
    expect(timeouts.some(t => t.ms === 60_000)).toBe(true);

    proc.emit('error', new Error('late stream error'));
    await flush(6);
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
  });

  it('a clean exit marks the shared state finished and keeps it for the publish window', async () => {
    const { channelId, proc, fileName } = await startRecording();

    proc.finishExit(0, 'SIGTERM');
    await flush();

    expect(shared.get(`${STATE_PREFIX}${channelId}`)).toMatchObject({
      ownerNodeId: 'node-A', fileName, finished: true,
    });
    // A finished recording keeps a long TTL so the operator can still publish.
    // Ucuncu arguman TTL'dir; ikizin imzasi onu tasimali ki cagri kaydi
    // uc elemanli olsun.
    const lastWrite = present(mockSetAuthoritative.mock.calls.at(-1), 'son yazma');
    expect(lastWrite[2]).toBeGreaterThan(90);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'podcast.record.unexpected_exit' }), expect.any(String));
  });

  it('a crash exit is logged as unexpected', async () => {
    const { proc } = await startRecording();
    proc.finishExit(1, null);
    await flush();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'podcast.record.unexpected_exit', code: 1 }), expect.any(String));
  });

  it('an exit does not overwrite shared state that another node already owns', async () => {
    const { channelId, proc, fileName } = await startRecording();
    shared.set(`${STATE_PREFIX}${channelId}`, {
      ownerNodeId: 'node-B', fileName, startedAt: Date.now(), title: 'Remote', finished: false,
    });

    proc.finishExit(0, 'SIGTERM');
    await flush();

    expect(shared.get(`${STATE_PREFIX}${channelId}`)).toMatchObject({
      ownerNodeId: 'node-B', finished: false,
    });
  });

  it('a repeated exit re-arms the cleanup timer instead of stacking two', async () => {
    const { proc } = await startRecording();
    proc.finishExit(0, 'SIGTERM');
    await flush();
    const first = timeouts.filter(t => t.ms === 60_000).length;

    proc.emit('exit', 0, 'SIGTERM');
    await flush();
    const second = timeouts.filter(t => t.ms === 60_000).length;

    expect(second).toBe(first + 1);
  });
});

describe('delayed cleanup of a completed recording', () => {
  async function completedRecording() {
    const started = await startRecording();
    started.proc.finishExit(0, 'SIGTERM');
    await flush();
    const cleanup = timeouts.filter(t => t.ms === 60_000).at(-1);
    expect(cleanup).toBeDefined();
    fs.writeFileSync(path.join(RECORDINGS_DIR, started.fileName), Buffer.alloc(2048, 1));
    return { ...started, cleanup: cleanup! };
  }

  it('releases the shared slot and deletes an unreferenced recording', async () => {
    const { channelId, fileName, cleanup } = await completedRecording();
    mockHasLiveUploadReference.mockResolvedValue(false);

    cleanup.fn();
    await flush(6);

    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
    expect(fs.existsSync(path.join(RECORDINGS_DIR, fileName))).toBe(false);
  });

  it('keeps a recording that a live message still references', async () => {
    const { channelId, fileName, cleanup } = await completedRecording();
    mockHasLiveUploadReference.mockResolvedValue(true);

    cleanup.fn();
    await flush(6);

    expect(fs.existsSync(path.join(RECORDINGS_DIR, fileName))).toBe(true);
    // The coordination slot is still released; only the bytes are preserved.
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
  });

  it('keeps the file when the reference lookup itself fails', async () => {
    const { fileName, cleanup } = await completedRecording();
    mockHasLiveUploadReference.mockRejectedValue(new Error('reference index offline'));

    cleanup.fn();
    await flush(6);

    // Fail-closed: a dangling row is recoverable, deleted audio is not.
    expect(fs.existsSync(path.join(RECORDINGS_DIR, fileName))).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'podcast.recording_cleanup_blocked' }), expect.any(String));
  });

  it('does nothing when a newer recording has already taken the channel', async () => {
    const { channelId, userId, fileName, cleanup } = await completedRecording();
    // Publishing releases the completed slot; a new recording then owns it.
    await request(app()).post(`/api/podcast/${channelId}/record/stop`)
      .set('x-test-user', userId).send({});
    mockSpawn.mockReturnValueOnce(fakeProc());
    const restart = await request(app()).post(`/api/podcast/${channelId}/record/start`)
      .set('x-test-user', userId).send({ title: 'Newer' });
    expect(restart.status).toBe(200);
    mockHasLiveUploadReference.mockClear();

    cleanup.fn();
    await flush(6);

    // The stale timer must not delete the NEW recording's coordination state,
    // and must not offer the previous file for deletion behind its back.
    expect(shared.get(`${STATE_PREFIX}${channelId}`)).toMatchObject({ title: 'Newer' });
    expect(mockHasLiveUploadReference).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(RECORDINGS_DIR, fileName))).toBe(true);
  });

  it('a shared-state cleanup failure is logged without throwing out of the timer', async () => {
    const { cleanup } = await completedRecording();
    lockFailure = new Error('redis unavailable');

    expect(() => cleanup.fn()).not.toThrow();
    await flush(6);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'podcast.record.shared_cleanup_failed' }), expect.any(String));
  });
});

describe('stopping a stubborn FFmpeg process', () => {
  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const stubborn = fakeProc({ exitOnKill: false });
    const { channelId, userId } = await startRecording(stubborn);

    // `.then()` is what actually dispatches a superagent request; without it
    // the stop would not begin until the assertions below already ran.
    const pending = request(app()).post(`/api/podcast/${channelId}/record/stop`)
      .set('x-test-user', userId).send({}).then(r => r);

    // Drive the two escalation waits without spending 7 real seconds.
    const term = await awaitCapturedTimeout(5_000);
    expect(stubborn.kill).toHaveBeenCalledWith('SIGTERM');
    term.fn();
    const kill = await awaitCapturedTimeout(2_000);
    expect(stubborn.kill).toHaveBeenCalledWith('SIGKILL');
    kill.fn();

    const res = await pending;
    // No audio was produced, so the episode cannot be created — but the stop
    // itself completed rather than hanging on a process that ignores signals.
    expect([422, 500]).toContain(res.status);
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
  });

  it('an already-exited process is not signalled again', async () => {
    const { channelId, userId, proc } = await startRecording();
    proc.finishExit(0, 'SIGTERM');
    await flush();
    proc.kill.mockClear();

    await request(app()).post(`/api/podcast/${channelId}/record/stop`)
      .set('x-test-user', userId).send({});

    expect(proc.kill).not.toHaveBeenCalled();
  });
});
