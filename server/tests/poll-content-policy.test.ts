// server/tests/poll-content-policy.test.ts
//
// A poll is channel content: its question and options are shown to every
// viewer of the channel and broadcast live (`poll:created`, `poll:updated`).
// `POST /api/channels/:cid/polls` and `PATCH /api/polls/:pid` applied none of
// the checks the channel send path applies, so:
//   - a word the server's AutoMod refuses in a message was accepted in a poll
//     question or option, and a `delete_and_timeout` rule never fired;
//   - a member timed out by a moderator or AutoMod could still post text to
//     the channel by creating a poll;
//   - an accepted poll could be edited into refused text.
//
// Each case runs the channel path first as the control (send or edit), then
// the poll route, through the real AutoMod evaluator, abuse policy and
// permission resolver on the in-memory DB.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';
import type { PollFixture } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../db/index', () => mockDb);
jest.mock('../lib/linkPreview', () => ({ extractUrls: () => [], fetchLinkPreview: jest.fn() }));
jest.mock('../lib/pushSender', () => ({ sendPushToUser: jest.fn(async () => undefined) }));
jest.mock('../middleware/rateLimit', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { limits: new Proxy({}, { get: () => pass }), rateLimit: pass };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { sendChannelMessage } from '../socket/handlers/messages-send';
import { editChannelMessage } from '../lib/messageMutations';
import pollsRouter from '../routes/polls';
import { invalidatePerms } from '../lib/permCache';
import { ABUSE_POLICY } from '../lib/abusePolicy';
import { DEFAULT_PERMISSIONS } from '../lib/permissions';
import { Automod } from '../db/repositories';
import { errorHandler } from '../middleware/errorHandler';

type Emitted = { ev: string; data: Record<string, unknown>; to?: string };

function makeIo() {
  const emitted: Emitted[] = [];
  return { emitted, to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; } };
}
function makeSocket() {
  const emitted: Emitted[] = [];
  return {
    id: `sock-${randomUUID()}`, rooms: new Set<string>(), emitted,
    on() {},
    emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data }); },
    to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; },
    join() {}, leave() {},
  };
}

let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let io: ReturnType<typeof makeIo>;
let app: express.Express;
const people: Array<ReturnType<typeof makeUser>> = [];

beforeEach(async () => {
  mockDb._reset();
  owner = makeUser(); member = makeUser();
  server = makeServer(owner._id);
  channel = makeChannel(server._id);
  people.length = 0;
  for (let i = 0; i < ABUSE_POLICY.mentions.perMessage + 1; i += 1) people.push(makeUser());
  for (const u of [owner, member, ...people]) {
    await mockDb.users.insert(u);
    await mockDb.members.insert({ userId: u._id, serverId: server._id, joinedAt: Date.now(), roles: '[]' });
  }
  await mockDb.servers.insert(server);
  await mockDb.channels.insert(channel);
  invalidatePerms(server._id);
  io = makeIo();
  app = express();
  app.set('io', io);
  app.use(express.json());
  app.use('/api/channels', pollsRouter);
  app.use('/api/polls', pollsRouter);
  app.use(errorHandler);
});

