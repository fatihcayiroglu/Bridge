// server/tests/unread-channels-routes.test.ts
//
// Final21 Phase 15 — GET /api/notification-prefs/unread-channels and POST /api/channels/:cid/read.
// The snapshot must never reveal a channel the caller cannot view, must respect mute, and
// must fail closed; the read route must only move the caller's own cursor, and only forward.

process.env.NODE_ENV = 'test';

const mockNotifications = {
  findActivityUnreadChannels: jest.fn(),
  findPrefsForUser: jest.fn(),
  advanceChannelReadPosition: jest.fn(),
  markChannelAttentionRead: jest.fn(),
};
const mockChannels = { findById: jest.fn() };
const mockMembers = { findOne: jest.fn() };
const mockMessages = { findById: jest.fn() };
const mockViewable = jest.fn();
const mockResolve = jest.fn();
const mockClearUnread = jest.fn();

jest.mock('../db/repositories', () => ({
  Notifications: mockNotifications, Channels: mockChannels, Members: mockMembers, Messages: mockMessages, MessageReports: {},
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'u1', _id: 'u1', username: 'alice' }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return {
    ...actual,
    viewableChannelIds: (...args: unknown[]) => mockViewable(...args),
    resolvePermissions: (...args: unknown[]) => mockResolve(...args),
  };
});
jest.mock('../lib/notifications', () => ({ clearUnread: (...args: unknown[]) => mockClearUnread(...args) }));
jest.mock('../lib/redisAdapter', () => ({ cache: { get: jest.fn(async () => null), set: jest.fn(async () => undefined) } }));

import express from 'express';
import request from 'supertest';
import { PERMS } from '../lib/permissions';
import prefsRouter from '../routes/notificationPrefs';
import messagesRouter from '../routes/messages';

const app = express();
app.use(express.json());
app.use('/api/notification-prefs', prefsRouter);
app.use('/api/channels', messagesRouter);

beforeEach(() => {
  jest.clearAllMocks();
  mockNotifications.findPrefsForUser.mockResolvedValue([]);
  mockNotifications.advanceChannelReadPosition.mockResolvedValue(undefined);
  mockNotifications.markChannelAttentionRead.mockResolvedValue(undefined);
  mockClearUnread.mockResolvedValue(undefined);
  mockViewable.mockImplementation(async (_u: string, _s: string, ids: string[]) => new Set(ids));
  mockChannels.findById.mockResolvedValue({ _id: 'c1', serverId: 's1' });
  mockMembers.findOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
  mockResolve.mockResolvedValue(PERMS.VIEW_CHANNELS | PERMS.READ_HISTORY);
  mockMessages.findById.mockResolvedValue({ _id: 'm9', channelId: 'c1', createdAt: 1_800_000_000_000 });
});

describe('GET /api/notification-prefs/unread-channels', () => {
  it('returns only viewable channels, per server', async () => {
    mockNotifications.findActivityUnreadChannels.mockResolvedValue([
      { channelId: 'a', serverId: 's1' }, { channelId: 'hidden', serverId: 's1' }, { channelId: 'b', serverId: 's2' },
    ]);
    mockViewable.mockImplementation(async (_u: string, serverId: string, ids: string[]) =>
      new Set(ids.filter((id) => !(serverId === 's1' && id === 'hidden'))));
    const res = await request(app).get('/api/notification-prefs/unread-channels');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([{ channelId: 'a', serverId: 's1' }, { channelId: 'b', serverId: 's2' }]);
    expect(mockViewable).toHaveBeenCalledWith('u1', 's1', ['a', 'hidden']);
    expect(mockViewable).toHaveBeenCalledWith('u1', 's2', ['b']);
    expect(JSON.stringify(res.body)).not.toContain('hidden');
  });

  it('muted channels and muted servers report no activity, and are listed for the live filter', async () => {
    const future = Date.now() + 60_000;
    mockNotifications.findActivityUnreadChannels.mockResolvedValue([
      { channelId: 'muted-ch', serverId: 's1' }, { channelId: 'plain', serverId: 's1' },
      { channelId: 'in-muted-server', serverId: 's2' }, { channelId: 'expired-mute', serverId: 's1' },
    ]);
    mockNotifications.findPrefsForUser.mockResolvedValue([
      { channelId: 'muted-ch', level: 'mute', muteUntil: null },
      { channelId: 'server:s2', level: 'mute', muteUntil: future },
      { channelId: 'expired-mute', level: 'mute', muteUntil: Date.now() - 1_000 },
    ]);
    const res = await request(app).get('/api/notification-prefs/unread-channels');
    expect(res.body.channels).toEqual([{ channelId: 'plain', serverId: 's1' }, { channelId: 'expired-mute', serverId: 's1' }]);
    expect(res.body.muted).toEqual({ channels: ['muted-ch'], servers: ['s2'] });
  });

  it('fails closed: a storage error reports nothing', async () => {
    mockNotifications.findActivityUnreadChannels.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/notification-prefs/unread-channels');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channels: [], muted: { channels: [], servers: [] } });
  });
});

describe('POST /api/channels/:cid/read', () => {
  it('advances the caller cursor to the seen message and clears attention', async () => {
    const res = await request(app).post('/api/channels/c1/read').send({ messageId: 'm9' });
    expect(res.status).toBe(204);
    expect(mockNotifications.advanceChannelReadPosition).toHaveBeenCalledWith('u1', 'c1', 1_800_000_000_000, 'm9');
    expect(mockClearUnread).toHaveBeenCalledWith('u1', 'c1');
    expect(mockNotifications.markChannelAttentionRead).toHaveBeenCalledWith('u1', 'c1');
  });

  it.each([
    ['no messageId', {}, 400],
    ['a non-string messageId', { messageId: 7 }, 400],
  ])('rejects %s', async (_label, body, status) => {
    const res = await request(app).post('/api/channels/c1/read').send(body);
    expect(res.status).toBe(status);
    expect(mockNotifications.advanceChannelReadPosition).not.toHaveBeenCalled();
  });

  it('refuses a channel the caller cannot view (no cursor, no disclosure)', async () => {
    mockResolve.mockResolvedValue(PERMS.SEND_MESSAGES);
    const res = await request(app).post('/api/channels/c1/read').send({ messageId: 'm9' });
    expect(res.status).toBe(403);
    expect(mockMessages.findById).not.toHaveBeenCalled();
    expect(mockNotifications.advanceChannelReadPosition).not.toHaveBeenCalled();
  });

  it('refuses a non-member', async () => {
    mockMembers.findOne.mockResolvedValue(null);
    const res = await request(app).post('/api/channels/c1/read').send({ messageId: 'm9' });
    expect(res.status).toBe(403);
    expect(mockNotifications.advanceChannelReadPosition).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing message', null],
    ['a message of another channel', { _id: 'm9', channelId: 'other', createdAt: 1 }],
    ['a message without a valid time', { _id: 'm9', channelId: 'c1', createdAt: 'soon' }],
  ])('does not move the cursor for %s', async (_label, row) => {
    mockMessages.findById.mockResolvedValue(row);
    const res = await request(app).post('/api/channels/c1/read').send({ messageId: 'm9' });
    expect(res.status).toBe(404);
    expect(mockNotifications.advanceChannelReadPosition).not.toHaveBeenCalled();
  });
});
