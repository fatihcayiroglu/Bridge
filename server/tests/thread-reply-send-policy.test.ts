// server/tests/thread-reply-send-policy.test.ts
//
// A thread reply is a message: every member who can see the channel can read
// it, it is broadcast live and it can mention people. The channel send path
// (`sendChannelMessage`) refuses content by three policies before storing it:
//   - AutoMod rules of the server (`blocked_words` etc.; the default action
//     deletes, i.e. refuses, the message);
//   - the P7 B1 content-abuse limits (the same text repeated more than
//     `repeat.max` times per window, one link host linked too often);
//   - the P7 B1 mass-mention limit (more than `mentions.perMessage` distinct
//     people in one message, unless the sender has MENTION_EVERYONE).
// `POST /api/threads/:id/messages` applied none of them, so a reply in a
// thread carried exactly what the channel refused. Neither did a forum post
// (`POST /api/threads` with a forum `channelId`): its title and first message
// are read by every viewer of the forum.
//
// Each case runs the channel path first as the control, then the thread
// route, through the real handlers, the real AutoMod evaluator and abuse
// policy, and the real permission resolver on the in-memory DB.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

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
import threadsRouter from '../routes/threads';
import { invalidatePerms } from '../lib/permCache';
import { ABUSE_POLICY } from '../lib/abusePolicy';
import { DEFAULT_PERMISSIONS, PERMS } from '../lib/permissions';
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
  const parent = { _id: 'parent-msg', channelId: channel._id, serverId: server._id, userId: owner._id, content: 'topic', createdAt: 1 };
  await mockDb.messages.insert(parent);
  await mockDb.threads.insert({
    _id: 'thread-1', channelId: channel._id, serverId: server._id, parentMessageId: parent._id, name: 'topic',
    createdBy: owner._id, createdAt: 1, lastMessageAt: 1, messageCount: 0,
  });
  invalidatePerms(server._id);
  io = makeIo();
  app = express();
  app.set('io', io);
  app.set('socketUsers', new Map());
  app.use(express.json());
  app.use('/api/threads', threadsRouter);
});

async function channelSend(content: string, as = member) {
  const socket = makeSocket();
  await sendChannelMessage(
    { channelId: channel._id, serverId: server._id, content, ackId: `ack-${randomUUID()}` } as never,
    socket as never, io as never, as as never, new Map(),
  );
  const refused = socket.emitted.find(e => e.ev === 'error:message' || e.ev === 'error:spam');
  return { refused: refused ? String(refused.data.code ?? refused.data.reason) : null };
}

