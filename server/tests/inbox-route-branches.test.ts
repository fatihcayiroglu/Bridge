import { makeJwtUser } from './helpers/userDoubles';
import type { Request, Response, NextFunction } from 'express';
process.env.NODE_ENV = 'test';

const repos = {
  Dms: { findConversationsByUser: jest.fn(), countUnread: jest.fn(), findLatestUnread: jest.fn(), markRead: jest.fn() },
  GroupDms: { findGroupsByUser: jest.fn(), findById: jest.fn(), countUnread: jest.fn(), findLatestUnread: jest.fn(), markRead: jest.fn() },
  Notifications: { findUnreadChannelAttention: jest.fn(), findUnreadSavedReminders: jest.fn(), markSavedReminderRead: jest.fn(), markAllSavedRemindersRead: jest.fn(), markAllChannelAttentionRead: jest.fn(), clearAllUnreadCounts: jest.fn() },
  SavedMessages: { findByIdForUser: jest.fn() },
  Messages: { findWhere: jest.fn() },
  Channels: { findWhere: jest.fn() },
  Servers: { findByIds: jest.fn() },
  Users: { findByIds: jest.fn() },
};
const resolvePermissions = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../middleware/auth', () => ({ authMiddleware: (req: Request, _res: Response, next: NextFunction) => { req.user = makeJwtUser('u1'); next(); } }));
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1, READ_HISTORY: 2 },
  resolvePermissions: (...args: unknown[]) => resolvePermissions(...args),
  // `value` agdan/DB'den gelir; sayiya DONUSTURULUR (iddia edilmez).
  hasPermission: (value: unknown, wanted: number) => (Number(value ?? 0) & wanted) === wanted,
}));
jest.mock('../lib/userUtils', () => ({ sanitizeUser: (u: Record<string, unknown>) => ({ _id:u._id, username:u.username, displayName:u.displayName }) }));

import express from 'express';
import request from 'supertest';
import router from '../routes/inbox';

const app = express();
app.use(express.json());
app.use('/api/inbox', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));

beforeEach(() => {
  jest.clearAllMocks();
  repos.Notifications.findUnreadChannelAttention.mockResolvedValue([]);
  repos.Notifications.findUnreadSavedReminders.mockResolvedValue([]);
  repos.Notifications.markSavedReminderRead.mockResolvedValue(undefined);
  repos.Notifications.markAllSavedRemindersRead.mockResolvedValue(undefined);
  repos.SavedMessages.findByIdForUser.mockResolvedValue(null);
  repos.Messages.findWhere.mockResolvedValue([]);
  repos.Channels.findWhere.mockResolvedValue([]);
  repos.Servers.findByIds.mockResolvedValue([]);
  repos.Dms.findConversationsByUser.mockResolvedValue([]);
  repos.Users.findByIds.mockResolvedValue([]);
  repos.GroupDms.findGroupsByUser.mockResolvedValue([]);
  repos.Notifications.markAllChannelAttentionRead.mockResolvedValue(undefined);
  repos.Notifications.clearAllUnreadCounts.mockResolvedValue(undefined);
  repos.Dms.markRead.mockResolvedValue(undefined);
  repos.GroupDms.markRead.mockResolvedValue(undefined);
  resolvePermissions.mockResolvedValue(3);
});

