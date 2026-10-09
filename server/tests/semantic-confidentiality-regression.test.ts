// Real authentication, repository adapters, permission resolution and route handlers.
// The database is hermetic; live PostgreSQL/Redis proof is recorded separately.
import request from 'supertest';
import express from 'express';
import { randomUUID } from 'crypto';
import { createMockDb, makeUser } from './helpers/mockDb';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/aiProvider', () => ({ AI_ENABLED: false, PROVIDER: 'rules', callAI: jest.fn() }));
jest.mock('../lib/pgvector', () => ({ PGVECTOR_ENABLED: false, generateEmbedding: jest.fn(), vectorSearch: jest.fn() }));

import semanticRouter from '../routes/semantic';
import { makeToken } from '../middleware/auth';
import { resolvePermissions, hasPermission, PERMS, DEFAULT_PERMISSIONS } from '../lib/permissions';
import { cache } from '../lib/redisAdapter';

const db = require('../db/loader') as ReturnType<typeof createMockDb>;
const app = express();
app.use(express.json());
app.use('/api/semantic', semanticRouter);

let alice: string, bob: string, carol: string, dave: string;
let serverId: string, channelId: string, messageId: string;
const secret = 'confidentialproject independent-audit synthetic content';
const tokens = new Map<string, string>();

beforeEach(async () => {
  db._reset();
  tokens.clear();
  [alice, bob, carol, dave, serverId, channelId, messageId] = Array.from({ length: 7 }, () => randomUUID()) as [string, string, string, string, string, string, string];
  for (const id of [alice, bob, carol, dave]) {
    const user = makeUser({ _id: id, username: id, tokenVersion: 0 });
    await db.users.insert(user);
    tokens.set(id, makeToken(user));
  }
  await db.servers.insert({ _id: serverId, ownerId: alice, name: 'Audit fixture', aiEnabled: false });
  for (const userId of [alice, carol, dave]) {
    await db.members.insert({ userId, serverId, roles: [], joinedAt: Date.now() });
  }
  await db.channels.insert({ _id: channelId, serverId, name: 'private-project', type: 'text' });
  await db.messages.insert({ _id: messageId, serverId, channelId, userId: alice, content: secret, type: 'normal', deletedAt: null, createdAt: Date.now(), reactions: '{"ok":["alice"]}' });
  await db.channelOverrides.insert({ _id: randomUUID(), channelId, targetType: 'user', targetId: carol, allow: 0, deny: PERMS.READ_HISTORY });
});

function search(id: string) {
  return request(app).post('/api/semantic/search').set('Authorization', `Bearer ${tokens.get(id)}`).send({ serverId, query: 'confidentialproject' });
}
function digest(id: string) {
  return request(app).get(`/api/semantic/digest/${serverId}`).set('Authorization', `Bearer ${tokens.get(id)}`);
}

it('proves Alice can read and Bob cannot before testing restricted Carol', async () => {
  const positive = await search(alice);
  expect(positive.status).toBe(200);
  expect(positive.body.matches).toHaveLength(1);
  expect(positive.body.matches[0].content).toBe(secret);
  const negative = await search(bob);
  expect(negative.status).toBe(403);
  expect(JSON.stringify(negative.body)).not.toContain(secret);
  const unauthenticated = await request(app).post('/api/semantic/search').send({ serverId, query: 'confidentialproject' });
  expect(unauthenticated.status).toBe(401);
});

it('never returns history to a member with VIEW_CHANNELS but no READ_HISTORY', async () => {
  const permissions = await resolvePermissions(carol, serverId, channelId);
  expect(hasPermission(permissions, PERMS.VIEW_CHANNELS)).toBe(true);
  expect(hasPermission(permissions, PERMS.READ_HISTORY)).toBe(false);
  const allowed = await search(dave);
  expect(allowed.status).toBe(200);
  expect(allowed.body.matches[0].content).toBe(secret);
  const denied = await search(carol);
  expect(denied.status).toBe(200);
  expect(denied.body.matches).toEqual([]);
  expect(JSON.stringify(denied.body)).not.toContain(secret);
});

