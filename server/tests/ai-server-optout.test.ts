// server/tests/ai-server-optout.test.ts
//
// P6 — per-server AI opt-out, measured at the provider boundary.
//
// The real routes, the real permission resolution, the real provider module
// (AI_PROVIDER=openai-compatible) and the repository layer over the in-memory
// DB. Only the outbound HTTP function (lib/fetch → fetchT) is replaced, and
// EVERY call it receives is recorded: "provider traffic" below means requests
// that actually left for the AI provider, not a mocked callAI.
//
// Contract:
//   · a server with aiEnabled=false sends nothing to the provider from any
//     route — channel context, message text, search, digest, translation;
//   · routes with a local fallback serve it; routes without one answer 403
//     AI_DISABLED_FOR_SERVER;
//   · the requester's permission check runs FIRST (a non-member learns
//     nothing and causes no traffic);
//   · only the owner can change the setting, only with a real boolean;
//   · the change takes effect on the next request in both directions (no
//     cached AI answer outlives a disable, no cached local answer outlives a
//     re-enable);
//   · another server on the same installation is unaffected.
// A negative control at the end removes the gate and shows the same request
// DOES reach the provider — the gate, not something else, is what blocks it.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = '12345678901234567890123456789012';
process.env.REFRESH_SECRET = '12345678901234567890123456789012';
process.env.AI_PROVIDER = 'openai-compatible';
process.env.AI_BASE_URL = 'http://ai.test/v1';
process.env.AI_MODEL = 'lab-model';
delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY; delete process.env.OLLAMA_URL;
delete process.env.PGVECTOR_ENABLED;

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
const cacheStore = new Map<string, unknown>();
jest.mock('../lib/redisAdapter', () => {
  const actual = jest.requireActual('../lib/redisAdapter');
  return {
    ...actual,
    cache: {
      ...actual.cache,
      get: async (k: string) => (cacheStore.has(k) ? cacheStore.get(k) : null),
      set: async (k: string, v: unknown) => { cacheStore.set(k, v); },
      del: async (k: string) => { cacheStore.delete(k); },
    },
  };
});

type Sent = { url: string; body: string };
const sent: Sent[] = [];
function sseBody(chunks: string[]) {
  let i = 0;
  return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true, value: undefined }) }) };
}
const fetchT = jest.fn(async (url: string | URL, opts: { body?: string } = {}) => {
  const body = String(opts.body ?? '');
  sent.push({ url: String(url), body });
  if (body.includes('"stream":true')) {
    return { ok: true, status: 200, body: sseBody(['data: {"choices":[{"delta":{"content":"AI"}}]}\n\n', 'data: [DONE]\n\n']) };
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"safe":true,"score":99,"indices":[0],"explanation":"AI"}' } }] }) };
});
jest.mock('../lib/fetch', () => ({ fetchT: (...a: unknown[]) => (fetchT as unknown as (...x: unknown[]) => unknown)(...a) }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import db from '../db/loader';
import aiRouter from '../routes/ai';
import semanticRouter from '../routes/semantic';
import serversRouter from '../routes/servers';

const tok = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });
const OWNER = 'owner1', MEMBER = 'member1', STRANGER = 'stranger1';

function app() {
  const a = express();
  a.use(express.json());
  a.set('io', { to: () => ({ emit: () => undefined }) });
  a.use('/api/ai', aiRouter);
  a.use('/api/semantic', semanticRouter);
  a.use('/api/servers', serversRouter);
  return a;
}

const providerCalls = () => sent.filter((s) => s.url.startsWith('http://ai.test/'));