function threadReply(content: string, as = member, clientNonce?: string) {
  const token = jwt.sign({ id: as._id, username: 'tester', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return request(app).post('/api/threads/thread-1/messages').set('Authorization', `Bearer ${token}`)
    .send(clientNonce ? { content, clientNonce } : { content });
}

const storedReplies = async () => (await mockDb.threadMessages.find({ threadId: 'thread-1' })).length;
const replyBroadcasts = () => io.emitted.filter(e => e.ev === 'thread:message:new');

async function blockWord(word: string, action = 'delete') {
  await mockDb.automodRules.insert({
    _id: randomUUID(), serverId: server._id, type: 'blocked_words', enabled: true,
    config: JSON.stringify({ words: [word], action }), createdAt: Date.now(),
  });
}

describe('AutoMod applies to thread replies', () => {
  it('a blocked word refused in the channel is refused in a thread; nothing is stored or broadcast', async () => {
    await blockWord('forbiddenword');
    expect((await channelSend('this has forbiddenword in it')).refused).toBe('AUTOMOD_BLOCKED');

    const res = await threadReply('this has forbiddenword in it');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    expect(await storedReplies()).toBe(0);
    expect(replyBroadcasts()).toEqual([]);
  });

  it('a timeout rule times the member out from a thread reply too', async () => {
    await blockWord('forbiddenword', 'delete_and_timeout');
    const res = await threadReply('this has forbiddenword in it');
    expect(res.status).toBe(422);
    const row = await mockDb.members.findOne({ userId: member._id, serverId: server._id }) as { timeoutUntil?: number } | null;
    expect(Number(row?.timeoutUntil ?? 0)).toBeGreaterThan(Date.now());
  });

  it('CONTROL: ordinary text is posted', async () => {
    await blockWord('forbiddenword');
    const res = await threadReply('a perfectly ordinary reply');
    expect(res.status).toBe(200);
    expect(await storedReplies()).toBe(1);
  });
});

describe('the P7 mass-mention limit applies to thread replies', () => {
  const tooMany = () => people.map(p => `<@${p._id}>`).join(' ');

  it(`more than ${ABUSE_POLICY.mentions.perMessage} distinct people is refused in a thread; nobody is notified`, async () => {
    expect((await channelSend(tooMany())).refused).toBe('TOO_MANY_MENTIONS');

    const res = await threadReply(tooMany());
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_MENTIONS' });
    expect(await storedReplies()).toBe(0);
    expect(await mockDb.notifications.find({})).toEqual([]);
  });

  it('a sender with MENTION_EVERYONE is exempt, in the channel and in a thread', async () => {
    await mockDb.roles.insert({ _id: 'role-announce', serverId: server._id, name: 'announcer', permissions: DEFAULT_PERMISSIONS | PERMS.MENTION_EVERYONE, position: 1, createdAt: 1 });
    await mockDb.members.update({ userId: member._id, serverId: server._id }, { $set: { roles: JSON.stringify(['role-announce']) } });
    invalidatePerms(server._id);

    expect((await channelSend(tooMany())).refused).toBeNull();
    const res = await threadReply(tooMany());
    expect(res.status).toBe(200);
    expect(await storedReplies()).toBe(1);
  });

  it(`CONTROL: exactly ${ABUSE_POLICY.mentions.perMessage} people is posted`, async () => {
    const res = await threadReply(people.slice(0, ABUSE_POLICY.mentions.perMessage).map(p => `<@${p._id}>`).join(' '));
    expect(res.status).toBe(200);
    expect(await storedReplies()).toBe(1);
  });
});

describe('the P7 repeated-content limit applies to thread replies', () => {
  const text = 'buy cheap followers at my shop now';

  it(`the same text more than ${ABUSE_POLICY.repeat.max} times per window is refused, counted across channel and thread`, async () => {
    for (let i = 0; i < ABUSE_POLICY.repeat.max; i += 1) {
      expect((await channelSend(text)).refused).toBeNull();
    }
    const res = await threadReply(text);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'SPAM_REPEAT' });
    expect(await storedReplies()).toBe(0);
  });

  it('retries of one stored reply are answered with it and never counted', async () => {
    const first = await threadReply(text, member, 'nonce-retry-1');
    expect(first.status).toBe(200);
    for (let i = 0; i < ABUSE_POLICY.repeat.max + 2; i += 1) {
      const retry = await threadReply(text, member, 'nonce-retry-1');
      expect(retry.status).toBe(200);
      expect(retry.body._id).toBe(first.body._id);
    }
    expect(await storedReplies()).toBe(1);
    // Only the first send counted: the same text can still be sent again.
    expect((await threadReply(text, member, 'nonce-retry-2')).status).toBe(200);
  });

  it('CONTROL: a different text is posted', async () => {
    for (let i = 0; i < ABUSE_POLICY.repeat.max; i += 1) await channelSend(text);
    const res = await threadReply('something else entirely here');
    expect(res.status).toBe(200);
  });
});