it('applies the same READ_HISTORY boundary to the weekly digest', async () => {
  const positive = await digest(alice);
  expect(positive.status).toBe(200);
  expect(positive.body.channelStats[0].topMessages[0].content).toBe(secret);
  const denied = await digest(carol);
  expect(denied.status).toBe(200);
  expect(denied.body.channelStats).toEqual([]);
  expect(denied.body.totalMessages).toBe(0);
  expect(JSON.stringify(denied.body)).not.toContain(secret);
});

it('does not let a moderator privilege imply read-history permission; an administrator is an explicit positive control', async () => {
  const moderatorRole = randomUUID(), administratorRole = randomUUID();
  await db.roles.insert({ _id: moderatorRole, serverId, permissions: (DEFAULT_PERMISSIONS & ~PERMS.READ_HISTORY) | PERMS.MANAGE_MESSAGES });
  await db.roles.insert({ _id: administratorRole, serverId, permissions: PERMS.ADMINISTRATOR });
  await db.members.update({ userId: dave, serverId }, { $set: { roles: [moderatorRole] } });
  const moderator = await search(dave);
  expect(moderator.status).toBe(200);
  expect(moderator.body.matches).toEqual([]);
  await db.members.update({ userId: dave, serverId }, { $set: { roles: [administratorRole] } });
  const administrator = await search(dave);
  expect(administrator.status).toBe(200);
  expect(administrator.body.matches[0].content).toBe(secret);
});

it('revokes a previously authorized digest immediately, including cached summaries and aggregates', async () => {
  const initial = await digest(dave);
  expect(initial.status).toBe(200);
  expect(initial.body.totalMessages).toBe(1);
  expect(initial.body.channelStats[0].topMessages[0].content).toBe(secret);
  await db.channelOverrides.insert({ _id: randomUUID(), channelId, targetType: 'user', targetId: dave, allow: 0, deny: PERMS.VIEW_CHANNELS });
  const revoked = await digest(dave);
  expect(revoked.status).toBe(200);
  expect(revoked.body.channelStats).toEqual([]);
  expect(revoked.body.topUsers).toEqual([]);
  expect(revoked.body.totalMessages).toBe(0);
  expect(JSON.stringify(revoked.body)).not.toContain(secret);
  const stillAuthorized = await digest(alice);
  expect(stillAuthorized.body.channelStats[0].topMessages[0].content).toBe(secret);
});

it('does not retain deleted text in either a fresh or a warmed digest', async () => {
  const initial = await digest(dave);
  expect(initial.body.channelStats[0].topMessages[0].content).toBe(secret);
  await db.messages.update({ _id: messageId }, { $set: { deletedAt: Date.now() } });
  for (const id of [dave, alice]) {
    const deleted = await digest(id);
    expect(deleted.status).toBe(200);
    expect(deleted.body.channelStats).toEqual([]);
    expect(deleted.body.totalMessages).toBe(0);
    expect(JSON.stringify(deleted.body)).not.toContain(secret);
  }
});

it('does not publish encrypted or system message payloads through digest topMessages', async () => {
  const positive = await digest(alice);
  expect(positive.body.channelStats[0].topMessages[0].content).toBe(secret);
  await db.messages.update({ _id: messageId }, { $set: { content: '🔒e2e:synthetic-ciphertext' } });
  const encrypted = await digest(dave);
  expect(encrypted.status).toBe(200);
  expect(encrypted.body.channelStats).toEqual([]);
  expect(JSON.stringify(encrypted.body)).not.toContain('synthetic-ciphertext');
});

it('does not preserve an AI explanation containing revoked or edited content in cached search responses', async () => {
  const positive = await search(dave);
  expect(positive.status).toBe(200);
  expect(positive.body.matches[0].content).toBe(secret);
  const key = `sem:${dave}:${serverId}::confidentialproject:7:10:noai`;
  await cache.set(key, { ...positive.body, provider: 'synthetic-ai-cache-fixture', explanation: secret }, 180);
  await db.channelOverrides.insert({ _id: randomUUID(), channelId, targetType: 'user', targetId: dave, allow: 0, deny: PERMS.VIEW_CHANNELS });
  const revoked = await search(dave);
  expect(revoked.status).toBe(200);
  expect(revoked.body.matches).toEqual([]);
  expect(JSON.stringify(revoked.body)).not.toContain(secret);
});
