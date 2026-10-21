// server/tests/report-evidence-flow.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// P7 B5 (#336) — A REPORT IS EVIDENCE-SAFE
// ════════════════════════════════════════════════════════════════════════════
// Reproduced on main b1a5ed3 / 17d0a6a through the real routes: a report stored
// only the message id and the moderator queue showed the message's CURRENT text,
// so the reported author decided what the moderator reviewed:
//
//   author edits after the report   → queue showed "totally benign now"
//   author deletes after the report → queue showed "[Mesaj silindi]"
//   a ban that removes recent messages (hard delete) → the report vanished
//
// Each case here goes through POST /api/messages/:id/report, the real edit and
// delete functions (the REST and Socket.IO paths share them), the real ban route
// and GET /api/servers/:id/reports. Against the pre-#336 code every "evidence"
// assertion fails: there is no `evidence` field and a removed message drops the
// report from the queue.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: Request & { user?: unknown }, res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwtLib = require('jsonwebtoken');
    try { req.user = jwtLib.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
  verifyToken: (t: string) => {
    try { return require('jsonwebtoken').verify(t, 'test-jwt-secret-long-enough-32chars!!'); } catch { return null; }
  },
}));

jest.mock('../lib/redisAdapter', () => ({
  ...jest.requireActual('../lib/redisAdapter'),
  cache: {
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: async () => null, set: async () => undefined, del: async () => undefined,
  },
}));

import request from 'supertest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
const jwt = require('jsonwebtoken');

import messagesRouter from '../routes/messages';
import moderationRouter from '../routes/moderation';
import { editChannelMessage, deleteChannelMessage } from '../lib/messageMutations';
import { runReportEvidenceRetentionTick } from '../jobs/reportEvidenceRetention';

