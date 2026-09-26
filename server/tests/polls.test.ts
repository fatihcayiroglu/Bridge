// server/tests/polls.test.ts
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { createMockDb, makeChannel, makeServer, makeUser, requireDoc } from './helpers/mockDb';
import type { ChannelFixture, MockDb, PollFixture, ServerFixture, UserFixture } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    messages: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    ai:       () => (_req: unknown, _res: unknown, next: () => void) => next(),
    polls:    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import pollsRouter from '../routes/polls';

function makeToken(userId: string) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

let app: express.Express;
let user: UserFixture;
let otherUser: UserFixture;
let server: ServerFixture;
let channel: ChannelFixture;
let token: string;
let otherToken: string;

beforeEach(async () => {
  const { createMockDb, makeUser, makeServer, makeChannel } = require('./helpers/mockDb');
  db = createMockDb();
  const dbMod = require('../db/index');
  Object.assign(dbMod, db);

  user      = makeUser();
  otherUser = makeUser();
  server    = makeServer(user._id);
  channel   = makeChannel(server._id);

  await db.users.insert(user);
  await db.users.insert(otherUser);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now() });
  await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

  token      = makeToken(user._id);
  otherToken = makeToken(otherUser._id);

  app = express();
  app.use(express.json());
  app.use('/api/channels', pollsRouter);
  app.use('/api/polls', pollsRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
});

