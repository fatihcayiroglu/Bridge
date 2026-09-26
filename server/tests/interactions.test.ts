'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer, makeChannel, makeMessage } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

const mockResolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1 << 0, USE_BOT_COMMANDS: 1 << 21, ADMINISTRATOR: 1 << 30 },
  hasPermission: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: { write: () => (_req: any, _res: any, next: () => void) => next() },
}));

const mockFetchT = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => mockFetchT(...args) }));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');
const router = require('../routes/interactions');

function token(userId: string) {
  return jwt.sign({ id: userId, username: 'user', displayName: 'User', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}
function buildApp(io?: unknown) {
  const app = express();
  if (io) app.set('io', io);
  app.use(express.json());
  app.use('/api/interactions', router);
  return app;
}

const SERVER_ID = 'srv_int_1';
const CHANNEL_ID = 'ch_int_1';
const BOT_ID = 'bot_xyz';
let user: ReturnType<typeof makeUser>;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  jest.clearAllMocks();
  mockResolvePermissions.mockResolvedValue((1 << 0) | (1 << 21));

  user = makeUser({ _id: 'u-interactor', username: 'interactor' });
  await db.users.insert(user);
  await db.servers.insert(makeServer('owner', { _id: SERVER_ID }));
  await db.channels.insert(makeChannel(SERVER_ID, { _id: CHANNEL_ID }));
  await db.members.insert({ userId: user._id, serverId: SERVER_ID, roles: [], joinedAt: Date.now() });
  await db.bots.insert({
    _id: BOT_ID,
    username: 'InstalledBot',
    active: true,
    contextCommands: JSON.stringify([{ name: 'inspect-user', type: 'user_command' }]),
    createdAt: Date.now(),
  });
  await db.serverBots.insert({ _id: 'sb1', botId: BOT_ID, serverId: SERVER_ID, addedBy: 'owner', addedAt: Date.now() });
  await db.messages.insert(makeMessage(CHANNEL_ID, SERVER_ID, user._id, {
    _id: 'msg_bot_1', botId: BOT_ID, content: 'Click a button!',
  }));
  await db.messages.insert(makeMessage(CHANNEL_ID, SERVER_ID, user._id, {
    _id: 'msg_normal_1', content: 'ordinary message',
  }));
});

describe('POST /api/interactions — server-authoritative routing', () => {
  it('accepts an installed bot component from a visible authorized channel', async () => {
    const res = await request(buildApp())
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'confirm', channelId: CHANNEL_ID, serverId: SERVER_ID });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects a client channel/server pair that disagrees with the persisted message', async () => {
    const res = await request(buildApp())
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'confirm', channelId: 'ch-foreign', serverId: 'srv-foreign' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('rejects components on ordinary non-bot messages', async () => {
    const res = await request(buildApp())
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'select', messageId: 'msg_normal_1', customId: 'menu', channelId: CHANNEL_ID, serverId: SERVER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an interactive bot/i);
  });

  it('fails closed when current channel permissions no longer allow bot commands', async () => {
    mockResolvePermissions.mockResolvedValue(1 << 0); // VIEW only
    const res = await request(buildApp())
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'confirm' });
    expect(res.status).toBe(403);
  });

  it('rejects a bot message after the bot is no longer installed in that server', async () => {
    await db.serverBots.remove({ botId: BOT_ID, serverId: SERVER_ID });
    const res = await request(buildApp())
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'confirm' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not installed/i);
  });

  it('emits only to the authoritative channel room — never global io.emit', async () => {
    const roomEmit = jest.fn();
    const io = { to: jest.fn(() => ({ emit: roomEmit })), emit: jest.fn() };
    const res = await request(buildApp(io))
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'confirm', channelId: CHANNEL_ID, serverId: SERVER_ID });

    expect(res.status).toBe(200);
    expect(io.to).toHaveBeenCalledWith(`channel:${CHANNEL_ID}`);
    expect(roomEmit).toHaveBeenCalledWith('interaction', expect.objectContaining({
      channelId: CHANNEL_ID, serverId: SERVER_ID, botId: BOT_ID, userId: user._id,
    }));
    expect(io.emit).not.toHaveBeenCalled();
  });
});

