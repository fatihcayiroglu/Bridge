// server/tests/message-history-cursor.test.ts
//
// Final21 Faz 19 (19-27) — kanal geçmişi imleci: METİN `ts` (PostgreSQL BIGINT) ve sayı `ts`.
// Gerçek veritabanı kanıtı: tests/pg-integration/message-history-cursor.pgtest.ts. Burada depo
// `createdAt`'i PostgreSQL gibi METİN döndürür; rota imleci yine SAYI yazmalı ve metin taşıyan
// eski imleçleri de kabul etmelidir.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'cur-owner' }; next(); },
}));
jest.mock('../lib/redisAdapter', () => ({
  ...jest.requireActual('../lib/redisAdapter'),
  cache: { invalidatePattern: jest.fn().mockResolvedValue(undefined), get: async () => null, set: async () => undefined, del: async () => undefined },
}));

import request from 'supertest';
import express from 'express';
import messagesRouter from '../routes/messages';
import { Messages } from '../db/repositories';

const app = express();
app.use(express.json());
app.use('/api/channels', messagesRouter);

const SRV = 'cur-srv';
const CH = 'cur-ch';
const T0 = 1_790_000_000_000;
const enc = (o: unknown) => encodeURIComponent(Buffer.from(JSON.stringify(o)).toString('base64'));
const decode = (c: string) => JSON.parse(Buffer.from(c, 'base64').toString('utf8'));

beforeAll(async () => {
  await mockDb.users.insert({ _id: 'cur-owner', username: 'o', displayName: 'O' });
  await mockDb.servers.insert({ _id: SRV, name: 'S', ownerId: 'cur-owner', createdAt: 1 });
  await mockDb.members.insert({ userId: 'cur-owner', serverId: SRV, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: CH, serverId: SRV, name: 'c', type: 'text', createdAt: 1 });
  for (let i = 1; i <= 5; i++) {
    await mockDb.messages.insert({ _id: `cur-m${i}`, channelId: CH, serverId: SRV, userId: 'cur-owner', content: `m${i}`, createdAt: T0 + i });
  }
});

it('PostgreSQL gibi METİN createdAt dönse de prevCursor/nextCursor SAYI ts taşır', async () => {
  const real = Messages.findByChannel.bind(Messages);
  // Bildirilen tip `createdAt: number` der; PostgreSQL'de node-pg BIGINT'i METİN döndürür. Kusurun
  // kendisi bu uyumsuzluktur, bu yüzden dönüşüm `unknown` üzerinden BİLEREK yapılır.
  const spy = jest.spyOn(Messages, 'findByChannel').mockImplementation(async (...args: Parameters<typeof real>) =>
    (await real(...args)).map((m) => ({ ...m, createdAt: String(m.createdAt) })) as unknown as Awaited<ReturnType<typeof real>>);
  try {
    const res = await request(app).get(`/api/channels/${CH}/messages?limit=2`);
    expect(res.status).toBe(200);
    expect(decode(res.body.prevCursor)).toEqual({ ts: T0 + 4, id: 'cur-m4', dir: 'before' });
    expect(decode(res.body.nextCursor)).toEqual({ ts: T0 + 5, id: 'cur-m5', dir: 'after' });
  } finally {
    spy.mockRestore();
  }
});

it('METİN ts taşıyan (önceki sürümün ürettiği) imleç kabul edilir ve doğru sayfayı verir', async () => {
  const res = await request(app).get(`/api/channels/${CH}/messages?limit=2&cursor=${enc({ ts: String(T0 + 3), id: 'cur-m3', dir: 'before' })}`);
  expect(res.status).toBe(200);
  expect(res.body.messages.map((m: { _id: string }) => m._id)).toEqual(['cur-m1', 'cur-m2']);
});

it.each([
  [{ ts: '12a', id: 'x', dir: 'before' }], [{ ts: '-5', id: 'x', dir: 'before' }], [{ ts: '', id: 'x', dir: 'before' }],
  [{ ts: '12345678901234567', id: 'x', dir: 'before' }], [{ ts: 1.5, id: 'x', dir: 'before' }], [{ ts: -1, id: 'x', dir: 'before' }],
])('bozuk imleç 400 kalır: %j', async (bad) => {
  const res = await request(app).get(`/api/channels/${CH}/messages?cursor=${enc(bad)}`);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Invalid cursor');
});
