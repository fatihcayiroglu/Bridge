'use strict';

process.env.NODE_ENV = 'test';

import { createMockDb, makeChannel, makeMessage } from './helpers/mockDb';
let db = createMockDb();

jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

const mockGetFollowers = jest.fn();
const mockPersistCrosspost = jest.fn();
const mockFollowChannel = jest.fn();
const mockUnfollowChannel = jest.fn();
jest.mock('../db/repositories/AnnouncementRepository', () => ({
  Announcements: {
    getFollowers: (...args: unknown[]) => mockGetFollowers(...args),
    persistCrosspost: (...args: unknown[]) => mockPersistCrosspost(...args),
    followChannel: (...args: unknown[]) => mockFollowChannel(...args),
    unfollowChannel: (...args: unknown[]) => mockUnfollowChannel(...args),
  },
}));

const mockResolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => ({
  PERMS: {
    VIEW_CHANNELS: 1 << 0,
    MANAGE_CHANNELS: 1 << 1,
    SEND_MESSAGES: 1 << 8,
    MANAGE_MESSAGES: 1 << 9,
    MANAGE_WEBHOOKS: 1 << 24,
    ADMINISTRATOR: 1 << 30,
  },
  hasPermission: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: () => void) => {
    req.user = { id: String(req.headers['x-test-user'] ?? 'publisher'), displayName: 'Publisher' };
    next();
  },
  castAuthed: (req: any) => ({ user: req.user }),
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: { api: () => (_req: any, _res: any, next: () => void) => next() },
}));

import express from 'express';
import request from 'supertest';
import { router, setIo } from '../routes/announcement';

const SRC_SERVER = 'srv-source';
const SRC_CHANNEL = 'ch-announcement';
const TARGET_SERVER = 'srv-target';
const TARGET_CHANNEL = 'ch-target';
const PUBLISHER = 'publisher';
const MESSAGE_ID = 'msg-source';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/channels', router);
  return a;
}

function allowAll() {
  mockResolvePermissions.mockResolvedValue(0x7fffffff);
}

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  jest.clearAllMocks();
  allowAll();
  setIo(null as any);

  await db.channels.insert(makeChannel(SRC_SERVER, {
    _id: SRC_CHANNEL, name: 'news', type: 'announcement',
  }));
  await db.members.insert({ userId: PUBLISHER, serverId: SRC_SERVER, roles: [], joinedAt: Date.now() });
  await db.messages.insert(makeMessage(SRC_CHANNEL, SRC_SERVER, PUBLISHER, {
    _id: MESSAGE_ID, content: 'Durable announcement', displayName: 'Alice', username: 'alice',
  }));
});

describe('announcement crosspost authority + durability handoff', () => {
  it('stale/cross-tenant follower row never reaches persistence or realtime', async () => {
    mockGetFollowers.mockResolvedValue([{ targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER }]);

    const to = jest.fn();
    setIo({ to } as any);
    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(0);
    expect(res.body.errors?.[0]).toMatch(/stale|cross-tenant/i);
    expect(mockPersistCrosspost).not.toHaveBeenCalled();
    expect(to).not.toHaveBeenCalled();
  });

  it('resolves target channel/server before persisting and emits only the persisted id', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    mockGetFollowers.mockResolvedValue([{ targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER }]);
    mockPersistCrosspost.mockResolvedValue({ bridgeMessageId: 'bridge-1', created: true });

    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    setIo({ to } as any);

    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(1);
    expect(mockPersistCrosspost).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageId: MESSAGE_ID,
      sourceChannelId: SRC_CHANNEL,
      sourceServerId: SRC_SERVER,
      targetChannelId: TARGET_CHANNEL,
      targetServerId: TARGET_SERVER,
      content: 'Durable announcement',
    }));
    expect(to).toHaveBeenCalledWith(`channel:${TARGET_CHANNEL}`);
    expect(emit).toHaveBeenCalledWith('new_message', expect.objectContaining({
      _id: 'bridge-1', channelId: TARGET_CHANNEL, serverId: TARGET_SERVER, type: 'crosspost',
    }));
  });

  it('idempotent replay does not emit the same persisted crosspost twice', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    mockGetFollowers.mockResolvedValue([{ targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER }]);
    mockPersistCrosspost.mockResolvedValue({ bridgeMessageId: 'bridge-existing', created: false });

    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    setIo({ to } as any);

    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(1);
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('client cannot pair a message from another channel with this announcement channel', async () => {
    await db.messages.insert(makeMessage('ch-other', SRC_SERVER, PUBLISHER, { _id: 'msg-other' }));

    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/msg-other/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);
    expect(mockGetFollowers).not.toHaveBeenCalled();
    expect(mockPersistCrosspost).not.toHaveBeenCalled();
  });


  it('fails closed when the publisher loses source-channel visibility', async () => {
    mockResolvePermissions.mockResolvedValue(0);

    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(403);
    expect(mockGetFollowers).not.toHaveBeenCalled();
    expect(mockPersistCrosspost).not.toHaveBeenCalled();
  });

  it('requires SEND_MESSAGES for own-message publish when MANAGE_MESSAGES is absent', async () => {
    mockResolvePermissions.mockResolvedValue(1 << 0); // VIEW_CHANNELS only

    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
    expect(mockGetFollowers).not.toHaveBeenCalled();
  });

  it('returns a deterministic zero result when there are no followers', async () => {
    mockGetFollowers.mockResolvedValue([]);

    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, crosspostedTo: 0, message: 'No followers' });
    expect(mockPersistCrosspost).not.toHaveBeenCalled();
  });

  it('rejects follower channels whose live type no longer accepts messages', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'voice' }));
    mockGetFollowers.mockResolvedValue([{ targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER }]);

    const to = jest.fn(); setIo({ to } as any);
    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(0);
    expect(res.body.errors?.[0]).toMatch(/does not support messages/i);
    expect(mockPersistCrosspost).not.toHaveBeenCalled();
    expect(to).not.toHaveBeenCalled();
  });

  it('reports persistence failure per follower and never emits an uncommitted crosspost', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    mockGetFollowers.mockResolvedValue([{ targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER }]);
    mockPersistCrosspost.mockRejectedValueOnce(new Error('commit failed'));

    const to = jest.fn(); setIo({ to } as any);
    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', PUBLISHER);

    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(0);
    expect(res.body.errors?.[0]).toMatch(/commit failed/i);
    expect(to).not.toHaveBeenCalled();
  });
});

