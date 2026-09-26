process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import { createMockDb, requireDoc } from './helpers/mockDb';
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
import savedRouter from '../routes/saved';

const app = express();
app.use(express.json());
app.use('/api/saved', savedRouter);

const USER = 'saved-user';
const OTHER = 'saved-other';
const SERVER = 'saved-server';
const OPEN = 'saved-open';
const HIDDEN = 'saved-hidden';
const DM = 'saved-dm';
const GDM = 'saved-gdm';
const tokenFor = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
const auth = (id = USER) => ({ Authorization: `Bearer ${tokenFor(id)}` });

beforeAll(async () => {
  await mockDb.users.insert({ _id: USER, username: USER, displayName: 'Saved User', avatarColor: '#123456' });
  await mockDb.users.insert({ _id: OTHER, username: OTHER, displayName: 'Other User', avatarColor: '#654321' });
  await mockDb.servers.insert({ _id: SERVER, name: 'Saved Server', ownerId: OTHER, createdAt: 1 });
  await mockDb.members.insert({ _id: 'saved-member', userId: USER, serverId: SERVER, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: OPEN, serverId: SERVER, name: 'follow-up', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: HIDDEN, serverId: SERVER, name: 'secret-room', type: 'text', createdAt: 1 });
  await mockDb.channelOverrides.insert({
    _id: 'saved-hidden-override', channelId: HIDDEN, targetType: 'everyone', targetId: SERVER,
    allow: 0, deny: 1, position: 0,
  });
  await mockDb.messages.insert({
    _id: 'saved-channel-message', channelId: OPEN, serverId: SERVER, userId: OTHER,
    displayName: 'Other User', content: 'finish the release notes', type: 'normal', createdAt: 100,
  });
  await mockDb.messages.insert({
    _id: 'saved-hidden-message', channelId: HIDDEN, serverId: SERVER, userId: OTHER,
    displayName: 'Secret Sender', content: 'TOP SECRET CONTENT', type: 'file', fileName: 'secret-plan.pdf', fileUrl: '/uploads/secret', createdAt: 101,
  });
  await mockDb.dmConversations.insert({ _id: DM, participants: [USER, OTHER], createdAt: 1, lastMessageAt: 200 });
  await mockDb.dmMessages.insert({ _id: 'saved-dm-message', dmId: DM, userId: OTHER, displayName: 'Other User', content: 'direct follow-up', createdAt: 200 });
  await mockDb.groupDmConversations.insert({ _id: GDM, name: 'Saved Team', ownerId: OTHER, createdAt: 1, lastMessageAt: 300 });
  await mockDb.groupDmMembers.insert({ _id: 'saved-gdm-user', groupId: GDM, userId: USER, joinedAt: 1 });
  await mockDb.groupDmMembers.insert({ _id: 'saved-gdm-other', groupId: GDM, userId: OTHER, joinedAt: 1 });
  await mockDb.groupDmMessages.insert({ _id: 'saved-gdm-message', groupId: GDM, userId: OTHER, displayName: 'Other User', content: 'group follow-up', type: 'normal', createdAt: 300 });
});

describe('Saved / Follow-up', () => {
  it('requires authentication and refuses inaccessible targets without existence detail', async () => {
    expect((await request(app).get('/api/saved')).status).toBe(401);
    const hidden = await request(app).post('/api/saved').set(auth()).send({
      destinationType: 'channel', destinationId: HIDDEN, messageId: 'saved-hidden-message',
    });
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain('secret-room');
    expect(JSON.stringify(hidden.body)).not.toContain('secret-plan.pdf');
  });

  it('saves channel, DM and GDM targets idempotently using identifiers only', async () => {
    const channel = await request(app).post('/api/saved').set(auth()).send({
      destinationType: 'channel', destinationId: OPEN, messageId: 'saved-channel-message',
    });
    expect(channel.status).toBe(201);
    const duplicate = await request(app).post('/api/saved').set(auth()).send({
      destinationType: 'channel', destinationId: OPEN, messageId: 'saved-channel-message',
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.created).toBe(false);

    expect((await request(app).post('/api/saved').set(auth()).send({
      destinationType: 'dm', destinationId: DM, messageId: 'saved-dm-message',
    })).status).toBe(201);
    expect((await request(app).post('/api/saved').set(auth()).send({
      destinationType: 'gdm', destinationId: GDM, messageId: 'saved-gdm-message',
    })).status).toBe(201);

    const raw = await mockDb.savedMessages.findOne({ userId: USER, messageId: 'saved-channel-message' });
    expect(raw).toMatchObject({ userId: USER, destinationType: 'channel', destinationId: OPEN, messageId: 'saved-channel-message' });
    expect(JSON.stringify(raw)).not.toContain('finish the release notes');
    expect(JSON.stringify(raw)).not.toContain('Other User');
  });

  it('returns a personal, canonical list with target routing and no cross-user visibility', async () => {
    const response = await request(app).get('/api/saved').set(auth());
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(3);
    expect(response.body.items.map((item: { preview?: string }) => item.preview)).toEqual([
      'group follow-up', 'direct follow-up', 'finish the release notes',
    ]);
    expect(response.body.items.find((item: { destination?: { type?: string } }) => item.destination?.type === 'channel').destination).toMatchObject({
      channelId: OPEN, serverId: SERVER, messageId: 'saved-channel-message',
    });

    const other = await request(app).get('/api/saved').set(auth(OTHER));
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
  });

  it('rechecks access and replaces revoked content with a metadata-free removable row', async () => {
    await mockDb.channelOverrides.insert({
      _id: 'saved-open-revoked', channelId: OPEN, targetType: 'everyone', targetId: SERVER,
      allow: 0, deny: 1, position: 0,
    });
    const response = await request(app).get('/api/saved').set(auth());
    const revoked = response.body.items.find((item: { id: string }) => item.id.includes('saved-channel-message'));
    expect(revoked).toEqual(expect.objectContaining({ unavailable: true }));
    // Kanonik satir: kullanicinin KENDI hatirlatma meta verisi kalir
    // (`remindAt`/`remindedAt` kaydeden kullanicidan gelir, iceriginden degil),
    // ancak icerik/kanal/sunucu/gonderen turevli HICBIR alan sizmaz.
    expect(Object.keys(revoked).sort()).toEqual(['id', 'remindAt', 'remindedAt', 'savedAt', 'unavailable']);
    for (const leaked of ['preview', 'sender', 'channel', 'server', 'messageId', 'destinationId', 'content']) {
      expect(Object.prototype.hasOwnProperty.call(revoked, leaked)).toBe(false);
    }
    expect(JSON.stringify(response.body)).not.toContain('finish the release notes');

    const id = revoked.id;
    expect((await request(app).delete(`/api/saved/${encodeURIComponent(id)}`).set(auth(OTHER))).status).toBe(204);
    expect(await mockDb.savedMessages.findOne({ _id: id, userId: USER })).not.toBeNull();
    expect((await request(app).delete(`/api/saved/${encodeURIComponent(id)}`).set(auth())).status).toBe(204);
    expect(await mockDb.savedMessages.findOne({ _id: id, userId: USER })).toBeNull();
  });
});
