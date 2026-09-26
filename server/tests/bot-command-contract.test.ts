process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    bots: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    general: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    write: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: { headers: Record<string, string | undefined>; user?: { id: string } }, res: { status(n: number): { json(v: unknown): void } }, next: () => void) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id };
    next();
  },
}));
const USE_BOT_COMMANDS = 1 << 21;
jest.mock('../lib/permissions', () => ({
  PERMS: { USE_BOT_COMMANDS, MANAGE_SERVER: 1 << 3, ADMIN: 1 << 30 },
  hasPermission: (mask: number, bit: number) => (mask & bit) === bit,
  resolvePermissions: jest.fn(async () => USE_BOT_COMMANDS),
}));

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import db from '../db/loader';
import botsRouter from '../routes/bots';
import { Bots } from '../db/repositories';
import { normalizeContextCommands, normalizeSlashCommands } from '../lib/botCommands';

const SERVER = 'server-bot-contract';
const USER = 'user-bot-contract';
const TOKEN = `brg_bot_${'a'.repeat(43)}`;
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bots', botsRouter);
  return a;
}

beforeEach(async () => {
  db._reset?.();
  await db.bots.insert({
    _id: 'bot-owned', serverId: SERVER, ownerId: USER, username: 'Owned',
    description: '', tokenHash: HASH, active: true, permissions: 256,
    contextCommands: [], slashCommands: [{ name: 'ping', description: 'Pong', usage: '/ping' }], createdAt: Date.now(),
  });
});

describe('bot token self-service and slash discovery', () => {
  test('GET /me authenticates opaque token and never exposes tokenHash', async () => {
    const res = await request(app()).get('/api/bots/me').set('Authorization', `Bot ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ _id: 'bot-owned', username: 'Owned', name: 'Owned' });
    expect(res.body.tokenHash).toBeUndefined();
  });

  test('inactive token is rejected', async () => {
    await db.bots.update({ _id: 'bot-owned' }, { $set: { active: false } });
    const res = await request(app()).get('/api/bots/me').set('Authorization', `Bot ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  test('bot auth storage failure is fail-closed and retryable', async () => {
    const spy = jest.spyOn(Bots, 'findByTokenHash').mockRejectedValueOnce(new Error('db down'));
    const res = await request(app()).get('/api/bots/me').set('Authorization', `Bot ${TOKEN}`);
    expect(res.status).toBe(503);
    spy.mockRestore();
    expect((await request(app()).get('/api/bots/me').set('Authorization', `Bot ${TOKEN}`)).status).toBe(200);
  });

  test('slash metadata PATCH validates and persists canonical JSONB data', async () => {
    const ok = await request(app()).patch('/api/bots/me/slash-commands')
      .set('Authorization', `Bot ${TOKEN}`)
      .send({ commands: [{ name: 'Help', description: 'no uppercase allowed', usage: '/help' }] });
    expect(ok.status).toBe(400);

    const valid = await request(app()).patch('/api/bots/me/slash-commands')
      .set('Authorization', `Bot ${TOKEN}`)
      .send({ commands: [{ name: 'help', description: 'Help', usage: '/help [topic]' }] });
    expect(valid.status).toBe(200);
    const saved = await db.bots.findOne({ _id: 'bot-owned' });
    expect(saved?.slashCommands).toEqual([{ name: 'help', description: 'Help', usage: '/help [topic]' }]);
  });

  test('command discovery includes direct server bots and linked installed bots, not inactive bots', async () => {
    await db.bots.insert({
      _id: 'portable', serverId: 'home', ownerId: USER, username: 'Portable', tokenHash: 'h2', active: true,
      slashCommands: [{ name: 'weather', description: 'Weather', usage: '/weather' }], contextCommands: [], createdAt: 1,
    });
    await db.serverBots.insert({ _id: 'link', botId: 'portable', serverId: SERVER, addedBy: USER, addedAt: 1 });
    await db.bots.insert({
      _id: 'inactive', serverId: SERVER, ownerId: USER, username: 'Off', tokenHash: 'h3', active: false,
      slashCommands: [{ name: 'ghost', description: '', usage: '' }], contextCommands: [], createdAt: 1,
    });

    const res = await request(app()).get(`/api/bots/commands?serverId=${SERVER}`).set('x-test-user', USER);
    expect(res.status).toBe(200);
    expect(res.body.commands.map((c: { name: string }) => c.name).sort()).toEqual(['ping', 'weather']);
  });
});

describe('bot command metadata validators', () => {
  test('slash validation rejects duplicates, malformed types and oversize arrays', () => {
    expect(normalizeSlashCommands([{ name: 'x' }, { name: 'x' }])).toBeNull();
    expect(normalizeSlashCommands([{ name: 'Bad Name' }])).toBeNull();
    expect(normalizeSlashCommands([{ name: 'x', description: 7 }])).toBeNull();
    expect(normalizeSlashCommands(Array.from({ length: 101 }, (_, i) => ({ name: `x${i}` })))).toBeNull();
  });

  test('context validation is strict and duplicate-safe', () => {
    expect(normalizeContextCommands([{ name: 'Who', type: 'USER_COMMAND' }])).toEqual([
      { name: 'Who', type: 'USER_COMMAND', description: '' },
    ]);
    expect(normalizeContextCommands([{ name: 'Who', type: 'user' }])).toBeNull();
    expect(normalizeContextCommands([{ name: 'Who', type: 'USER_COMMAND' }, { name: 'Who', type: 'MESSAGE_COMMAND' }])).toBeNull();
  });
});
