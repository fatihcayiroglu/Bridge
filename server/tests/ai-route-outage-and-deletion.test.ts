// server/tests/ai-route-outage-and-deletion.test.ts
//
// P5 Workstream B — route-level contracts the AI lab also measures end to end:
//   AI-02  deleted messages are excluded in the query, and a summary cached
//          before a deletion is never served after it (content fingerprint);
//   AI-07  a provider outage degrades (local summary / canned suggestions /
//          503) — never a 500, never upstream text, never a cached outage.
'use strict';
process.env.NODE_ENV = 'test';

const callAI = jest.fn();
const rows: { current: Array<Record<string, unknown>> } = { current: [] };
const store = new Map<string, unknown>();
const messagesFind = jest.fn(() => ({ sort: () => ({ limit: async () => rows.current.map((r) => ({ ...r })) }) }));

jest.mock('../middleware/auth', () => ({ authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1' }; next(); } }));
jest.mock('../middleware/rateLimit', () => ({ limits: new Proxy({}, { get: () => () => (_req: any, _res: any, next: any) => next() }) }));
jest.mock('../lib/redisAdapter', () => ({
  cache: { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => { store.set(k, v); }, del: async () => undefined },
}));
jest.mock('../db/repositories', () => ({
  Channels: { findById: async () => ({ _id: 'c1', serverId: 's1' }) },
  Members: { findOne: async () => ({ userId: 'u1' }) },
  Messages: { messagesFind: (...a: unknown[]) => (messagesFind as any)(...a) },
  Users: { findByIds: async () => [{ _id: 'u2', username: 'bob' }] },
  // P6: the per-server AI gate reads the server row; a migrated row allows AI by default.
  Servers: { findById: async () => ({ _id: 's1', aiEnabled: true }) },
}));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: async () => (1 << 0) | (1 << 15),
  hasPermission: (mask: number, p: number) => (mask & p) === p,
  PERMS: { VIEW_CHANNELS: 1 << 0, READ_HISTORY: 1 << 15 },
}));
jest.mock('../lib/aiProvider', () => {
  const actual = jest.requireActual('../lib/aiProvider');
  return {
    callAI: (...a: unknown[]) => callAI(...a), AI_ENABLED: true, PROVIDER: 'openai-compatible',
    safeProvider: (p: string) => p, aiFailureForClient: actual.aiFailureForClient,
  };
});

import request from 'supertest';
import express from 'express';
import summarize from '../routes/ai/summarize';
import aiIndex from '../routes/ai/index';
import translate from '../routes/ai/translate';

const app = express();
app.use(express.json());
app.use('/api/ai/summarize', summarize);
app.use('/api/ai/translate', translate);
app.use('/api/ai', aiIndex);

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  rows.current = [
    { _id: 'm1', userId: 'u2', content: 'kept message', createdAt: 1 },
    { _id: 'm2', userId: 'u2', content: 'about to be deleted', createdAt: 2 },
  ];
});

describe('AI-02 deletion', () => {
  it('the summary query excludes deleted and system messages', async () => {
    callAI.mockResolvedValue('summary');
    await request(app).get('/api/ai/summarize/c1');
    expect(messagesFind).toHaveBeenCalledWith({ channelId: 'c1', deletedAt: null, type: { $ne: 'system' } });
  });

  it('a summary cached before a deletion is not served after it', async () => {
    callAI.mockResolvedValue('summary v1');
    const first = await request(app).get('/api/ai/summarize/c1');
    expect(first.body.cached).toBeUndefined();
    const again = await request(app).get('/api/ai/summarize/c1');
    expect(again.body.cached).toBe(true);           // control: the cache works
    expect(callAI).toHaveBeenCalledTimes(1);

    rows.current = rows.current.filter((r) => r._id !== 'm2'); // the message is deleted
    callAI.mockResolvedValue('summary v2');
    const after = await request(app).get('/api/ai/summarize/c1');
    expect(after.body.cached).toBeUndefined();
    expect(after.body.summary).toBe('summary v2');
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(String(callAI.mock.calls[1][1])).not.toContain('about to be deleted');
  });

  it('E2EE payloads are never summarised', async () => {
    rows.current.push({ _id: 'm3', userId: 'u2', content: '🔒e2e:cipher', createdAt: 3 });
    callAI.mockResolvedValue('s');
    await request(app).get('/api/ai/summarize/c1');
    expect(String(callAI.mock.calls[0][1])).not.toContain('cipher');
  });
});

describe('AI-07 outage', () => {
  const outage = new Error('connect ECONNREFUSED 10.0.0.9:8000');

  it('summarize degrades to the local summary, flagged and NOT cached', async () => {
    callAI.mockRejectedValue(outage);
    const r = await request(app).get('/api/ai/summarize/c1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider: 'rules', degraded: true });
    expect(JSON.stringify(r.body)).not.toContain('10.0.0.9');
    callAI.mockResolvedValue('recovered');
    const next = await request(app).get('/api/ai/summarize/c1');
    expect(next.body.summary).toBe('recovered');     // the outage answer was not cached
  });

  it('suggest-reply degrades to canned suggestions', async () => {
    callAI.mockRejectedValue(outage);
    const r = await request(app).get('/api/ai/suggest-reply/c1');
    expect(r.status).toBe(200);
    expect(r.body.degraded).toBe(true);
    expect(r.body.suggestions.length).toBeGreaterThan(0);
  });

  it('translate answers 503 with a generic reason', async () => {
    callAI.mockRejectedValue(outage);
    const r = await request(app).post('/api/ai/translate').send({ text: 'merhaba', targetLang: 'en' });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain('10.0.0.9');
  });
});

export {};
