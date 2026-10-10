// Fails closed without live prerequisites; no mocked database, Redis, permissions,
// authentication or CSRF. Run only against the disposable audit database.
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';

if (!process.env.PG_TEST_URL || !process.env.REDIS_TEST_URL) {
  throw new Error('semantic confidentiality proof requires PG_TEST_URL and REDIS_TEST_URL');
}
process.env.REDIS_URL = process.env.REDIS_TEST_URL;
const db = require('../../db/loader').default;
const adapter = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
const { makeToken } = require('../../middleware/auth') as typeof import('../../middleware/auth');
const { enforceApiCsrf } = require('../../middleware/csrf') as typeof import('../../middleware/csrf');
const { generateCsrfToken } = require('../../lib/security') as typeof import('../../lib/security');
const { PERMS } = require('../../lib/permissions') as typeof import('../../lib/permissions');
const router = require('../../routes/semantic').default;
const app = express();
app.use(express.json());
app.use('/api/semantic', enforceApiCsrf, router);

let alice: string, bob: string, carol: string, serverId: string, channelId: string, messageId: string;
const tokens = new Map<string, string>();
const csrf = new Map<string, string>();
const secret = 'confidentialproject disposable-live-fixture';
const q = (sql: string, args: unknown[] = []) => db._pool.query(sql, args);

beforeAll(async () => {
  await db._initSchema();
  await adapter.applyAdapter({});
  expect(adapter.isRedisAvailable()).toBe(true);
}, 60_000);

beforeEach(async () => {
  [alice, bob, carol, serverId, channelId, messageId] = Array.from({ length: 6 }, () => randomUUID()) as [string, string, string, string, string, string];
  for (const userId of [alice, bob, carol]) {
    await q('INSERT INTO users (_id,username,"displayName",password,"tokenVersion","createdAt") VALUES ($1,$2,$3,$4,0,$5)', [userId, `audit_${userId.slice(0,8)}`, 'Synthetic audit user', 'unused-test-account-not-a-login-credential', Date.now()]);
    tokens.set(userId, makeToken({ _id: userId, username: `audit_${userId.slice(0,8)}`, tokenVersion: 0 }));
    csrf.set(userId, await generateCsrfToken(userId));
  }
  await q('INSERT INTO servers (_id,name,"ownerId","createdAt","aiEnabled") VALUES ($1,$2,$3,$4,false)', [serverId, 'Disposable audit', alice, Date.now()]);
  for (const userId of [alice, carol]) {
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3,$4)', [userId, serverId, '[]', Date.now()]);
  }
  await q('INSERT INTO channels (_id,"serverId",name,type,"createdAt") VALUES ($1,$2,$3,$4,$5)', [channelId, serverId, 'private-project', 'text', Date.now()]);
  await q('INSERT INTO messages (_id,"serverId","channelId","userId",content,type,"createdAt",reactions,username,"displayName") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [messageId, serverId, channelId, alice, secret, 'normal', Date.now(), '{"ok":["alice"]}', 'Synthetic audit user', 'Synthetic audit user']);
});

afterEach(async () => {
  await q('DELETE FROM channel_overrides WHERE "channelId"=$1', [channelId]);
  await q('DELETE FROM messages WHERE "channelId"=$1', [channelId]);
  await q('DELETE FROM members WHERE "serverId"=$1', [serverId]);
  await q('DELETE FROM channels WHERE _id=$1', [channelId]);
  await q('DELETE FROM servers WHERE _id=$1', [serverId]);
  await q('DELETE FROM users WHERE _id=ANY($1::text[])', [[alice, bob, carol]]);
  for (const id of [alice, bob, carol]) {
    await adapter.cache.invalidatePattern(`sem:${id}:`);
    await adapter.cache.invalidatePattern(`digest:v2:${id}:`);
  }
});

afterAll(async () => {
  await adapter.disconnect();
  await db._pool.end();
});

function search(id: string) {
  return request(app).post('/api/semantic/search').set('Authorization', `Bearer ${tokens.get(id)}`).set('X-CSRF-Token', csrf.get(id)!).send({ serverId, query: 'confidentialproject' });
}
function digest(id: string) {
  return request(app).get(`/api/semantic/digest/${serverId}`).set('Authorization', `Bearer ${tokens.get(id)}`);
}
async function deny(permission: number) {
  await q('INSERT INTO channel_overrides (_id,"channelId","targetType","targetId",allow,deny) VALUES ($1,$2,$3,$4,0,$5)', [randomUUID(), channelId, 'user', carol, permission]);
}

it('Alice reads actual stored content, Bob is refused, and Carol without READ_HISTORY gets no history', async () => {
  const allowed = await search(alice);
  expect(allowed.status).toBe(200);
  expect(allowed.body.matches[0].content).toBe(secret);
  const outsider = await search(bob);
  expect(outsider.status).toBe(403);
  await deny(PERMS.READ_HISTORY);
  const restricted = await search(carol);
  expect(restricted.status).toBe(200);
  expect(restricted.body.matches).toEqual([]);
  expect(JSON.stringify(restricted.body)).not.toContain(secret);
  const summary = await digest(carol);
  expect(summary.status).toBe(200);
  expect(summary.body.channelStats).toEqual([]);
  expect(summary.body.totalMessages).toBe(0);
});

it('a real Redis cache hit remains useful, but revocation immediately removes content and aggregates', async () => {
  const first = await digest(carol);
  expect(first.status).toBe(200);
  expect(first.body.channelStats[0].topMessages[0].content).toBe(secret);
  const warmed = await digest(carol);
  expect(warmed.status).toBe(200);
  expect(warmed.body.cached).toBe(true);
  expect(warmed.body.totalMessages).toBe(1);
  await deny(PERMS.VIEW_CHANNELS);
  const revoked = await digest(carol);
  expect(revoked.status).toBe(200);
  expect(revoked.body.channelStats).toEqual([]);
  expect(revoked.body.totalMessages).toBe(0);
  expect(JSON.stringify(revoked.body)).not.toContain(secret);
  const owner = await digest(alice);
  expect(owner.body.channelStats[0].topMessages[0].content).toBe(secret);
});

it('deleting a message prevents both warmed and fresh digest delivery', async () => {
  const first = await digest(carol);
  expect(first.body.channelStats[0].topMessages[0].content).toBe(secret);
  await q('UPDATE messages SET "deletedAt"=$2 WHERE _id=$1', [messageId, Date.now()]);
  for (const id of [carol, alice]) {
    const response = await digest(id);
    expect(response.status).toBe(200);
    expect(response.body.channelStats).toEqual([]);
    expect(response.body.totalMessages).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain(secret);
  }
});