async function seed() {
  for (const id of [OWNER, MEMBER, STRANGER]) {
    await db.users.insert({ _id: id, username: id, displayName: id, tokenVersion: 0, tags: 'x' });
  }
  // s1 — the server that will turn AI off; s2 — a neighbour on the same installation.
  await db.servers.insert({ _id: 's1', ownerId: OWNER, name: 'Secret Server', tags: ['secret-tag'], discoverable: 1, createdAt: 1 });
  await db.servers.insert({ _id: 's2', ownerId: OWNER, name: 'Open Server', tags: ['open-tag'], discoverable: 1, createdAt: 1 });
  for (const sid of ['s1', 's2']) {
    await db.members.insert({ userId: OWNER, serverId: sid, roles: [] });
    await db.members.insert({ userId: MEMBER, serverId: sid, roles: [] });
  }
  await db.channels.insert({ _id: 'c1', serverId: 's1', name: 'general', type: 'text' });
  await db.channels.insert({ _id: 'c2', serverId: 's2', name: 'general', type: 'text' });
  const now = Date.now();
  await db.messages.insert({ _id: 'm1', channelId: 'c1', serverId: 's1', userId: MEMBER, username: MEMBER, content: 'S1-PRIVATE-CANARY plans', type: 'text', createdAt: now - 1000 });
  await db.messages.insert({ _id: 'm2', channelId: 'c2', serverId: 's2', userId: MEMBER, username: MEMBER, content: 'S2 open chat', type: 'text', createdAt: now - 1000 });
}

const setAi = (sid: string, aiEnabled: unknown, as = OWNER) =>
  request(app()).patch(`/api/servers/${sid}`).set('Authorization', `Bearer ${tok(as)}`).send({ aiEnabled });

// Every provider-reaching request, aimed at a server's content.
const ROUTES: Array<{ name: string; run: (sid: 's1' | 's2') => request.Test; local?: boolean }> = [
  { name: 'summarize', local: true, run: (sid) => request(app()).get(`/api/ai/summarize/${sid === 's1' ? 'c1' : 'c2'}`).set('Authorization', `Bearer ${tok(MEMBER)}`) },
  { name: 'suggest-reply', local: true, run: (sid) => request(app()).get(`/api/ai/suggest-reply/${sid === 's1' ? 'c1' : 'c2'}`).set('Authorization', `Bearer ${tok(MEMBER)}`) },
  { name: 'ask/stream', run: (sid) => request(app()).get(`/api/ai/ask/stream?q=hi&channelId=${sid === 's1' ? 'c1' : 'c2'}`).set('Authorization', `Bearer ${tok(MEMBER)}`) },
  { name: 'stream', run: (sid) => request(app()).get(`/api/ai/stream?q=hi&channelId=${sid === 's1' ? 'c1' : 'c2'}`).set('Authorization', `Bearer ${tok(MEMBER)}`) },
  { name: 'clyde/stream', run: (sid) => request(app()).get(`/api/ai/clyde/stream?q=hi&channelId=${sid === 's1' ? 'c1' : 'c2'}`).set('Authorization', `Bearer ${tok(MEMBER)}`) },
  { name: 'moderate', local: true, run: (sid) => request(app()).post('/api/ai/moderate').set('Authorization', `Bearer ${tok(MEMBER)}`).send({ messageId: sid === 's1' ? 'm1' : 'm2' }) },
  { name: 'translate', run: (sid) => request(app()).post('/api/ai/translate').set('Authorization', `Bearer ${tok(MEMBER)}`).send({ text: 'merhaba', targetLang: 'en', serverId: sid }) },
  { name: 'semantic search', local: true, run: (sid) => request(app()).post('/api/semantic/search').set('Authorization', `Bearer ${tok(MEMBER)}`).send({ query: 'plans', serverId: sid }) },
  { name: 'digest', local: true, run: (sid) => request(app()).get(`/api/semantic/digest/${sid}`).set('Authorization', `Bearer ${tok(MEMBER)}`) },
];

beforeEach(async () => {
  (db as unknown as { _reset?: () => void })._reset?.();
  cacheStore.clear();
  sent.length = 0;
  fetchT.mockClear();
  await seed();
});