describe('announcement follow/follower branch contracts', () => {
  beforeEach(async () => {
    mockFollowChannel.mockResolvedValue(undefined);
    mockUnfollowChannel.mockResolvedValue(undefined);
  });

  it.each([{}, { targetChannelId: 123 }, { targetChannelId: [] }, { targetChannelId: '' }])('rejects malformed follow target %#', async body => {
    const res = await request(app()).post(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER).send(body);
    expect(res.status).toBe(400);
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('rejects follow to a channel type that cannot receive messages', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'voice' }));
    await db.members.insert({ userId: PUBLISHER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
    const res = await request(app()).post(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(400);
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('creates a follow only after source and target authority both pass', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    await db.members.insert({ userId: PUBLISHER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
    const emit = jest.fn(); setIo({ to: jest.fn(() => ({ emit })) } as any);
    const res = await request(app()).post(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(200);
    expect(mockFollowChannel).toHaveBeenCalledWith(SRC_CHANNEL, SRC_SERVER, TARGET_CHANNEL, TARGET_SERVER, PUBLISHER);
    expect(emit).toHaveBeenCalledWith('new_message', expect.objectContaining({ channelId: TARGET_CHANNEL, type: 'system' }));
  });

  it('fails closed when source permission resolution fails', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    await db.members.insert({ userId: PUBLISHER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
    mockResolvePermissions.mockRejectedValueOnce(new Error('permission backend down'));
    const res = await request(app()).post(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
  });


  it('fails closed when target permission resolution fails', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    await db.members.insert({ userId: PUBLISHER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
    mockResolvePermissions
      .mockResolvedValueOnce(0x7fffffff)
      .mockRejectedValueOnce(new Error('target permission backend down'));
    const res = await request(app()).post(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('does not allow a channel to follow itself', async () => {
    // Publisher is already a source-server member from the outer fixture.
    const res = await request(app()).post(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: SRC_CHANNEL });
    expect(res.status).toBe(400);
  });

  it('returns 500 rather than claiming success when follow persistence fails', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    await db.members.insert({ userId: PUBLISHER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
    mockFollowChannel.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app()).post(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(500);
  });

  it('unfollows only with current target membership and management permission', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    await db.members.insert({ userId: PUBLISHER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
    const res = await request(app()).delete(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(200);
    expect(mockUnfollowChannel).toHaveBeenCalledWith(SRC_CHANNEL, TARGET_CHANNEL);
  });

  it('denies unfollow when target permission resolution fails closed', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, type: 'text' }));
    await db.members.insert({ userId: PUBLISHER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
    mockResolvePermissions.mockRejectedValueOnce(new Error('down'));
    const res = await request(app()).delete(`/api/channels/${SRC_CHANNEL}/follow`).set('x-test-user', PUBLISHER)
      .send({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
  });

  it('lists followers only for a current member who can still view the source channel', async () => {
    mockGetFollowers.mockResolvedValue([{ targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER }]);
    const ok = await request(app()).get(`/api/channels/${SRC_CHANNEL}/followers`).set('x-test-user', PUBLISHER);
    expect(ok.status).toBe(200);
    expect(ok.body.count).toBe(1);
    mockResolvePermissions.mockRejectedValueOnce(new Error('down'));
    const denied = await request(app()).get(`/api/channels/${SRC_CHANNEL}/followers`).set('x-test-user', PUBLISHER);
    expect(denied.status).toBe(403);
  });
});
