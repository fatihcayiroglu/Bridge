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
function engagement(id: string) {
  return request(app).get(`/api/semantic/engagement/${serverId}`).set('Authorization', `Bearer ${tokens.get(id)}`);
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

it('excludes unreadable history from engagement totals, participants and peak hours', async () => {
  const activityAt = new Date(Date.now() - 86400000);
  activityAt.setHours(12, 0, 0, 0);
  await db.messages.update({ _id: messageId }, { $set: { createdAt: activityAt.getTime() } });
  const permissions = await resolvePermissions(carol, serverId, channelId);
  expect(hasPermission(permissions, PERMS.VIEW_CHANNELS)).toBe(true);
  expect(hasPermission(permissions, PERMS.READ_HISTORY)).toBe(false);

  const authorizedPeriods = [7, 14, 30].map(days => ({
    days, messages: 1, activeUsers: 1, totalMembers: 3, engagementPct: 33,
  }));
  const allowed = await engagement(dave);
  expect(allowed.status).toBe(200);
  expect(allowed.body.periods).toEqual(authorizedPeriods);
  expect(allowed.body.peakHour).toBe(12);

  const denied = await engagement(carol);
  expect(denied.status).toBe(200);
  expect(denied.body.periods).toEqual([7, 14, 30].map(days => ({
    days, messages: 0, activeUsers: 0, totalMembers: 3, engagementPct: 0,
  })));
  expect(denied.body.peakHour).toBe(0);
  expect(denied.body.trend).toEqual({ pct: 0, direction: 'stable' });

  const owner = await engagement(alice);
  expect(owner.status).toBe(200);
  expect(owner.body.periods).toEqual(authorizedPeriods);
  expect(owner.body.peakHour).toBe(12);
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

it('does not publish encrypted message payloads through digest topMessages', async () => {
  const positive = await digest(alice);
  expect(positive.body.channelStats[0].topMessages[0].content).toBe(secret);
  await db.messages.update({ _id: messageId }, { $set: { content: '🔒e2e:synthetic-ciphertext' } });
  const encrypted = await digest(dave);
  expect(encrypted.status).toBe(200);
  expect(encrypted.body.channelStats).toEqual([]);
  expect(JSON.stringify(encrypted.body)).not.toContain('synthetic-ciphertext');
});

it('excludes system payloads from warmed and fresh digests while retaining readable normal messages', async () => {
  const normalId = randomUUID();
  const normalContent = 'Readable normal message positive control';
  await db.messages.insert({ _id: normalId, serverId, channelId, userId: dave, content: normalContent, type: 'normal', deletedAt: null, createdAt: Date.now(), reactions: '{"ok":["dave"]}' });
  const positive = await digest(alice);
  expect(positive.status).toBe(200);
  expect(positive.body.totalMessages).toBe(2);
  expect(positive.body.channelStats[0].topMessages.map((message: { content: string }) => message.content)).toEqual(expect.arrayContaining([secret, normalContent]));

  await db.messages.update({ _id: messageId }, { $set: { type: 'system' } });
  for (const id of [alice, dave]) {
    const filtered = await digest(id);
    expect(filtered.status).toBe(200);
    expect(filtered.body.totalMessages).toBe(1);
    expect(filtered.body.channelStats).toHaveLength(1);
    expect(filtered.body.channelStats[0].messageCount).toBe(1);
    expect(filtered.body.channelStats[0].topMessages).toHaveLength(1);
    expect(filtered.body.channelStats[0].topMessages[0]).toMatchObject({ _id: normalId, content: normalContent });
    expect(filtered.body.topUsers).toEqual([{ userId: dave, messageCount: 1, username: 'Test User' }]);
    expect(JSON.stringify(filtered.body)).not.toContain(secret);
  }
});

it('does not preserve an AI explanation containing revoked content in cached search responses', async () => {
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

it('replaces old quoted explanations after a message edit while keeping current authorized matches', async () => {
  const positive = await search(dave);
  expect(positive.status).toBe(200);
  expect(positive.body.matches).toHaveLength(1);
  expect(positive.body.matches[0].content).toBe(secret);
  const key = `sem:${dave}:${serverId}::confidentialproject:7:10:noai`;
  await cache.set(key, { ...positive.body, provider: 'synthetic-ai-cache-fixture', explanation: secret }, 180);
  expect(await cache.get(key)).toMatchObject({ explanation: secret });

  const currentContent = 'confidentialproject revised content safe to retain';
  await db.messages.update({ _id: messageId }, { $set: { content: currentContent } });
  const edited = await search(dave);
  expect(edited.status).toBe(200);
  expect(edited.body.cached).toBe(true);
  expect(edited.body.matches).toHaveLength(1);
  expect(edited.body.matches[0]).toMatchObject({ _id: messageId, content: currentContent });
  expect(typeof edited.body.explanation).toBe('string');
  expect(edited.body.explanation.length).toBeGreaterThan(0);
  expect(JSON.stringify(edited.body)).not.toContain(secret);

  const fresh = await search(alice);
  expect(fresh.status).toBe(200);
  expect(fresh.body.matches).toHaveLength(1);
  expect(fresh.body.matches[0].content).toBe(currentContent);
  expect(JSON.stringify(fresh.body)).not.toContain(secret);
});