describe('the owner controls the setting; nobody else can', () => {
  it('a new or existing server allows AI by default (preserves behaviour)', async () => {
    const r = await request(app()).get('/api/ai/status?serverId=s1').set('Authorization', `Bearer ${tok(MEMBER)}`);
    expect(r.status).toBe(200);
    expect(r.body.server).toEqual({ serverId: 's1', enabled: true });
  });

  it('the owner turns AI off and the stored row says so', async () => {
    const r = await setAi('s1', false);
    expect(r.status).toBe(200);
    expect(r.body.aiEnabled).toBe(false);
    expect((await db.servers.findOne({ _id: 's1' }) as { aiEnabled?: unknown }).aiEnabled).toBe(false);
  });

  it('a member who is not the owner cannot change it', async () => {
    const r = await setAi('s1', false, MEMBER);
    expect(r.status).toBe(403);
    expect((await db.servers.findOne({ _id: 's1' }) as { aiEnabled?: unknown }).aiEnabled).not.toBe(false);
  });

  it.each([['"false"', 'false'], ['0', 0], ['null', null], ['an object', { v: false }]])('a non-boolean (%s) is refused, not coerced', async (_l, v) => {
    const r = await setAi('s1', v);
    expect(r.status).toBe(400);
    expect((await db.servers.findOne({ _id: 's1' }) as { aiEnabled?: unknown }).aiEnabled).not.toBe(false);
  });

  it('/ai/status reports the server state only to members', async () => {
    await setAi('s1', false);
    const member = await request(app()).get('/api/ai/status?serverId=s1').set('Authorization', `Bearer ${tok(MEMBER)}`);
    expect(member.body.server).toEqual({ serverId: 's1', enabled: false });
    const stranger = await request(app()).get('/api/ai/status?serverId=s1').set('Authorization', `Bearer ${tok(STRANGER)}`);
    expect(stranger.status).toBe(403);
    expect(JSON.stringify(stranger.body)).not.toContain('enabled');
  });
});

describe('enabled server: every route reaches the provider (positive control)', () => {
  it.each(ROUTES.map((r) => [r.name, r] as const))('%s sends the request to the provider', async (_n, route) => {
    const r = await route.run('s1');
    expect(r.status).toBeLessThan(400);
    expect(providerCalls().length).toBeGreaterThan(0);
  });
});

describe('disabled server: zero provider traffic from every route', () => {
  it.each(ROUTES.map((r) => [r.name, r] as const))('%s', async (_n, route) => {
    await setAi('s1', false);
    sent.length = 0;
    const r = await route.run('s1');
    expect(providerCalls()).toHaveLength(0);
    if (route.local) {
      // Routes with a local fallback still answer, flagged, without AI.
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain('"AI"');
    } else {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('AI_DISABLED_FOR_SERVER');
    }
  });

  it('the private canary never appears in anything sent out', async () => {
    await setAi('s1', false);
    sent.length = 0;
    for (const route of ROUTES) await route.run('s1');
    expect(sent.map((s) => s.body).join('\n')).not.toContain('S1-PRIVATE-CANARY');
  });
});

describe('a neighbour server on the same installation is unaffected', () => {
  it.each(ROUTES.map((r) => [r.name, r] as const))('%s on s2 still reaches the provider while s1 is off', async (_n, route) => {
    await setAi('s1', false);
    sent.length = 0;
    const r = await route.run('s2');
    expect(r.status).toBeLessThan(400);
    expect(providerCalls().length).toBeGreaterThan(0);
    expect(sent.map((s) => s.body).join('\n')).not.toContain('S1-PRIVATE-CANARY');
  });

  it('discover-match sends neither the opted-out server\'s name nor its tags', async () => {
    await db.servers.insert({ _id: 's3', ownerId: STRANGER, name: 'Candidate', tags: ['cand-tag'], discoverable: 1, createdAt: 1 });
    await setAi('s1', false);
    sent.length = 0;
    const r = await request(app()).get('/api/ai/discover-match').set('Authorization', `Bearer ${tok(MEMBER)}`);
    expect(r.status).toBe(200);
    const out = sent.map((s) => s.body).join('\n');
    expect(out).not.toContain('secret-tag');
    expect(out).not.toContain('Secret Server');
    expect(out).toContain('open-tag'); // control: the AI-enabled neighbour still contributes
  });
});

