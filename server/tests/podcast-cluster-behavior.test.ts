'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'podcast-cluster-test-secretxxxxx';
process.env.RECORDINGS_DIR = '/tmp/bridge-podcast-cluster-tests';
process.env.INSTANCE_ID = 'node-A';

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
let setFailure: unknown = null;
let deleteFailure: unknown = null;
const mockGetAuthoritative = jest.fn(async (key: string) => shared.has(key) ? shared.get(key) : null);
const mockSetAuthoritative = jest.fn(async (key: string, value: unknown) => {
  if (setFailure !== null) throw setFailure;
  shared.set(key, value);
});
const mockDelAuthoritative = jest.fn(async (key: string) => {
  if (deleteFailure !== null) throw deleteFailure;
  shared.delete(key);
});
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
  verifyToken: (token: string) => token ? { id: token } : null,
}));
jest.mock('../lib/permissions', () => ({
  PERMS: { MANAGE_CHANNELS: 1, MANAGE_SERVER: 2 },
  hasPermission: (p: number, b: number) => (p & b) !== 0,
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
}));
jest.mock('../lib/uploadReferenceSafety', () => ({ hasLiveUploadReference: (...args: unknown[]) => mockHasLiveUploadReference(...args) }));
jest.mock('../lib/ssrfGuard', () => ({ assertUrlIsPublic: (...args: unknown[]) => mockAssertUrlIsPublic(...args) }));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    getAuthoritative: (...args: unknown[]) => mockGetAuthoritative(...args as [string]),
    setAuthoritative: (...args: unknown[]) => mockSetAuthoritative(...args as [string, unknown]),
    delAuthoritative: (...args: unknown[]) => mockDelAuthoritative(...args as [string]),
    withKeyLock: (...args: unknown[]) => mockWithKeyLock(...args as [string, () => unknown]),
  },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

import express from 'express';
import request from 'supertest';
import router from '../routes/podcast';
const db: any = require('../db/loader');

function app() {
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use('/api/podcast', router);
  a.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  return a;
}

function fakeProc(opts: { exitOnKill?: boolean } = {}) {
  const p: any = new EventEmitter();
  p.exitCode = null; p.signalCode = null;
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.kill = jest.fn((sig: string) => {
    p.signalCode = sig;
    if (opts.exitOnKill !== false) queueMicrotask(() => p.emit('exit', 0, sig));
    return true;
  });
  return p;
}

const STATE_PREFIX = 'podcast:recording-state:';
let seq = 0;
async function seedChannel(options: { admin?: boolean; perms?: number } = {}) {
  const n = ++seq;
  const channelId = `pod-cluster-${n}`;
  const serverId = `pod-server-${n}`;
  const userId = `pod-user-${n}`;
  await db.users.insert({ _id: userId, username: userId, displayName: userId, isAdmin: options.admin ?? false });
  await db.servers.insert({ _id: serverId, name: 'Podcast Cluster', ownerId: 'someone-else' });
  await db.channels.insert({ _id: channelId, serverId, name: 'Stage', type: 'stage' });
  mockResolvePermissions.mockResolvedValue(options.perms ?? 1);
  return { channelId, serverId, userId };
}

beforeAll(() => {
  fs.rmSync(process.env.RECORDINGS_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.RECORDINGS_DIR!, { recursive: true });
});
afterAll(() => fs.rmSync(process.env.RECORDINGS_DIR!, { recursive: true, force: true }));

beforeEach(() => {
  db._reset?.();
  jest.clearAllMocks();
  shared.clear();
  lockFailure = null; setFailure = null; deleteFailure = null;
  mockResolvePermissions.mockResolvedValue(1);
  mockHasLiveUploadReference.mockResolvedValue(false);
  mockAssertUrlIsPublic.mockResolvedValue(undefined);
  mockSpawn.mockImplementation(() => fakeProc());
  delete process.env.PODCAST_INPUT_ALLOWLIST;
  delete process.env.MAX_FILE_SIZE_MB;
});

