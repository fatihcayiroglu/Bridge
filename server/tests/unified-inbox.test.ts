process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import { recordOf } from './helpers/narrow';
import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(header.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));

import express from 'express';
import request from 'supertest';
const jwt = require('jsonwebtoken');
import inboxRouter from '../routes/inbox';

const app = express();
app.use(express.json());
app.use('/api/inbox', inboxRouter);

const USER = 'inbox-user';
const OTHER = 'inbox-sender';
const SERVER = 'inbox-server';
const OPEN = 'inbox-open-channel';
const HIDDEN = 'inbox-hidden-channel';
const token = jwt.sign({ id: USER, username: USER, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await mockDb.users.insert({ _id: USER, username: USER, displayName: 'Inbox User', avatarColor: '#123456' });
  await mockDb.users.insert({ _id: OTHER, username: OTHER, displayName: 'Sender', avatarColor: '#654321' });
  await mockDb.servers.insert({ _id: SERVER, name: 'Visible Server', ownerId: 'someone-else', createdAt: 1 });
  await mockDb.members.insert({ userId: USER, serverId: SERVER, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: OPEN, serverId: SERVER, name: 'visible', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: HIDDEN, serverId: SERVER, name: 'secret-room', type: 'text', createdAt: 1 });
  await mockDb.channelOverrides.insert({
    _id: 'hidden-override', channelId: HIDDEN, targetType: 'everyone', targetId: SERVER,
    allow: 0, deny: 1, position: 0,
  });

  await mockDb.messages.insert({
    _id: 'attention-message', channelId: OPEN, serverId: SERVER, userId: OTHER,
    displayName: 'Sender', avatarColor: '#654321', content: 'visible preview', type: 'normal', createdAt: 500,
  });
  await mockDb.messages.insert({
    _id: 'hidden-message', channelId: HIDDEN, serverId: SERVER, userId: OTHER,
    displayName: 'Hidden Sender', content: 'TOP SECRET ATTACHMENT NAME', fileName: 'secret.pdf', type: 'file', createdAt: 600,
  });
  await mockDb.messages.insert({
    _id: 'deleted-message', channelId: OPEN, serverId: SERVER, userId: OTHER,
    displayName: 'Sender', content: 'removed content', deletedAt: 610, type: 'normal', createdAt: 610,
  });

  // Two historical rows for one message exercise response-level deduplication
  // in addition to the production unique index.
  await mockDb.notifications.insert({ _id: 'attention-1', userId: USER, type: 'mention', serverId: SERVER, channelId: OPEN, messageId: 'attention-message', actorId: OTHER, read: false, createdAt: 500 });
  await mockDb.notifications.insert({ _id: 'attention-duplicate', userId: USER, type: 'mention', serverId: SERVER, channelId: OPEN, messageId: 'attention-message', actorId: OTHER, read: false, createdAt: 501 });
  await mockDb.notifications.insert({ _id: 'attention-hidden', userId: USER, type: 'mention', serverId: SERVER, channelId: HIDDEN, messageId: 'hidden-message', actorId: OTHER, read: false, createdAt: 600 });
  await mockDb.notifications.insert({ _id: 'attention-deleted', userId: USER, type: 'reply', serverId: SERVER, channelId: OPEN, messageId: 'deleted-message', actorId: OTHER, read: false, createdAt: 610 });
  await mockDb.notifications.insert({ _id: 'attention-other-user', userId: 'another-user', type: 'mention', serverId: SERVER, channelId: OPEN, messageId: 'attention-message', actorId: OTHER, read: false, createdAt: 700 });

  await mockDb.dmConversations.insert({ _id: 'dm-conversation', participants: [USER, OTHER], readAt: { [USER]: 100 }, createdAt: 1, lastMessageAt: 700 });
  await mockDb.dmMessages.insert({ _id: 'dm-unread', dmId: 'dm-conversation', userId: OTHER, displayName: 'Sender', avatarColor: '#654321', content: 'direct attention', createdAt: 700 });
  await mockDb.dmMessages.insert({ _id: 'dm-self', dmId: 'dm-conversation', userId: USER, displayName: 'Inbox User', content: 'my own message', createdAt: 710 });

  await mockDb.groupDmConversations.insert({ _id: 'gdm-conversation', name: 'Project Team', ownerId: OTHER, createdAt: 1, lastMessageAt: 800 });
  await mockDb.groupDmMembers.insert({ _id: 'gdm-member-user', groupId: 'gdm-conversation', userId: USER, joinedAt: 50, readAt: 100 });
  await mockDb.groupDmMembers.insert({ _id: 'gdm-member-other', groupId: 'gdm-conversation', userId: OTHER, joinedAt: 50, readAt: 100 });
  await mockDb.groupDmMessages.insert({ _id: 'gdm-unread', groupId: 'gdm-conversation', userId: OTHER, displayName: 'Sender', avatarColor: '#654321', content: 'group attention', type: 'normal', createdAt: 800 });
});

describe('Unified Inbox', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/inbox')).status).toBe(401);
  });

  it('combines canonical attention without duplicates or revoked metadata leaks', async () => {
    const response = await request(app).get('/api/inbox').set(auth());
    expect(response.status).toBe(200);

    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(response.body.items.filter((item: { destination?: { messageId?: string } }) => item.destination?.messageId === 'attention-message')).toHaveLength(1);
    expect(ids.some((id: string) => id === 'attention-1' || id === 'attention-duplicate')).toBe(true);
    expect(ids).toContain('dm:dm-conversation');
    expect(ids).toContain('gdm:gdm-conversation');
    expect(response.body.counts).toEqual({ all: 3, mentions: 1, watches: 0, replies: 0, dms: 2, reminders: 0 });

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('secret-room');
    expect(serialized).not.toContain('TOP SECRET');
    expect(serialized).not.toContain('secret.pdf');
    expect(serialized).not.toContain('removed content');
    expect(serialized).not.toContain('attention-other-user');
  });

  it('applies compact filters on the same canonical response', async () => {
    const mentions = await request(app).get('/api/inbox?filter=mentions').set(auth());
    expect(mentions.status).toBe(200);
    expect(mentions.body.items).toHaveLength(1);
    expect(mentions.body.items[0].kind).toBe('mention');

    const dms = await request(app).get('/api/inbox?filter=dms').set(auth());
    expect(dms.body.items.map((item: { kind: string }) => item.kind).sort()).toEqual(['dm', 'gdm']);
  });

  it('mark-all-read advances every canonical cursor and empties the inbox', async () => {
    const marked = await request(app).patch('/api/inbox/read-all').set(auth());
    expect(marked.status).toBe(200);

    const channelRow = await mockDb.notifications.findOne({ _id: 'attention-1' });
    const dm = await mockDb.dmConversations.findOne({ _id: 'dm-conversation' });
    const gdmMember = await mockDb.groupDmMembers.findOne({ groupId: 'gdm-conversation', userId: USER });
    expect(channelRow?.read).toBe(true);
    expect(Number(recordOf(dm?.readAt, 'readAt')[USER])).toBeGreaterThan(100);
    expect(Number(gdmMember?.readAt)).toBeGreaterThan(100);

    const after = await request(app).get('/api/inbox').set(auth());
    expect(after.body.items).toEqual([]);
    expect(after.body.counts.all).toBe(0);
  });
});