describe('a forum post (title and first message) passes the same checks', () => {
  let forum: ReturnType<typeof makeChannel>;
  beforeEach(async () => {
    forum = makeChannel(server._id, { type: 'forum', name: 'ideas' });
    await mockDb.channels.insert(forum);
    invalidatePerms(server._id);
  });

  function post(body: Record<string, unknown>, as = member) {
    const token = jwt.sign({ id: as._id, username: 'tester', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
    return request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: forum._id, ...body });
  }
  const forumPosts = async () => (await mockDb.threads.find({ channelId: forum._id })).length;
  const created = () => io.emitted.filter(e => e.ev === 'forum:thread:created');

  it('a blocked word in the first message is refused; no post is created or announced', async () => {
    await blockWord('forbiddenword');
    const res = await post({ name: 'a fine title', firstMessage: 'this has forbiddenword in it' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    expect(await forumPosts()).toBe(0);
    expect(created()).toEqual([]);
  });

  it('a blocked word in the title is refused', async () => {
    await blockWord('forbiddenword');
    const res = await post({ name: 'forbiddenword title' });
    expect(res.status).toBe(422);
    expect(await forumPosts()).toBe(0);
  });

  it(`the same post more than ${ABUSE_POLICY.repeat.max} times per window is refused`, async () => {
    const body = { name: 'cheap followers', firstMessage: 'buy cheap followers at my shop now' };
    for (let i = 0; i < ABUSE_POLICY.repeat.max; i += 1) expect((await post(body)).status).toBe(201);
    const res = await post(body);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'SPAM_REPEAT' });
    expect(await forumPosts()).toBe(ABUSE_POLICY.repeat.max);
  });

  it('more than the permitted direct mentions in a forum first message is refused before either row or announce', async () => {
    const tooMany = people.map(p => `<@${p._id}>`).join(' ');
    expect((await channelSend(tooMany)).refused).toBe('TOO_MANY_MENTIONS');
    const res = await post({ name: 'a normal forum title', firstMessage: tooMany });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_MENTIONS' });
    expect(await forumPosts()).toBe(0);
    expect(await mockDb.threadMessages.find({ channelId: forum._id })).toHaveLength(0);
    expect(created()).toEqual([]);
    expect(await mockDb.notifications.find({})).toEqual([]);
  });

  it('exactly the permitted direct mentions in a forum first message are allowed', async () => {
    const allowed = people.slice(0, ABUSE_POLICY.mentions.perMessage).map(p => `<@${p._id}>`).join(' ');
    const res = await post({ name: 'a normal forum title', firstMessage: allowed });
    expect(res.status).toBe(201);
    expect(await forumPosts()).toBe(1);
    expect(await mockDb.threadMessages.find({ channelId: forum._id })).toHaveLength(1);
    expect(created()).toHaveLength(1);
  });

  it.each([
    ['omitted', {}],
    ['empty', { firstMessage: '' }],
  ])('CONTROL: a forum title with an %s first message can be created without an empty reply', async (_case, optionalBody) => {
    const res = await post({ name: 'An ordinary forum topic', ...optionalBody });
    expect(res.status).toBe(201);
    expect(await forumPosts()).toBe(1);
    expect(await mockDb.threadMessages.find({ channelId: forum._id })).toHaveLength(0);
    expect(created()).toHaveLength(1);
  });

  it('CONTROL: an ordinary post is created', async () => {
    await blockWord('forbiddenword');
    const res = await post({ name: 'a fine title', firstMessage: 'a perfectly ordinary first message' });
    expect(res.status).toBe(201);
    expect(await forumPosts()).toBe(1);
    expect(created()).toHaveLength(1);
  });
});

describe('an AutoMod rule-store failure refuses the post (fail closed)', () => {
  // The rules cannot be read, so the content cannot be checked: nothing may be
  // stored or announced as if it had passed, and the client learns nothing
  // about the failure beyond a generic server error (the app's errorHandler).
  let forum: ReturnType<typeof makeChannel>;
  beforeEach(async () => {
    forum = makeChannel(server._id, { type: 'forum', name: 'ideas' });
    await mockDb.channels.insert(forum);
    invalidatePerms(server._id);
    app.use(errorHandler);
    jest.spyOn(Automod, 'findByServer').mockRejectedValue(new Error('automod rule store unavailable'));
  });
  afterEach(() => jest.restoreAllMocks());

  const forumPost = (body: Record<string, unknown>) => {
    const token = jwt.sign({ id: member._id, username: 'tester', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
    return request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: forum._id, ...body });
  };
  const expectGenericServerError = (res: { status: number; body: unknown }) => {
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('automod');
  };

  it('CONTROL: the channel send path refuses too; nothing is published', async () => {
    await expect(channelSend('an ordinary message')).rejects.toThrow('automod rule store unavailable');
    expect(io.emitted.filter(e => e.ev === 'message:new')).toEqual([]);
  });

  it('a thread reply is answered with a generic 500; nothing is stored or broadcast', async () => {
    const res = await threadReply('an ordinary reply');
    expectGenericServerError(res);
    expect(await storedReplies()).toBe(0);
    expect(replyBroadcasts()).toEqual([]);
  });

  it('a forum post is answered with a generic 500; no post is created or announced', async () => {
    const res = await forumPost({ name: 'a fine title', firstMessage: 'an ordinary first message' });
    expectGenericServerError(res);
    expect((await mockDb.threads.find({ channelId: forum._id })).length).toBe(0);
    expect(await mockDb.threadMessages.find({ channelId: forum._id })).toHaveLength(0);
    expect(io.emitted.filter(e => e.ev === 'forum:thread:created')).toEqual([]);
  });
});
