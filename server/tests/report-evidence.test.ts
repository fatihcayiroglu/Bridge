// P7 B5 (#336): a reported message cannot be edited or deleted to change what moderators review.
// Real routes (report, edit, delete, queue) on the in-memory database. Local test, not PostgreSQL proof:
// the migration is proven separately in tests/pg-integration/message-report-evidence.pgtest.ts.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    try { req.user = require('jsonwebtoken').verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
  verifyToken: (t: string) => { try { return require('jsonwebtoken').verify(t, 'test-jwt-secret-long-enough-32chars!!'); } catch { return null; } },
}));
jest.mock('../lib/redisAdapter', () => ({
  ...jest.requireActual('../lib/redisAdapter'),
  cache: { invalidatePattern: jest.fn().mockResolvedValue(undefined), get: async () => null, set: async () => undefined, del: async () => undefined },
}));

import request from 'supertest';
import express from 'express';
import messagesRouter from '../routes/messages';
import moderationRouter from '../routes/moderation';
import { editChannelMessage, deleteChannelMessage } from '../lib/messageMutations';
import { buildEvidenceSnapshot, evidenceView, REPORT_EVIDENCE_MAX_TEXT, reportEvidenceEnabled } from '../lib/reportEvidence';
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use('/api/servers/:serverId', moderationRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/channels', messagesRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
const SRV = 'srv-ev', CH = 'ch-ev', REPORTER = 'ev-reporter', AUTHOR = 'ev-author', OWNER = 'ev-owner';
const ORIGINAL = 'abusive original text';

let seq = 0;
async function newReportedMessage(content = ORIGINAL, extra: Record<string, unknown> = {}) {
  const id = `ev-msg-${++seq}`;
  await mockDb.messages.insert({
    _id: id, channelId: CH, serverId: SRV, userId: AUTHOR, username: AUTHOR, displayName: 'Author',
    content, type: 'normal', reactions: {}, createdAt: 1000 + seq, ...extra,
  });
  const res = await request(app).post(`/api/messages/${id}/report`).set('Authorization', `Bearer ${tok(REPORTER)}`).send({ reason: 'harassment' });
  expect(res.status).toBe(201);
  return id;
}
const queue = async () => (await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', `Bearer ${tok(OWNER)}`)).body.reports as any[];
const forMessage = async (id: string) => (await queue()).find(r => r.messageId === id);

beforeAll(async () => {
  for (const u of [REPORTER, AUTHOR, OWNER]) await mockDb.users.insert({ _id: u, username: u, displayName: u === AUTHOR ? 'Author' : u });
  await mockDb.servers.insert({ _id: SRV, name: 'E', ownerId: OWNER, createdAt: 1 });
  for (const u of [REPORTER, AUTHOR, OWNER]) await mockDb.members.insert({ userId: u, serverId: SRV, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: CH, serverId: SRV, name: 'general', type: 'text', createdAt: 1 });
});
afterEach(() => { delete process.env.REPORT_EVIDENCE_SNAPSHOT; });

describe('feature flag (default off)', () => {
  it('is off unless exactly "1"', () => {
    expect(reportEvidenceEnabled({} as any)).toBe(false);
    expect(reportEvidenceEnabled({ REPORT_EVIDENCE_SNAPSHOT: 'true' } as any)).toBe(false);
    expect(reportEvidenceEnabled({ REPORT_EVIDENCE_SNAPSHOT: '1' } as any)).toBe(true);
  });

  it('off: no snapshot is stored and the queue behaves as before (shows current text)', async () => {
    const id = await newReportedMessage();
    const row = await mockDb.messageReports.findOne({ messageId: id });
    expect(row.evidenceCapturedAt).toBeUndefined();
    await editChannelMessage(null, { actorId: AUTHOR, messageId: id, content: 'benign now' });
    const entry = await forMessage(id);
    expect(entry.evidence).toBeUndefined();
    expect(entry.message.preview).toBe('benign now');
  });
});

describe('snapshot on (REPORT_EVIDENCE_SNAPSHOT=1)', () => {
  beforeEach(() => { process.env.REPORT_EVIDENCE_SNAPSHOT = '1'; });

  it('edit after report: the queue still shows the reported text and says it was edited', async () => {
    const id = await newReportedMessage();
    expect((await forMessage(id)).evidence.state).toBe('unchanged');
    expect((await editChannelMessage(null, { actorId: AUTHOR, messageId: id, content: 'totally benign now' })).ok).toBe(true);
    const entry = await forMessage(id);
    expect(entry.message.preview).toBe(ORIGINAL);
    expect(entry.evidence.text).toBe(ORIGINAL);
    expect(entry.evidence.state).toBe('edited');
  });

  it('11 edits (history keeps only 10): the reported text survives', async () => {
    const id = await newReportedMessage();
    for (let i = 1; i <= 11; i++) expect((await editChannelMessage(null, { actorId: AUTHOR, messageId: id, content: `edit ${i}` })).ok).toBe(true);
    const entry = await forMessage(id);
    expect(entry.evidence.text).toBe(ORIGINAL);
    expect(entry.evidence.state).toBe('edited');
  });

  it('delete after report: the queue still shows the reported text and says it was deleted', async () => {
    const id = await newReportedMessage();
    expect((await deleteChannelMessage(null, { actorId: AUTHOR, messageId: id })).ok).toBe(true);
    const entry = await forMessage(id);
    expect(entry.message.preview).toBe(ORIGINAL);
    expect(entry.message.preview).not.toContain('silindi');
    expect(entry.evidence.state).toBe('deleted');
  });

  it('stores author, timestamps and only the attachment name and type, never its URL', async () => {
    const id = await newReportedMessage('with file', { fileUrl: '/uploads/secret-token-url', fileName: 'a.png', fileType: 'image/png' });
    const row = await mockDb.messageReports.findOne({ messageId: id });
    expect(row).toMatchObject({ evidenceAuthorId: AUTHOR, evidenceAuthorName: 'Author', evidenceFileName: 'a.png', evidenceFileType: 'image/png' });
    expect(JSON.stringify(row)).not.toContain('secret-token-url');
    expect(typeof row.evidenceCapturedAt).toBe('number');
  });

  it('only a moderator sees it: the reporter and the author get no queue entry', async () => {
    await newReportedMessage();
    for (const user of [REPORTER, AUTHOR]) {
      const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', `Bearer ${tok(user)}`);
      expect(res.body.reports ?? []).toHaveLength(0);
    }
  });
});

describe('snapshot helpers', () => {
  it('bounds the text to 4000 code points without splitting a character and flags truncation', () => {
    const text = '😀'.repeat(REPORT_EVIDENCE_MAX_TEXT + 5);
    const snap = buildEvidenceSnapshot({ content: text, contentFormat: 1, userId: 'u', username: 'u' }, 5);
    expect(Array.from(snap.evidenceText)).toHaveLength(REPORT_EVIDENCE_MAX_TEXT);
    expect(snap.evidenceTextTruncated).toBe(true);
    expect(buildEvidenceSnapshot({ content: 'short', contentFormat: 1, userId: 'u' }, 5).evidenceTextTruncated).toBe(false);
  });

  it('a legacy report without a snapshot has no evidence view', () => {
    expect(evidenceView({ reason: 'spam' }, { content: 'x' })).toBeNull();
  });

  it('two edits in one millisecond are still detected by the text', () => {
    const row = { evidenceCapturedAt: 1, evidenceText: 'abc', evidenceTextTruncated: false, evidenceEditedAt: 7 };
    expect(evidenceView(row, { content: 'abc', contentFormat: 1, editedAt: 7 })!.state).toBe('unchanged');
    expect(evidenceView(row, { content: 'abd', contentFormat: 1, editedAt: 7 })!.state).toBe('edited');
  });

  it('a truncated snapshot still detects an edit through editedAt', () => {
    const row = { evidenceCapturedAt: 1, evidenceText: 'abc', evidenceTextTruncated: true, evidenceEditedAt: null };
    expect(evidenceView(row, { content: 'abc', contentFormat: 1, editedAt: 99 })!.state).toBe('edited');
    expect(evidenceView(row, { content: 'abc', contentFormat: 1 })!.state).toBe('unchanged');
  });
});