describe('unified inbox defensive branches', () => {
  it('fails closed with no partial metadata when the canonical attention query fails', async () => {
    repos.Notifications.findUnreadChannelAttention.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/inbox');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error:'Inbox temporarily unavailable', items:[], counts:{ all:0, mentions:0, watches:0, replies:0, dms:0, reminders:0 } });
  });

  it('drops stale, deleted, mismatched and permission-revoked channel attention rows', async () => {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValueOnce([
      { _id:'stale', type:'mention', messageId:'missing', channelId:'c', serverId:'s' },
      { _id:'deleted', type:'mention', messageId:'deleted-m', channelId:'c', serverId:'s' },
      { _id:'mismatch', type:'mention', messageId:'mismatch-m', channelId:'wrong', serverId:'s' },
      { _id:'revoked', type:'mention', messageId:'revoked-m', channelId:'c', serverId:'s' },
    ]);
    repos.Messages.findWhere.mockResolvedValueOnce([
      { _id:'deleted-m', channelId:'c', serverId:'s', deletedAt:1, content:'secret' },
      { _id:'mismatch-m', channelId:'c', serverId:'s', content:'secret2' },
      { _id:'revoked-m', channelId:'c', serverId:'s', content:'secret3' },
    ]);
    repos.Channels.findWhere.mockResolvedValueOnce([{ _id:'c', serverId:'s', name:'private', type:'text' }]);
    repos.Servers.findByIds.mockResolvedValueOnce([{ _id:'s', name:'Server' }]);
    resolvePermissions.mockRejectedValueOnce(new Error('permission db down'));
    const res = await request(app).get('/api/inbox');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('redacts encrypted/file previews and supports reply/default filters without leaking ack data', async () => {
    repos.Notifications.findUnreadChannelAttention.mockResolvedValueOnce([
      { _id:'r1', type:'reply', messageId:'e2', channelId:'c', serverId:'s', actorId:'a' },
      { _id:'m1', type:'mention', messageId:'f1', channelId:'c', serverId:'s', actorId:'a' },
    ]);
    repos.Messages.findWhere.mockResolvedValueOnce([
      { _id:'e2', channelId:'c', serverId:'s', userId:'a', type:'e2ee', content:'ciphertext', createdAt:20 },
      { _id:'f1', channelId:'c', serverId:'s', userId:'a', type:'file', fileUrl:'/uploads/private.pdf', content:'secret-name.pdf', createdAt:10 },
    ]);
    repos.Channels.findWhere.mockResolvedValueOnce([{ _id:'c', serverId:'s', name:'general', type:'text' }]);
    repos.Servers.findByIds.mockResolvedValueOnce([{ _id:'s', name:'Server' }]);
    const replies = await request(app).get('/api/inbox?filter=replies');
    expect(replies.status).toBe(200);
    expect(replies.body.items).toHaveLength(1);
    expect(replies.body.items[0]).toMatchObject({ kind:'reply', preview:'Şifreli mesaj' });

    // Repeat canonical data because repository mocks are one-shot above.
    repos.Notifications.findUnreadChannelAttention.mockResolvedValueOnce([
      { _id:'m1', type:'mention', messageId:'f1', channelId:'c', serverId:'s', actorId:'a' },
    ]);
    repos.Messages.findWhere.mockResolvedValueOnce([
      { _id:'f1', channelId:'c', serverId:'s', userId:'a', type:'file', fileUrl:'/uploads/private.pdf', content:'secret-name.pdf', createdAt:10 },
    ]);
    repos.Channels.findWhere.mockResolvedValueOnce([{ _id:'c', serverId:'s', name:'general', type:'text' }]);
    repos.Servers.findByIds.mockResolvedValueOnce([{ _id:'s', name:'Server' }]);
    const invalidFilter = await request(app).get('/api/inbox?filter=unknown');
    expect(invalidFilter.body.filter).toBe('all');
    expect(invalidFilter.body.items[0].preview).toBe('Dosya mesajı');
    expect(JSON.stringify(invalidFilter.body)).not.toContain('secret-name.pdf');
  });

  it('ignores malformed/foreign DM conversations and only emits currently unread canonical peers', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValueOnce([
      { _id:'foreign', participants:['x','y'], readAt:{} },
      { _id:'missing-peer', participants:['u1','gone'], readAt:{} },
      { _id:'read', participants:['u1','u2'], readAt:{u1:5} },
      { _id:'good', participants:['u1','u3'], readAt:{u1:7}, lastMessageAt:10 },
    ]);
    repos.Users.findByIds.mockResolvedValueOnce([
      { _id:'u2', username:'u2', displayName:'Two' }, { _id:'u3', username:'u3', displayName:'Three' },
    ]);
    repos.Dms.countUnread.mockImplementation(async (id) => id === 'read' ? 0 : 2);
    repos.Dms.findLatestUnread.mockResolvedValueOnce({ type:'e2ee', content:'cipher', createdAt:12, userId:'u3' });
    const res = await request(app).get('/api/inbox?filter=dms');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id:'dm:good', kind:'dm', unreadCount:2, preview:'Şifreli mesaj' });
  });

  it('handles missing/read GDMs and emits a null sender when latest unread metadata is unavailable', async () => {
    repos.GroupDms.findGroupsByUser.mockResolvedValueOnce([
      { groupId:'missing', joinedAt:1, readAt:2 },
      { groupId:'read', joinedAt:5, readAt:2 },
      { groupId:'good', joinedAt:1, readAt:9 },
    ]);
    repos.GroupDms.findById.mockImplementation(async (id) => id === 'missing' ? null : ({ _id:id, name:id === 'good' ? undefined : 'Read', ownerId:'owner', lastMessageAt:20 }));
    repos.GroupDms.countUnread.mockImplementation(async (id) => id === 'read' ? 0 : 1);
    repos.GroupDms.findLatestUnread.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/inbox?filter=dms');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('gdm:good');
    expect(res.body.items[0].sender).toBeNull();
    expect(res.body.items[0].destination.group.name).toBe('Grup DM');
  });

  it('read-all advances every current DM/GDM cursor through canonical repository methods', async () => {
    repos.Dms.findConversationsByUser.mockResolvedValueOnce([{ _id:'d1' }, { _id:'d2' }]);
    repos.GroupDms.findGroupsByUser.mockResolvedValueOnce([{ groupId:'g1' }, { groupId:'g2' }]);
    const res = await request(app).patch('/api/inbox/read-all');
    expect(res.status).toBe(200);
    expect(repos.Notifications.markAllChannelAttentionRead).toHaveBeenCalledWith('u1');
    expect(repos.Dms.markRead).toHaveBeenCalledTimes(2);
    expect(repos.GroupDms.markRead).toHaveBeenCalledTimes(2);
  });
});
