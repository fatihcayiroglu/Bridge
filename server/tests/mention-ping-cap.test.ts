// server/tests/mention-ping-cap.test.ts
//
// P7 B1 (lab ATK-04b): one sender may ping one person at most
// `mentions.perTarget` times per window. The message itself is always
// delivered; only the ping is suppressed (lib/abusePolicy.ts).
//
// What a person receives as a ping is created by `processNotifications`: an
// inbox row, `notification:mention` (the event the client counts as a
// mention), `inbox:changed`, a push and +1 unread. The cap gated only
// `mention:received`, which no client listens to, so the victim still got
// every ping. The contract, through the real send path, the real thread route,
// the real abuse policy and the real notification pipeline on the in-memory DB:
//   - every message is delivered;
//   - the victim gets at most `perTarget` pings per sender per window, counted
//     once per message whichever deliveries ask (inbox and `mention:received`
//     agree), across `<@id>` and `@username` and across channel and thread;
//   - the budget is per sender and per person.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
// The 5-messages-per-4-s burst limit (lib/security.ts) is not under test here:
// raise it so the pings below reach the ping cap instead of being refused.
process.env.ABUSE_BURST_MAX = '100';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../db/index', () => mockDb);
jest.mock('../middleware/rateLimit', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { limits: new Proxy({}, { get: () => pass }), rateLimit: pass };
});
jest.mock('../lib/linkPreview', () => ({ extractUrls: () => [], fetchLinkPreview: jest.fn() }));
jest.mock('../lib/pushSender', () => ({ sendPushToUser: jest.fn(async () => undefined) }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { sendChannelMessage } from '../socket/handlers/messages-send';
import threadsRouter from '../routes/threads';
import { invalidatePerms } from '../lib/permCache';
import { ABUSE_POLICY } from '../lib/abusePolicy';

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

const CAP = ABUSE_POLICY.mentions.perTarget;

let owner: ReturnType<typeof makeUser>;
let pinger: ReturnType<typeof makeUser>;
let other: ReturnType<typeof makeUser>;
let victim: ReturnType<typeof makeUser>;
let carol: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let io: ReturnType<typeof makeIo>;
let app: express.Express;
let n = 0;

beforeEach(async () => {
  mockDb._reset();
  owner = makeUser(); pinger = makeUser(); other = makeUser(); victim = makeUser(); carol = makeUser();
  server = makeServer(owner._id);
  channel = makeChannel(server._id);
  for (const u of [owner, pinger, other, victim, carol]) {
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

/** Send in the channel as `as`; the message itself must always be delivered. */
async function send(content: string, as = pinger) {
  const socket = makeSocket();
  const before = io.emitted.filter(e => e.ev === 'message:new').length;
  await sendChannelMessage(
    { channelId: channel._id, serverId: server._id, content, ackId: `ack-ping-${++n}` } as never,
    socket as never, io as never, as as never, new Map(),
  );
  expect(socket.emitted.filter(e => e.ev === 'error:message' || e.ev === 'error:spam')).toEqual([]);
  expect(io.emitted.filter(e => e.ev === 'message:new').length).toBe(before + 1);
}

/** Reply in the thread as `as`; the reply itself must always be posted. */
async function reply(content: string, as = pinger) {
  const token = jwt.sign({ id: as._id, username: as.username, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  const res = await request(app).post('/api/threads/thread-1/messages').set('Authorization', `Bearer ${token}`).send({ content });
  expect(res.status).toBe(200);
}

const inbox = async (userId: string) => (await mockDb.notifications.find({ userId })).length;
const toUser = (userId: string, ev: string) => io.emitted.filter(e => e.to === `user:${userId}` && e.ev === ev).length;
const unread = async (userId: string) => Number((await mockDb.unreadCounts.findOne({ userId, channelId: channel._id }) as { count?: number } | null)?.count ?? 0);

/** Every delivery that makes a ping, for `userId`. */
async function pings(userId: string) {
  return {
    inbox: await inbox(userId),
    notificationMention: toUser(userId, 'notification:mention'),
    inboxChanged: toUser(userId, 'inbox:changed'),
    unread: await unread(userId),
    mentionReceived: toUser(userId, 'mention:received'),
  };
}
const exactly = (count: number) => ({ inbox: count, notificationMention: count, inboxChanged: count, unread: count, mentionReceived: count });

describe('one sender pinging one person (ATK-04b)', () => {
  it(`${CAP + 2} direct pings in a window: every message is delivered, the victim is pinged ${CAP} times`, async () => {
    for (let i = 0; i < CAP + 2; i += 1) await send(`<@${victim._id}> look ${i}`);
    expect(await pings(victim._id)).toEqual(exactly(CAP));
  });

  it('@username pings draw on the same budget as <@id> pings', async () => {
    for (let i = 0; i < CAP; i += 1) await send(`<@${victim._id}> look ${i}`);
    await send(`@${victim.username} look again`);
    await send(`@${victim.username} and again`);
    expect(await pings(victim._id)).toEqual(exactly(CAP));
  });

  it('thread replies draw on the same budget as channel messages', async () => {
    for (let i = 0; i < CAP - 1; i += 1) await send(`<@${victim._id}> look ${i}`);
    for (let i = 0; i < 3; i += 1) await reply(`<@${victim._id}> in the thread ${i}`);
    const got = await pings(victim._id);
    expect(got.inbox).toBe(CAP);
    expect(got.notificationMention).toBe(CAP);
    expect(got.unread).toBe(CAP);
  });

  it(`thread replies alone: ${CAP + 2} pings reach the victim ${CAP} times`, async () => {
    for (let i = 0; i < CAP + 2; i += 1) await reply(`<@${victim._id}> in the thread ${i}`);
    const got = await pings(victim._id);
    expect(got.inbox).toBe(CAP);
    expect(got.notificationMention).toBe(CAP);
    expect(got.unread).toBe(CAP);
  });
});

describe('CONTROL: the budget is per sender and per person', () => {
  it('after the victim is capped, another sender still pings them and the pinger still pings someone else', async () => {
    for (let i = 0; i < CAP + 1; i += 1) await send(`<@${victim._id}> look ${i}`);
    await send(`<@${victim._id}> a question from someone else`, other);
    await reply(`<@${victim._id}> and one in the thread`, other);
    await send(`<@${carol._id}> a question for carol`);

    expect((await pings(victim._id)).inbox).toBe(CAP + 2);
    expect(await pings(carol._id)).toEqual(exactly(1));
  });

  it(`exactly ${CAP} pings all arrive`, async () => {
    for (let i = 0; i < CAP; i += 1) await send(`<@${victim._id}> look ${i}`);
    expect(await pings(victim._id)).toEqual(exactly(CAP));
  });
});

describe('what does not draw on the budget', () => {
  it('@everyone from a sender with MENTION_EVERYONE (the owner) is not capped and leaves the direct budget untouched', async () => {
    for (let i = 0; i < CAP + 1; i += 1) await send(`@everyone standup ${i}`, owner);
    await send(`<@${victim._id}> and a direct ping`, owner);
    expect((await pings(victim._id)).inbox).toBe(CAP + 2);
  });

  it("a watch word is the recipient's own choice: every match notifies", async () => {
    await mockDb.notificationKeywords.insert({ _id: randomUUID(), userId: victim._id, serverId: server._id, keyword: 'deploy', createdAt: 1 });
    for (let i = 0; i < CAP + 1; i += 1) await send(`deploy number ${i} is done`);
    expect(await inbox(victim._id)).toBe(CAP + 1);
    expect(await mockDb.notifications.find({ userId: victim._id, type: 'watch' })).toHaveLength(CAP + 1);
  });
});