describe('podcast cluster authority', () => {
  test('site admin can manage a channel even when channel permissions resolve to zero', async () => {
    const { channelId, userId } = await seedChannel({ admin: true, perms: 0 });
    const r = await request(app()).patch(`/api/podcast/${channelId}/settings`).set('x-test-user', userId).send({ title: 'Admin Feed' });
    expect(r.status).toBe(200);
    expect(r.body.settings.title).toBe('Admin Feed');
  });

  test('permission resolver failure fails closed for ordinary users', async () => {
    const { channelId, userId } = await seedChannel({ admin: false, perms: 0 });
    mockResolvePermissions.mockRejectedValueOnce(new Error('permission store down'));
    const r = await request(app()).patch(`/api/podcast/${channelId}/settings`).set('x-test-user', userId).send({ title: 'Denied' });
    expect(r.status).toBe(403);
  });

  test('malformed shared recording state is rejected instead of treated as no recording', async () => {
    const { channelId, userId } = await seedChannel();
    shared.set(`${STATE_PREFIX}${channelId}`, { ownerNodeId: '', fileName: '../escape.mp3', startedAt: '1', title: 5, finished: false });
    const r = await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({});
    expect(r.status).toBe(503);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('remote authoritative owner returns an actionable 409 and never starts a second recorder', async () => {
    const { channelId, userId } = await seedChannel();
    shared.set(`${STATE_PREFIX}${channelId}`, { ownerNodeId: 'node-B', fileName: 'remote.mp3', startedAt: Date.now(), title: 'Remote', finished: false });
    const r = await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ownerNodeId: 'node-B' });
    expect(r.body.retryHint).toContain('bridgeNode=node-B');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('coordination outage fails start closed', async () => {
    const { channelId, userId } = await seedChannel();
    lockFailure = new Error('redis unavailable');
    const r = await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({});
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/coordination/i);
  });

  test('synchronous FFmpeg spawn failure returns a bounded 500 without creating shared ownership', async () => {
    const { channelId, userId } = await seedChannel();
    mockSpawn.mockImplementationOnce(() => { throw 'spawn denied'; });
    const r = await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({ title: 'Live' });
    expect(r.status).toBe(500);
    expect(r.body.detail).toBe('spawn denied');
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
  });

  test('allowlisted HTTPS input is SSRF-checked and passed to FFmpeg instead of the silent-source stub', async () => {
    const { channelId, userId } = await seedChannel();
    process.env.PODCAST_INPUT_ALLOWLIST = 'media.example';
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    const r = await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId)
      .send({ title: 'Remote', inputUrl: 'https://media.example/live.m3u8' });
    expect(r.status).toBe(200);
    expect(r.body.stub).toBe(false);
    expect(mockAssertUrlIsPublic).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'media.example' }));
    expect(mockSpawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', 'https://media.example/live.m3u8']), expect.any(Object));
  });

  test('shared-state write failure stops the just-created process and does not leave local ownership', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    setFailure = new Error('authoritative state unavailable');
    const r = await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({});
    expect(r.status).toBe(503);
    await Promise.resolve();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('process error removes authoritative state and cleans unreferenced output', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    const start = await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({});
    expect(start.status).toBe(200);
    const fileName = shared.get(`${STATE_PREFIX}${channelId}`) as any;
    const localPath = path.join(process.env.RECORDINGS_DIR!, fileName.fileName);
    fs.writeFileSync(localPath, Buffer.alloc(2048));
    proc.emit('error', new Error('ffmpeg crashed'));
    await new Promise(resolve => setImmediate(resolve));
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
    expect(fs.existsSync(localPath)).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'podcast.record.process_error' }), expect.any(String));
  });

  test('process-error cleanup failure is observable while local authority is still revoked', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    expect((await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({})).status).toBe(200);
    deleteFailure = new Error('shared delete unavailable');
    proc.emit('error', new Error('ffmpeg crashed'));
    await new Promise(resolve => setImmediate(resolve));
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'podcast.record.error_state_cleanup_failed' }), expect.any(String));
    deleteFailure = null;
  });

  test('lost heartbeat ownership stops FFmpeg and revokes local recording authority', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    let heartbeat: (() => void) | undefined;
    const handle = { unref: jest.fn() };
    const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => void) => {
      heartbeat = fn;
      return handle as any;
    }) as any);
    try {
      expect((await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({})).status).toBe(200);
      const current = shared.get(`${STATE_PREFIX}${channelId}`) as any;
      shared.set(`${STATE_PREFIX}${channelId}`, { ...current, ownerNodeId: 'node-B' });
      heartbeat?.();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'podcast.record.heartbeat_failed' }), expect.any(String));
      const status = await request(app()).get(`/api/podcast/${channelId}/record/status`).set('x-test-user', userId);
      expect(status.body).toMatchObject({ recording: true, localOwner: false, ownerNodeId: 'node-B' });
    } finally {
      intervalSpy.mockRestore();
    }
  });

  test('unexpected process exit marks shared state finished and status exposes ready-to-publish', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    expect((await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({ title: 'Done' })).status).toBe(200);
    proc.emit('exit', 7, null);
    await new Promise(resolve => setImmediate(resolve));
    const state = shared.get(`${STATE_PREFIX}${channelId}`) as any;
    expect(state.finished).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'podcast.record.unexpected_exit', code: 7 }), expect.any(String));
    const status = await request(app()).get(`/api/podcast/${channelId}/record/status`).set('x-test-user', userId);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ recording: false, readyToPublish: true, ownerNodeId: 'node-A', localOwner: true, title: 'Done' });
  });

  test('finished-state write failure is logged instead of becoming an unhandled rejection', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    expect((await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({})).status).toBe(200);
    setFailure = new Error('shared update unavailable');
    proc.emit('exit', 7, null);
    await new Promise(resolve => setImmediate(resolve));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'podcast.record.finish_state_failed' }), expect.any(String));
    setFailure = null;
  });

  test('completed recording can be claimed and published without re-signalling FFmpeg', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    expect((await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({ title: 'Finished' })).status).toBe(200);
    const state = shared.get(`${STATE_PREFIX}${channelId}`) as any;
    const localPath = path.join(process.env.RECORDINGS_DIR!, state.fileName);
    fs.writeFileSync(localPath, Buffer.alloc(2048));
    proc.emit('exit', 0, null);
    await new Promise(resolve => setImmediate(resolve));
    const stop = await request(app()).post(`/api/podcast/${channelId}/record/stop`).set('x-test-user', userId).send({});
    expect(stop.status).toBe(200);
    expect(stop.body.episode.title).toBe('Finished');
    expect(proc.kill).not.toHaveBeenCalled();
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
    fs.unlinkSync(localPath);
  });

  test('completed-recording TTL retires shared state and unreferenced output', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    const nativeSetTimeout = global.setTimeout;
    let cleanup: (() => void) | undefined;
    const cleanupHandle = { unref: jest.fn() };
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 3_600_000) {
        cleanup = () => fn(...args);
        return cleanupHandle as any;
      }
      return nativeSetTimeout(fn, delay, ...args);
    }) as any);
    try {
      expect((await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({})).status).toBe(200);
      const state = shared.get(`${STATE_PREFIX}${channelId}`) as any;
      const localPath = path.join(process.env.RECORDINGS_DIR!, state.fileName);
      fs.writeFileSync(localPath, Buffer.alloc(2048));
      proc.emit('exit', 0, null);
      await new Promise(resolve => setImmediate(resolve));
      expect(cleanup).toBeDefined();
      cleanup?.();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
      expect(fs.existsSync(localPath)).toBe(false);
      expect(cleanupHandle.unref).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test('status reports remote ownership without claiming it is local', async () => {
    const { channelId, userId } = await seedChannel();
    shared.set(`${STATE_PREFIX}${channelId}`, { ownerNodeId: 'node-C', fileName: 'remote.mp3', startedAt: Date.now() - 5000, title: 'Remote', finished: false });
    const r = await request(app()).get(`/api/podcast/${channelId}/record/status`).set('x-test-user', userId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ recording: true, readyToPublish: false, ownerNodeId: 'node-C', localOwner: false });
    expect(r.body.elapsedSecs).toBeGreaterThanOrEqual(0);
  });

  test('status coordination failure is a 503 rather than a false no-recording response', async () => {
    const { channelId, userId } = await seedChannel();
    lockFailure = 'lock authority gone';
    const r = await request(app()).get(`/api/podcast/${channelId}/record/status`).set('x-test-user', userId);
    expect(r.status).toBe(503);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'podcast.record.status_coordination_failed' }), expect.any(String));
  });

  test('stop on another node returns owner routing information and does not accept client fallback bytes', async () => {
    const { channelId, userId } = await seedChannel();
    shared.set(`${STATE_PREFIX}${channelId}`, { ownerNodeId: 'node-B', fileName: 'remote.mp3', startedAt: Date.now(), title: 'Remote', finished: false });
    const r = await request(app()).post(`/api/podcast/${channelId}/record/stop`).set('x-test-user', userId)
      .send({ audioFile: Buffer.alloc(2048).toString('base64') });
    expect(r.status).toBe(409);
    expect(r.body.ownerNodeId).toBe('node-B');
    expect(r.body.retryHint).toContain('bridgeNode=node-B');
  });

  test('stale local shared ownership with no process is deleted and returns no-active-recording', async () => {
    const { channelId, userId } = await seedChannel();
    shared.set(`${STATE_PREFIX}${channelId}`, { ownerNodeId: 'node-A', fileName: 'stale.mp3', startedAt: Date.now(), title: 'Stale', finished: false });
    const r = await request(app()).post(`/api/podcast/${channelId}/record/stop`).set('x-test-user', userId).send({});
    expect(r.status).toBe(404);
    expect(shared.has(`${STATE_PREFIX}${channelId}`)).toBe(false);
  });

  test.each([
    ['zero', 0], ['future', Date.now() + 120_000], ['fractional', 1.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('client recording rejects invalid startedAt (%s)', async (_name, startedAt) => {
    const { channelId, userId } = await seedChannel();
    const r = await request(app()).post(`/api/podcast/${channelId}/record/stop`).set('x-test-user', userId)
      .send({ audioFile: Buffer.alloc(2048).toString('base64'), startedAt });
    expect(r.status).toBe(400);
  });

  test('missing generated output file returns 500 instead of publishing a broken episode', async () => {
    const { channelId, userId } = await seedChannel();
    const proc = fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    expect((await request(app()).post(`/api/podcast/${channelId}/record/start`).set('x-test-user', userId).send({})).status).toBe(200);
    const r = await request(app()).post(`/api/podcast/${channelId}/record/stop`).set('x-test-user', userId).send({});
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/could not be created/i);
  });

  test('stop coordination failure is fail-closed', async () => {
    const { channelId, userId } = await seedChannel();
    lockFailure = new Error('redis lock down');
    const r = await request(app()).post(`/api/podcast/${channelId}/record/stop`).set('x-test-user', userId).send({});
    expect(r.status).toBe(503);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'podcast.record.stop_coordination_failed' }), expect.any(String));
  });
});