const tokenFor = (as: { _id: string }) =>
  jwt.sign({ id: as._id, username: 'tester', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

async function channelSend(content: string, as = member) {
  const socket = makeSocket();
  await sendChannelMessage(
    { channelId: channel._id, serverId: server._id, content, ackId: `ack-${randomUUID()}` } as never,
    socket as never, io as never, as as never, new Map(),
  );
  const refused = socket.emitted.find(e => e.ev === 'error:message' || e.ev === 'error:spam' || e.ev === 'error:timeout');
  return { refused: refused ? (refused.ev === 'error:timeout' ? 'TIMEOUT' : String(refused.data.code ?? refused.data.reason)) : null };
}

function createPoll(body: Record<string, unknown>, as = member) {
  return request(app).post(`/api/channels/${channel._id}/polls`).set('Authorization', `Bearer ${tokenFor(as)}`).send(body);
}
function patchPoll(pollId: string, body: Record<string, unknown>, as = member) {
  return request(app).patch(`/api/polls/${pollId}`).set('Authorization', `Bearer ${tokenFor(as)}`).send(body);
}

const storedPolls = async () => (await mockDb.polls.find({ channelId: channel._id })) as unknown as PollFixture[];
const pollBroadcasts = (ev: string) => io.emitted.filter(e => e.ev === ev);
const memberRow = async (as = member) => mockDb.members.findOne({ userId: as._id, serverId: server._id });

async function blockWord(word: string, action = 'delete', extra: Record<string, unknown> = {}) {
  await mockDb.automodRules.insert({
    _id: randomUUID(), serverId: server._id, type: 'blocked_words', enabled: true,
    config: JSON.stringify({ words: [word], action, ...extra }), createdAt: Date.now(),
  });
}

describe('AutoMod applies to a new poll', () => {
  it('a blocked word refused in the channel is refused in a poll question; nothing is stored or broadcast', async () => {
    await blockWord('forbiddenword');
    expect((await channelSend('this has forbiddenword in it')).refused).toBe('AUTOMOD_BLOCKED');

    const res = await createPoll({ question: 'this has forbiddenword in it', options: ['yes', 'no'] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    expect(await storedPolls()).toEqual([]);
    expect(pollBroadcasts('poll:created')).toEqual([]);
  });

  it('a blocked word in one option refuses the poll', async () => {
    await blockWord('forbiddenword');
    const res = await createPoll({ question: 'pick one', options: ['fine', 'forbiddenword here'] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    expect(await storedPolls()).toEqual([]);
  });

  it('a delete_and_timeout rule times the member out from a poll too', async () => {
    await blockWord('forbiddenword', 'delete_and_timeout');
    const res = await createPoll({ question: 'forbiddenword?', options: ['yes', 'no'] });
    expect(res.status).toBe(422);
    expect(Number((await memberRow())?.timeoutUntil)).toBeGreaterThan(Date.now());
    expect(await storedPolls()).toEqual([]);
  });

  it('an exempt role keeps its exemption: the poll is created', async () => {
    await mockDb.roles.insert({ _id: 'role-trusted', serverId: server._id, name: 'trusted', permissions: DEFAULT_PERMISSIONS, position: 1, createdAt: 1 });
    await mockDb.members.update({ userId: member._id, serverId: server._id }, { $set: { roles: '["role-trusted"]' } });
    invalidatePerms(server._id);
    await blockWord('forbiddenword', 'delete', { exemptRoles: ['role-trusted'] });
    expect((await channelSend('forbiddenword ok for trusted')).refused).toBeNull();

    const res = await createPoll({ question: 'forbiddenword ok for trusted', options: ['yes', 'no'] });
    expect(res.status).toBe(200);
    expect(await storedPolls()).toHaveLength(1);
  });

  it('a clean poll is unaffected by configured rules', async () => {
    await blockWord('forbiddenword');
    const res = await createPoll({ question: 'lunch?', options: ['pizza', 'soup'] });
    expect(res.status).toBe(200);
    expect(await storedPolls()).toHaveLength(1);
    expect(pollBroadcasts('poll:created')).toHaveLength(1);
  });

  it('the P7 mass-mention limit applies to the poll text, counted across question and options', async () => {
    const mentions = people.map(p => `<@${p._id}>`);
    expect((await channelSend(mentions.join(' '))).refused).toBe('TOO_MANY_MENTIONS');

    // Each field holds what it stores (question 300, option 100 characters):
    // 7 mentions in the question, then 2 per option.
    const question = mentions.slice(0, 7).join(' ');
    const options: string[] = [];
    for (let i = 7; i < mentions.length; i += 2) options.push(mentions.slice(i, i + 2).join(' '));
    expect(question.length).toBeLessThanOrEqual(300);
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(10);
    expect(options.every(o => o.length <= 100)).toBe(true);

    const res = await createPoll({ question, options });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_MENTIONS' });
    expect(await storedPolls()).toEqual([]);
  });
});

describe('a timed-out member cannot create a poll', () => {
  it('is refused like a channel send; nothing is stored or broadcast', async () => {
    const until = Date.now() + 60_000;
    await mockDb.members.update({ userId: member._id, serverId: server._id }, { $set: { timeoutUntil: until } });
    expect((await channelSend('hello')).refused).toBe('TIMEOUT');

    const res = await createPoll({ question: 'lunch?', options: ['pizza', 'soup'] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ until });
    expect(await storedPolls()).toEqual([]);
    expect(pollBroadcasts('poll:created')).toEqual([]);
  });

  it('an expired timeout does not block', async () => {
    await mockDb.members.update({ userId: member._id, serverId: server._id }, { $set: { timeoutUntil: Date.now() - 1 } });
    const res = await createPoll({ question: 'lunch?', options: ['pizza', 'soup'] });
    expect(res.status).toBe(200);
  });
});

describe('AutoMod applies to a poll edit', () => {
  async function acceptedPoll() {
    const res = await createPoll({ question: 'lunch?', options: ['pizza', 'soup'] });
    expect(res.status).toBe(200);
    return String(res.body._id);
  }

  it('an edit into a blocked word is refused like a message edit; the poll is unchanged and not broadcast', async () => {
    const pollId = await acceptedPoll();
    await mockDb.messages.insert({
      _id: 'msg-1', channelId: channel._id, serverId: server._id, userId: member._id,
      content: 'benign', type: 'normal', createdAt: Date.now(),
    });
    await blockWord('forbiddenword');
    const control = await editChannelMessage(io as never, { actorId: member._id, messageId: 'msg-1', channelId: channel._id, content: 'now forbiddenword' });
    expect(control).toMatchObject({ ok: false, code: 'AUTOMOD_BLOCKED' });

    const res = await patchPoll(pollId, { question: 'now forbiddenword' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    const [stored] = await storedPolls();
    expect(stored.question).toBe('lunch?');
    expect(pollBroadcasts('poll:updated')).toEqual([]);

    const optionEdit = await patchPoll(pollId, { options: ['pizza', 'forbiddenword'] });
    expect(optionEdit.status).toBe(422);
    expect((await storedPolls())[0].options.map(o => o.text)).toEqual(['pizza', 'soup']);
  });

  it('a delete_and_timeout rule times the editor out', async () => {
    const pollId = await acceptedPoll();
    await blockWord('forbiddenword', 'delete_and_timeout');
    const res = await patchPoll(pollId, { question: 'forbiddenword' });
    expect(res.status).toBe(422);
    expect(Number((await memberRow())?.timeoutUntil)).toBeGreaterThan(Date.now());
  });

  it('a settings-only edit (no text) is not moderated', async () => {
    const pollId = await acceptedPoll();
    await blockWord('lunch');
    const res = await patchPoll(pollId, { allowVoteChange: false });
    expect(res.status).toBe(200);
    expect(res.body.allowVoteChange).toBe(false);
  });
});

describe('an AutoMod rule-store failure refuses the poll (fail closed)', () => {
  it('create: nothing is stored or broadcast', async () => {
    const spy = jest.spyOn(Automod, 'findByServer').mockRejectedValue(new Error('automod rule store unavailable'));
    try {
      const res = await createPoll({ question: 'lunch?', options: ['pizza', 'soup'] });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await storedPolls()).toEqual([]);
      expect(pollBroadcasts('poll:created')).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('edit: the poll is unchanged and not broadcast', async () => {
    const created = await createPoll({ question: 'lunch?', options: ['pizza', 'soup'] });
    const spy = jest.spyOn(Automod, 'findByServer').mockRejectedValue(new Error('automod rule store unavailable'));
    try {
      const res = await patchPoll(String(created.body._id), { question: 'dinner?' });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'AUTOMOD_UNAVAILABLE' });
      expect((await storedPolls())[0].question).toBe('lunch?');
      expect(pollBroadcasts('poll:updated')).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});
