// server/tests/message-cache-race.test.ts
//
// A first-page read that queried the database BEFORE a send committed must not
// store its stale page AFTER the send invalidated the cache. Measured in CI
// (E2E security suites, attachments.spec.ts): GET /messages read an empty
// channel, file:send committed and invalidated, then the GET cached the empty
// page for 45 s (an empty channel gets the longest TTL), so a refreshed client
// or a second device did not see the sent message.

process.env.JWT_SECRET     = 'test-jwt-secret-minimum-32-chars-long';
process.env.REFRESH_SECRET = 'test-refresh-secret-minimum-32-chars-long';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// A cache with the adapter's semantics for the calls these paths make.
const _store = new Map<string, unknown>();
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: jest.fn(async (key: string) => _store.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => { _store.set(key, value); }),
    del: jest.fn(async (key: string) => { _store.delete(key); }),
    invalidatePattern: jest.fn(async (prefix: string) => {
      for (const key of [..._store.keys()]) if (key.startsWith(prefix)) _store.delete(key);
    }),
  },
  subscribeToChannel: jest.fn().mockResolvedValue(() => Promise.resolve()),
  publishToChannel:   jest.fn().mockResolvedValue(undefined),
  redisClient:        jest.fn().mockReturnValue(null),
}));
jest.mock('../lib/notifications', () => ({
  clearUnread:          jest.fn().mockResolvedValue(undefined),
  processNotifications: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import messagesRouter from '../routes/messages';
import { invalidateChannelMessages } from '../lib/messageCache';

const db = require('../db/loader');
const jwt = require('jsonwebtoken');
const { Messages } = require('../db/repositories');

describe('first-page message cache: a read racing a send never caches the pre-send page', () => {
  const userId = uuidv4();
  const serverId = uuidv4();
  const channelId = uuidv4();
  const token = jwt.sign({ id: userId, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json());
  app.use('/api/channels', authMiddleware, messagesRouter);
  const read = () => request(app).get(`/api/channels/${channelId}/messages`).set('Authorization', `Bearer ${token}`);

  beforeEach(async () => {
    db._reset?.();
    _store.clear();
    await db.users.insert({ _id: userId, username: 'u1', displayName: 'U1', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'S1', ownerId: userId });
    await db.members.insert({ userId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text', createdAt: Date.now() });
  });
  afterEach(() => jest.restoreAllMocks());

  it('the racing read answers with its own snapshot, and the next read sees the sent message', async () => {
    const original = Messages.findByChannel.bind(Messages);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inQuery = new Promise<void>((resolve) => { entered = resolve; });
    jest.spyOn(Messages, 'findByChannel').mockImplementationOnce(async (...args: unknown[]) => {
      const snapshot = await original(...args);   // the database before the send commits
      entered();
      await gate;
      return snapshot;
    });

    const racing = read();
    const racingDone = racing.then((res) => res);
    await inQuery;
    // The send commits and invalidates while the read still holds its old snapshot.
    const sent = { _id: uuidv4(), channelId, serverId, userId, content: '', type: 'file',
      fileUrl: '/uploads/sent.png', fileName: 'sent.png', fileType: 'image/png', createdAt: Date.now() };
    await db.messages.insert(sent);
    await invalidateChannelMessages(channelId);
    release();
    const first = await racingDone;
    expect(first.status).toBe(200);
    expect(first.body.messages).toHaveLength(0);       // its own, pre-send snapshot

    const next = await read();
    expect(next.status).toBe(200);
    expect(next.body.messages.map((m: { _id: string }) => m._id)).toEqual([sent._id]);
  });

  it('an unchanged channel is still served from the cache', async () => {
    await db.messages.insert({ _id: uuidv4(), channelId, serverId, userId, content: 'hi', createdAt: Date.now() - 60_000 });
    expect((await read()).headers['x-cache']).toBe('MISS');
    const hit = await read();
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.body.messages).toHaveLength(1);
    expect(Object.keys(hit.body).sort()).toEqual(['count', 'hasMore', 'limit', 'messages', 'nextCursor', 'prevCursor']);
  });

  it('an invalidation after the page was cached is honoured on the next read', async () => {
    expect((await read()).body.messages).toHaveLength(0);
    expect((await read()).headers['x-cache']).toBe('HIT');
    const sent = { _id: uuidv4(), channelId, serverId, userId, content: 'new', createdAt: Date.now() };
    await db.messages.insert(sent);
    await invalidateChannelMessages(channelId);
    const next = await read();
    expect(next.headers['x-cache']).toBe('MISS');
    expect(next.body.messages.map((m: { _id: string }) => m._id)).toEqual([sent._id]);
  });
});