// ══════════════════════════════════════════════════════════════
// ANKET OLUŞTURMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/channels/:cid/polls — anket oluştur', () => {
  it('geçerli anket oluşturur', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Favori renk?', options: ['Kırmızı', 'Mavi', 'Yeşil'] });

    expect(res.status).toBe(200);
    expect(res.body.question).toBe('Favori renk?');
    expect(res.body.options).toHaveLength(3);
    expect(res.body.closed).toBe(false);
    expect(res.body.options[0]).toEqual(expect.objectContaining({ voteCount: 0, votedByMe: false }));
    expect(res.body.options[0]).not.toHaveProperty('votes');
  });

  it('soru olmadan 400 döner', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ options: ['A', 'B'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/question/i);
  });

  it('1 seçenekle 400 döner (min 2)', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Test?', options: ['Sadece bir'] });
    expect(res.status).toBe(400);
  });

  it('11 seçenekle 400 döner (max 10)', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Test?', options: Array.from({ length: 11 }, (_, i) => `Seçenek ${i}`) });
    expect(res.status).toBe(400);
  });

  it('mevcut olmayan kanal 404 döner', async () => {
    const res = await request(app)
      .post('/api/channels/nonexistent/polls')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Test?', options: ['A', 'B'] });
    expect(res.status).toBe(404);
  });

  it('üye olmayan kullanıcı 403 alır', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ question: 'Test?', options: ['A', 'B'] });
    expect(res.status).toBe(403);
  });

  it('multiSelect anket oluşturur', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Çoklu?', options: ['A', 'B', 'C'], multiSelect: true });

    expect(res.status).toBe(200);
    expect(res.body.multiSelect).toBe(true);
  });

  it('duration varsa expiresAt hesaplanır', async () => {
    const before = Date.now();
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Süreli?', options: ['A', 'B'], duration: 60 }); // 60 dakika

    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeGreaterThan(before + 59 * 60 * 1000);
  });

  it.each([
    [{ question: {bad:true}, options:['A','B'] }],
    [{ question:'Q', options:['A', 2] }],
    [{ question:'Q', options:['A','B'], multiSelect:'false' }],
    [{ question:'Q', options:['A','B'], allowVoteChange:'false' }],
    [{ question:'Q', options:['A','B'], duration:'5' }],
    [{ question:'Q', options:['A','B'], duration:-1 }],
    [{ question:'Q', options:['A','B'], duration:1.5 }],
  ])('rejects coercible/malformed create payload %#', async (body) => {
    const res = await request(app).post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// ANKET LİSTELEME
// ══════════════════════════════════════════════════════════════
describe('GET /api/channels/:cid/polls — anket listele', () => {
  beforeEach(async () => {
    await db.polls.insert({
      _id: 'poll1', channelId: channel._id, serverId: server._id,
      createdBy: user._id, question: 'Test?',
      options: [{ id: '0', text: 'A', votes: [] }, { id: '1', text: 'B', votes: [] }],
      multiSelect: false, expiresAt: null, closed: false, createdAt: Date.now(),
    });
  });

  it('anket listesini döner', async () => {
    const res = await request(app)
      .get(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('üye olmayan kullanıcı listeleyemez', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .get(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════
// OY VERME
// ══════════════════════════════════════════════════════════════
describe('POST /api/polls/:pid/vote — oy ver', () => {
  let poll: PollFixture;

  beforeEach(async () => {
    poll = {
      _id: 'poll-vote-test', channelId: channel._id, serverId: server._id,
      createdBy: user._id, question: 'Oy?',
      options: [
        { id: '0', text: 'Evet', votes: [] },
        { id: '1', text: 'Hayır', votes: [] },
      ],
      multiSelect: false, expiresAt: null, closed: false, createdAt: Date.now(),
    };
    await db.polls.insert(poll);
  });

  it('geçerli oy verir', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(200);
    const yesOption = res.body.options.find((o: Record<string, unknown>) => o.id === '0');
    expect(yesOption).toEqual(expect.objectContaining({ voteCount: 1, votedByMe: true }));
    expect(yesOption).not.toHaveProperty('votes');
  });

  it('single-choice ankette birden fazla seçenek reddedilir', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0', '1'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/single choice/i);
  });

  it('multiSelect ankette birden fazla seçenek kabul edilir', async () => {
    await db.polls.update({ _id: poll._id }, { $set: { multiSelect: true } });

    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0', '1'] });

    expect(res.status).toBe(200);
  });

  it('kapalı ankete oy verilemez', async () => {
    await db.polls.update({ _id: poll._id }, { $set: { closed: true } });

    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/closed/i);
  });

  it('süresi dolmuş ankete oy verilemez', async () => {
    await db.polls.update({ _id: poll._id }, { $set: { expiresAt: Date.now() - 1000 } });

    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('mevcut olmayan anket 404 döner', async () => {
    const res = await request(app)
      .post('/api/polls/nonexistent/vote')
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(404);
  });

  it('optionIds olmadan 400 döner', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('aynı seçeneğe tekrar oy vermek oyu geri alır (toggle)', async () => {
    // İlk oy
    await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    // Aynı seçeneğe tekrar oy — toggle bekliyoruz
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(200);
    const yesOption = res.body.options.find((o: Record<string, unknown>) => o.id === '0');
    // Toggle: oy kaldırılmış olmalı
    expect(yesOption).toEqual(expect.objectContaining({ voteCount: 0, votedByMe: false }));
    expect(yesOption).not.toHaveProperty('votes');
  });

  it('geçersiz optionId 400 döner', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['999'] });

    expect(res.status).toBe(400);
  });


  it.each([
    { optionIds: [0] },
    { optionIds: ['0', '0'] },
    { optionIds: [''] },
    { optionIds: Array.from({ length: 11 }, (_, i) => String(i)) },
  ])('rejects malformed/duplicate option ids %#', async (body) => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// ANKET KAPATMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/polls/:pid/close — anketi kapat', () => {
  let poll: PollFixture;

  beforeEach(async () => {
    poll = {
      _id: 'poll-close-test', channelId: channel._id, serverId: server._id,
      createdBy: user._id, question: 'Kapat?',
      options: [{ id: '0', text: 'A', votes: [] }],
      multiSelect: false, expiresAt: null, closed: false, createdAt: Date.now(),
    };
    await db.polls.insert(poll);
  });

  it('oluşturan kullanıcı anketi kapatır', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/close`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const updated = await requireDoc(db.polls, { _id: poll._id });
    expect(updated.closed).toBe(true);
  });

  it('başkası anketi kapatamaz', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/close`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan anket 404 döner', async () => {
    const res = await request(app)
      .post('/api/polls/nonexistent/close')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 3 — remaining poll mutation / privacy branches
// ══════════════════════════════════════════════════════════════
describe('additional poll authority and mutation behavior', () => {
  async function seedPoll(overrides = {}) {
    const poll = {
      _id: `poll-extra-${Math.random()}`, channelId: channel._id, serverId: server._id,
      createdBy: user._id, question: 'Extra?',
      options: [{ id: '0', text: 'A', votes: [] }, { id: '1', text: 'B', votes: [] }],
      multiSelect: false, allowVoteChange: true, expiresAt: null, closed: false, createdAt: Date.now(),
      ...overrides,
    };
    await db.polls.insert(poll);
    return poll;
  }

  it('GET /api/polls/:pid returns a visible poll and hides it from a non-member', async () => {
    const poll = await seedPoll();
    const ok = await request(app).get(`/api/polls/${poll._id}`).set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body._id).toBe(poll._id);

    const outsider = makeUser();
    await db.users.insert(outsider);
    const denied = await request(app).get(`/api/polls/${poll._id}`).set('Authorization', `Bearer ${makeToken(outsider._id)}`);
    expect(denied.status).toBe(403);
    const missing = await request(app).get('/api/polls/nope').set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });

  it('creator edits question/options/duration/vote-change before any votes', async () => {
    const poll = await seedPoll();
    const res = await request(app).patch(`/api/polls/${poll._id}`).set('Authorization', `Bearer ${token}`).send({
      question: '  New question  ', options: [' X ', 'Y'], duration: 5, allowVoteChange: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.question).toBe('New question');
    expect(res.body.options.map((o: Record<string, unknown>) => o.text)).toEqual(['X', 'Y']);
    expect(res.body.allowVoteChange).toBe(false);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('PATCH supports clearing duration without touching options', async () => {
    const poll = await seedPoll({ expiresAt: Date.now() + 100000 });
    const res = await request(app).patch(`/api/polls/${poll._id}`).set('Authorization', `Bearer ${token}`).send({ duration: 0 });
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeNull();
  });

  it.each([
    [{ question: '   ' }, 400],
    [{ question: { bad: true } }, 400],
    [{ options: ['only'] }, 400],
    [{ options: ['A', 2] }, 400],
    [{ options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, 400],
    [{ duration: '5' }, 400],
    [{ duration: -1 }, 400],
    [{ duration: 1.5 }, 400],
    [{ allowVoteChange: 'false' }, 400],
  ])('PATCH rejects malformed updates %#', async (body, expected) => {
    const poll = await seedPoll();
    const res = await request(app).patch(`/api/polls/${poll._id}`).set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(expected);
  });

  it('PATCH rejects another member, a closed poll, and option changes after votes', async () => {
    const otherOwned = await seedPoll();
    expect((await request(app).patch(`/api/polls/${otherOwned._id}`).set('Authorization', `Bearer ${otherToken}`).send({ question: 'x' })).status).toBe(403);

    const closed = await seedPoll({ _id: 'poll-extra-closed', closed: true });
    expect((await request(app).patch(`/api/polls/${closed._id}`).set('Authorization', `Bearer ${token}`).send({ question: 'x' })).status).toBe(400);

    const expired = await seedPoll({ _id: 'poll-extra-expired-edit', expiresAt: Date.now() - 1 });
    const expiredRes = await request(app).patch(`/api/polls/${expired._id}`).set('Authorization', `Bearer ${token}`).send({ question: 'x' });
    expect(expiredRes.status).toBe(400);
    expect(expiredRes.body.error).toMatch(/expired/i);

    const corruptedExpiry = await seedPoll({ _id: 'poll-extra-corrupt-expiry', expiresAt: 'not-a-timestamp' });
    expect((await request(app).patch(`/api/polls/${corruptedExpiry._id}`).set('Authorization', `Bearer ${token}`).send({ question: 'x' })).status).toBe(400);

    const voted = await seedPoll({ _id: 'poll-extra-voted', options: [
      { id: '0', text: 'A', votes: [otherUser._id] }, { id: '1', text: 'B', votes: [] },
    ]});
    expect((await request(app).patch(`/api/polls/${voted._id}`).set('Authorization', `Bearer ${token}`).send({ options: ['C', 'D'] })).status).toBe(409);
  });

  it('DELETE vote removes all current user votes', async () => {
    const poll = await seedPoll({ options: [
      { id: '0', text: 'A', votes: [user._id] }, { id: '1', text: 'B', votes: [user._id, otherUser._id] },
    ]});
    const res = await request(app).delete(`/api/polls/${poll._id}/vote`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.options[0]).toEqual(expect.objectContaining({ voteCount: 0, votedByMe: false }));
    expect(res.body.options[1]).toEqual(expect.objectContaining({ voteCount: 1, votedByMe: false }));
    for (const option of res.body.options) expect(option).not.toHaveProperty('votes');
  });

  it('DELETE vote rejects closed, expired and vote-change-disabled polls', async () => {
    const closed = await seedPoll({ _id: 'poll-rm-closed', closed: true });
    expect((await request(app).delete(`/api/polls/${closed._id}/vote`).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    const expired = await seedPoll({ _id: 'poll-rm-expired', expiresAt: Date.now() - 1 });
    expect((await request(app).delete(`/api/polls/${expired._id}/vote`).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    const locked = await seedPoll({ _id: 'poll-rm-locked', allowVoteChange: false });
    expect((await request(app).delete(`/api/polls/${locked._id}/vote`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('DELETE poll lets its creator delete and emits when Socket.IO is present', async () => {
    const poll = await seedPoll();
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    app.set('io', { to });
    const res = await request(app).delete(`/api/polls/${poll._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(to).toHaveBeenCalledWith(`channel:${channel._id}`);
    expect(emit).toHaveBeenCalledWith('poll:deleted', { channelId: channel._id, pollId: poll._id });
    expect(await db.polls.findOne({ _id: poll._id })).toBeNull();
  });

  it('DELETE poll rejects a non-owner without manage-messages and missing poll', async () => {
    const poll = await seedPoll();
    expect((await request(app).delete(`/api/polls/${poll._id}`).set('Authorization', `Bearer ${otherToken}`)).status).toBe(403);
    expect((await request(app).delete('/api/polls/missing').set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });

  it('atomic vote status failures map to canonical HTTP responses', async () => {
    const poll = await seedPoll();
    const { Polls } = require('../db/repositories');
    const spy = jest.spyOn(Polls, 'mutateVoteAtomic');
    for (const [status, code] of [
      ['not_found', 404], ['closed', 400], ['expired', 400], ['single_choice', 400],
      ['invalid_option', 400], ['vote_change_forbidden', 403], ['has_votes', 409], ['unexpected', 500],
    ]) {
      spy.mockResolvedValueOnce({ status });
      const res = await request(app).post(`/api/polls/${poll._id}/vote`).set('Authorization', `Bearer ${token}`).send({ optionIds: ['0'] });
      expect(res.status).toBe(code);
    }
    spy.mockRestore();
  });
});