describe('changes take effect on the next request, both ways', () => {
  it('an AI summary cached before the opt-out is not served after it', async () => {
    const before = await request(app()).get('/api/ai/summarize/c1').set('Authorization', `Bearer ${tok(MEMBER)}`);
    expect(before.body.provider).not.toBe('rules');
    const cachedAgain = await request(app()).get('/api/ai/summarize/c1').set('Authorization', `Bearer ${tok(MEMBER)}`);
    expect(cachedAgain.body.cached).toBe(true); // control: the cache works

    await setAi('s1', false);
    const after = await request(app()).get('/api/ai/summarize/c1').set('Authorization', `Bearer ${tok(MEMBER)}`);
    expect(after.body.cached).toBeUndefined();
    expect(after.body.provider).toBe('rules');
    expect(after.body.aiDisabledForServer).toBe(true);
  });

  it('re-enabling restores AI on the very next request (the local answer was not cached)', async () => {
    await setAi('s1', false);
    await request(app()).get('/api/ai/summarize/c1').set('Authorization', `Bearer ${tok(MEMBER)}`);
    await setAi('s1', true);
    sent.length = 0;
    const r = await request(app()).get('/api/ai/summarize/c1').set('Authorization', `Bearer ${tok(MEMBER)}`);
    expect(r.body.provider).not.toBe('rules');
    expect(providerCalls().length).toBe(1);
  });

  it('semantic search: off → keyword only; on again → AI', async () => {
    await setAi('s1', false);
    const off = await request(app()).post('/api/semantic/search').set('Authorization', `Bearer ${tok(MEMBER)}`).send({ query: 'plans', serverId: 's1' });
    expect(off.body.aiDisabledForServer).toBe(true);
    await setAi('s1', true);
    sent.length = 0;
    await request(app()).post('/api/semantic/search').set('Authorization', `Bearer ${tok(MEMBER)}`).send({ query: 'plans', serverId: 's1' });
    expect(providerCalls().length).toBeGreaterThan(0);
  });
});

describe('permissions are checked before the AI setting', () => {
  it.each(ROUTES.filter((r) => r.name !== 'digest' && r.name !== 'semantic search').map((r) => [r.name, r] as const))(
    '%s: a non-member gets the permission refusal, not the AI setting, and causes no traffic', async (_n, route) => {
      await setAi('s1', false);
      sent.length = 0;
      const asStranger = route.run('s1').set('Authorization', `Bearer ${tok(STRANGER)}`);
      const r = await asStranger;
      expect(r.status).toBeGreaterThanOrEqual(403);
      expect(r.body.code).not.toBe('AI_DISABLED_FOR_SERVER');
      expect(providerCalls()).toHaveLength(0);
    });

  it.each(['digest', 'semantic search'])('%s: a non-member is refused and causes no traffic', async (name) => {
    const route = ROUTES.find((r) => r.name === name)!;
    const r = await route.run('s2').set('Authorization', `Bearer ${tok(STRANGER)}`);
    expect(r.status).toBe(403);
    expect(providerCalls()).toHaveLength(0);
  });
});

describe('negative control: without the server gate the same request reaches the provider', () => {
  it('summarize and ask/stream on the opted-out server send data out once the gate is removed', async () => {
    await setAi('s1', false);
    let leaked = 0;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../lib/aiServerPolicy', () => {
        const actual = jest.requireActual('../lib/aiServerPolicy');
        return { ...actual, serverAllowsAi: async () => true, serversAllowingAi: async (ids: string[]) => new Set(ids) };
      });
      const ungated = express();
      ungated.use(express.json());
      ungated.use('/api/ai', require('../routes/ai').default);
      sent.length = 0;
      await request(ungated).get('/api/ai/summarize/c1').set('Authorization', `Bearer ${tok(MEMBER)}`);
      await request(ungated).get('/api/ai/ask/stream?q=hi&channelId=c1').set('Authorization', `Bearer ${tok(MEMBER)}`);
      leaked = providerCalls().length;
    });
    expect(leaked).toBe(2);
    expect(sent.map((s) => s.body).join('\n')).toContain('S1-PRIVATE-CANARY');
  });
});