const app = express();
app.use(express.json());
app.use('/api/messages', messagesRouter);
app.use('/api/servers/:serverId', moderationRouter);
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) =>
  res.status(err.status ?? 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const SRV = 'srv-ev';
const CH = 'ch-ev';
const MOD = 'ev-moderator';     // server owner: every permission
const REPORTER = 'ev-reporter';
const AUTHOR = 'ev-author';
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
async function postBy(author: string, content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const _id = `ev-msg-${++seq}`;
  await mockDb.messages.insert({
    _id, channelId: CH, serverId: SRV, userId: author, username: author, displayName: 'Abuser',
    content, contentFormat: 1, type: 'normal', reactions: {}, createdAt: Date.now() - 1000, ...extra,
  });
  return _id;
}

async function report(messageId: string, by = REPORTER) {
  return request(app).post(`/api/messages/${messageId}/report`)
    .set('Authorization', `Bearer ${tok(by)}`).send({ reason: 'harassment' });
}

async function queue(as = MOD) {
  return request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', `Bearer ${tok(as)}`);
}

async function queued(messageId: string) {
  const res = await queue();
  expect(res.status).toBe(200);
  return (res.body.reports as Array<Record<string, any>>).find(r => r.messageId === messageId);
}

beforeAll(async () => {
  for (const id of [MOD, REPORTER, AUTHOR]) await mockDb.users.insert({ _id: id, username: id, displayName: id });
  await mockDb.servers.insert({ _id: SRV, name: 'Evidence', ownerId: MOD, createdAt: 1 });
  for (const id of [MOD, REPORTER, AUTHOR]) await mockDb.members.insert({ userId: id, serverId: SRV, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: CH, serverId: SRV, name: 'general', type: 'text', createdAt: 1 });
});

describe('the queue shows what was reported, not what the author changed it to', () => {
  it('author edits after the report', async () => {
    const id = await postBy(AUTHOR, 'abusive original text');
    expect((await report(id)).status).toBe(201);
    const edited = await editChannelMessage(null, { actorId: AUTHOR, messageId: id, content: 'totally benign now' });
    expect(edited.ok).toBe(true);

    const row = await queued(id);
    expect(row?.evidence).toMatchObject({ state: 'captured', text: 'abusive original text', authorId: AUTHOR, authorName: 'Abuser' });
    expect(row?.currentState).toBe('edited');
    expect(row?.message.preview).toBe('totally benign now');
  });

  it('author deletes after the report', async () => {
    const id = await postBy(AUTHOR, 'second abusive text');
    expect((await report(id)).status).toBe(201);
    const deleted = await deleteChannelMessage(null, { actorId: AUTHOR, messageId: id });
    expect(deleted.ok).toBe(true);
    const stored = await mockDb.messages.findOne({ _id: id }) as Record<string, unknown>;
    expect(stored.content).toBe('[Mesaj silindi]');

    const row = await queued(id);
    expect(row?.evidence).toMatchObject({ state: 'captured', text: 'second abusive text' });
    expect(row?.currentState).toBe('deleted');
  });

  it('eleven edits push the original out of the 10-version history; the snapshot keeps it', async () => {
    const id = await postBy(AUTHOR, 'original insult');
    expect((await report(id)).status).toBe(201);
    for (let i = 1; i <= 11; i += 1) {
      const r = await editChannelMessage(null, { actorId: AUTHOR, messageId: id, content: `harmless ${i}` });
      expect(r.ok).toBe(true);
    }
    const stored = await mockDb.messages.findOne({ _id: id }) as unknown as { editHistory: Array<{ content: string }> };
    expect(stored.editHistory).toHaveLength(10);
    expect(stored.editHistory.map(v => v.content)).not.toContain('original insult');

    const row = await queued(id);
    expect(row?.evidence.text).toBe('original insult');
    expect(row?.currentState).toBe('edited');
  });

  it('a ban that removes the member\'s recent messages keeps the report reviewable', async () => {
    const BANNED = 'ev-banned';
    await mockDb.users.insert({ _id: BANNED, username: BANNED, displayName: 'Raider' });
    await mockDb.members.insert({ userId: BANNED, serverId: SRV, roles: [], joinedAt: 1 });
    const id = await postBy(BANNED, 'raid spam', { displayName: 'Raider' });
    expect((await report(id)).status).toBe(201);

    const ban = await request(app).post(`/api/servers/${SRV}/bans`)
      .set('Authorization', `Bearer ${tok(MOD)}`).send({ userId: BANNED, deleteMessageDays: 1 });
    expect(ban.status).toBe(200);
    expect(await mockDb.messages.findOne({ _id: id })).toBeNull();

    const row = await queued(id);
    expect(row?.evidence).toMatchObject({ state: 'captured', text: 'raid spam', authorId: BANNED });
    expect(row?.currentState).toBe('removed');
    expect(row?.message).toEqual({ displayName: 'Raider', preview: '' });
  });

  it('an unchanged message reads "unchanged"', async () => {
    const id = await postBy(AUTHOR, 'still here');
    expect((await report(id)).status).toBe(201);
    expect((await queued(id))?.currentState).toBe('unchanged');
  });

  it('an encrypted message is reported without its ciphertext', async () => {
    const id = await postBy(AUTHOR, '', { type: 'e2ee', encryptedContent: 'CIPHERTEXT-BLOB', iv: 'IV-BLOB' });
    expect((await report(id)).status).toBe(201);
    const res = await queue();
    const row = (res.body.reports as Array<Record<string, any>>).find(r => r.messageId === id);
    expect(row?.evidence).toMatchObject({ state: 'captured', text: '', messageType: 'e2ee' });
    expect(JSON.stringify(res.body)).not.toContain('CIPHERTEXT-BLOB');
    const stored = await mockDb.messageReports.findOne({ messageId: id });
    expect(JSON.stringify(stored)).not.toContain('CIPHERTEXT-BLOB');
  });
});

describe('who sees the evidence', () => {
  it('neither the reporter nor the author (no MANAGE_MESSAGES) sees the queue entries', async () => {
    const id = await postBy(AUTHOR, 'only moderators may read this');
    expect((await report(id)).status).toBe(201);
    for (const user of [REPORTER, AUTHOR]) {
      const res = await queue(user);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
      expect(JSON.stringify(res.body)).not.toContain('only moderators may read this');
    }
  });

  it('a report filed before migration 085 (no snapshot) whose message is gone is skipped, as before', async () => {
    await mockDb.messageReports.insert({
      _id: 'legacy-report', serverId: SRV, channelId: CH, messageId: 'gone-message', reporterId: REPORTER,
      reason: 'spam', detail: '', status: 'open', createdAt: 1, resolvedAt: null, resolvedBy: null, resolution: null,
    });
    const res = await queue();
    expect((res.body.reports as Array<{ id: string }>).map(r => r.id)).not.toContain('legacy-report');
  });

  it('a legacy report whose message still exists shows the current text and "unknown"', async () => {
    const id = await postBy(AUTHOR, 'legacy current text');
    await mockDb.messageReports.insert({
      _id: 'legacy-live', serverId: SRV, channelId: CH, messageId: id, reporterId: REPORTER,
      reason: 'spam', detail: '', status: 'open', createdAt: 1, resolvedAt: null, resolvedBy: null, resolution: null,
    });
    const row = await queued(id);
    expect(row?.evidence).toEqual({ state: 'not_captured' });
    expect(row?.currentState).toBe('unknown');
    expect(row?.message.preview).toBe('legacy current text');
  });
});

describe('retention', () => {
  it('clears the snapshot of a report resolved more than the retention window ago, and only that', async () => {
    const oldId = await postBy(AUTHOR, 'resolved long ago');
    const recentId = await postBy(AUTHOR, 'resolved yesterday');
    const openId = await postBy(AUTHOR, 'still open');
    const ids: Record<string, string> = {};
    for (const m of [oldId, recentId, openId]) ids[m] = (await report(m)).body.id;

    const now = Date.now();
    await mockDb.messageReports.update({ _id: ids[oldId] }, { $set: { status: 'resolved', resolution: 'resolved', resolvedAt: now - 91 * DAY, resolvedBy: MOD } });
    await mockDb.messageReports.update({ _id: ids[recentId] }, { $set: { status: 'dismissed', resolution: 'dismissed', resolvedAt: now - DAY, resolvedBy: MOD } });

    expect(await runReportEvidenceRetentionTick(now)).toBe(1);
    const old = await mockDb.messageReports.findOne({ _id: ids[oldId] }) as Record<string, unknown>;
    expect(old.evidenceText).toBeNull();
    expect(old.evidenceAuthorId).toBeNull();
    expect(old.evidenceAuthorName).toBeNull();
    expect(old.evidenceScrubbedAt).toBe(now);
    expect(typeof old.evidenceCapturedAt).toBe('number');
    expect(old.status).toBe('resolved');      // the report itself stays

    const recent = await mockDb.messageReports.findOne({ _id: ids[recentId] }) as Record<string, unknown>;
    expect(recent.evidenceText).toBe('resolved yesterday');
    const open = await mockDb.messageReports.findOne({ _id: ids[openId] }) as Record<string, unknown>;
    expect(open.evidenceText).toBe('still open');

    // Idempotent: a second pass (another node) finds nothing more to do.
    expect(await runReportEvidenceRetentionTick(now)).toBe(0);
  });
});