describe('context commands — installed bot/server authority', () => {
  it('user command requires the target user to still be a member of the same server', async () => {
    const res = await request(buildApp())
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'user_command', customId: 'inspect-user', targetUserId: 'u-foreign', serverId: SERVER_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target user/i);
  });

  it('does not expose context commands when USE_BOT_COMMANDS is revoked', async () => {
    mockResolvePermissions.mockResolvedValue(1 << 0);
    const res = await request(buildApp())
      .get(`/api/interactions/context-commands?serverId=${SERVER_ID}`)
      .set('Authorization', `Bearer ${token(user._id)}`);
    expect(res.status).toBe(403);
  });

  it('lists only commands from bots installed in the requested server', async () => {
    await db.bots.insert({ _id: 'foreign-bot', username: 'Foreign', contextCommands: JSON.stringify([{ name: 'foreign' }]), createdAt: Date.now() });
    const res = await request(buildApp())
      .get(`/api/interactions/context-commands?serverId=${SERVER_ID}`)
      .set('Authorization', `Bearer ${token(user._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.map((x: any) => x.botId)).toEqual([BOT_ID]);
  });
});

describe('interaction runtime input/failure branches', () => {
  it.each([
    { type: 7 },
    { type: 'button', messageId: {}, customId: 'x' },
    { type: 'button', messageId: 'msg_bot_1', customId: {} },
    { type: 'message_command', customId: 'x', targetMessageId: {} },
    { type: 'user_command', customId: 'x', targetUserId: [] },
  ])('rejects malformed locator/body values %#', async (body) => {
    const res = await request(buildApp()).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`).send(body);
    expect(res.status).toBe(400);
  });

  it('rejects modal_submit without object modalData', async () => {
    const res = await request(buildApp()).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'modal_submit', messageId: 'msg_bot_1', customId: 'modal', modalData: 'bad' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the authoritative component message vanished', async () => {
    const res = await request(buildApp()).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'missing', customId: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when a persisted bot message lacks channel/server authority', async () => {
    await db.messages.insert({ _id: 'broken-authority', authorId: user._id, botId: BOT_ID, content: 'x', createdAt: Date.now() });
    const res = await request(buildApp()).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'broken-authority', customId: 'x' });
    expect(res.status).toBe(409);
  });

  it('returns a non-enumerating 403 when installed-bot authority disappears after message resolution', async () => {
    await db.bots.remove({ _id: BOT_ID });
    const res = await request(buildApp()).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'x' });
    expect(res.status).toBe(403);
  });

  it('authorizes and emits message context commands from the target message authority', async () => {
    await db.bots.update({ _id: BOT_ID }, { $set: { contextCommands: [{ name: 'inspect-message' }] } });
    const roomEmit = jest.fn(); const io = { to: jest.fn(() => ({ emit: roomEmit })) };
    const res = await request(buildApp(io)).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'message_command', customId: 'inspect-message', targetMessageId: 'msg_normal_1' });
    expect(res.status).toBe(200);
    expect(io.to).toHaveBeenCalledWith(`channel:${CHANNEL_ID}`);
  });

  it('user context without channel emits only to authoritative server room', async () => {
    await db.members.insert({ userId: 'target-member', serverId: SERVER_ID, roles: [], joinedAt: Date.now() });
    const roomEmit = jest.fn(); const io = { to: jest.fn(() => ({ emit: roomEmit })) };
    const res = await request(buildApp(io)).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'user_command', customId: 'inspect-user', targetUserId: 'target-member', serverId: SERVER_ID });
    expect(res.status).toBe(200);
    expect(io.to).toHaveBeenCalledWith(`server:${SERVER_ID}`);
  });

  it('fails closed when server-wide context permission resolution fails', async () => {
    await db.members.insert({ userId: 'target-member', serverId: SERVER_ID, roles: [], joinedAt: Date.now() });
    mockResolvePermissions.mockRejectedValue(new Error('permission backend down'));
    const res = await request(buildApp()).post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'user_command', customId: 'inspect-user', targetUserId: 'target-member', serverId: SERVER_ID });
    expect(res.status).toBe(403);
  });

  it('skips malformed persisted contextCommands instead of returning 500', async () => {
    await db.bots.update({ _id: BOT_ID }, { $set: { contextCommands: '{broken-json' } });
    const res = await request(buildApp()).get(`/api/interactions/context-commands?serverId=${SERVER_ID}`)
      .set('Authorization', `Bearer ${token(user._id)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('handles an empty installed-bot set without querying arbitrary bots', async () => {
    await db.serverBots.remove({ botId: BOT_ID, serverId: SERVER_ID });
    const res = await request(buildApp()).get(`/api/interactions/context-commands?serverId=${SERVER_ID}`)
      .set('Authorization', `Bearer ${token(user._id)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
