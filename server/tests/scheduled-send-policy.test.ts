// server/tests/scheduled-send-policy.test.ts
//
// A scheduled message is a channel message posted later on its author's
// behalf. When it is posted it must pass what a message sent at that moment
// passes (socket/handlers/messages-send.ts):
//   - a member who is timed out cannot post: not when scheduling, and not when
//     the schedule comes due during a timeout given after scheduling;
//   - the content checks (lib/messageContentPolicy.ts): the server's AutoMod
//     rules, the P7 repeated-content limits and the P7 mass-mention limit.
// Neither the route (POST /api/scheduled) nor the dispatcher
// (jobs/scheduledMessages.ts) applied any of them.
//
// Through the real route, the real dispatcher, the real AutoMod evaluator,
// abuse policy and permission resolver on the in-memory DB. Rules and
// timeouts are set after scheduling, so the dispatcher is what must apply
// them: the state at posting time decides.
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
import scheduledRouter from '../routes/scheduled';
import { _dispatchDueForTest, startScheduledJob, stopScheduledJob } from '../jobs/scheduledMessages';
import { sendChannelMessage } from '../socket/handlers/messages-send';
import { invalidatePerms } from '../lib/permCache';
import { ABUSE_POLICY } from '../lib/abusePolicy';

type Emitted = { ev: string; data: Record<string, unknown>; to?: string };
const emitted: Emitted[] = [];
const io = { to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; } };

let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let app: express.Express;
const people: Array<ReturnType<typeof makeUser>> = [];

beforeAll(() => startScheduledJob(io as never));
afterAll(() => stopScheduledJob());

beforeEach(async () => {
  mockDb._reset();
  emitted.length = 0;
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
  app = express();
  app.use(express.json());
  app.use('/api/scheduled', scheduledRouter);
});

function schedule(content: string, as = member) {
  const token = jwt.sign({ id: as._id, username: as.username, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return request(app).post('/api/scheduled').set('Authorization', `Bearer ${token}`)
    .send({ channelId: channel._id, serverId: server._id, content, sendAt: new Date(Date.now() + 60_000).toISOString() });
}

/** Schedule `content`, let `before` change the world, make it due and dispatch. */
async function scheduleAndDispatch(content: string, before: () => Promise<unknown> = async () => undefined, as = member) {
  const res = await schedule(content, as);
  expect(res.status).toBe(200);
  const id = String(res.body._id);
  await before();
  await mockDb.scheduledMsgs.update({ _id: id }, { $set: { sendAt: Date.now() - 1 } });
  await _dispatchDueForTest();
  return await mockDb.scheduledMsgs.findOne({ _id: id }) as { sent?: boolean; failedAt?: number | null; failureReason?: string | null };
}

const postedFromSchedule = async () => (await mockDb.messages.find({ channelId: channel._id })).filter(m => (m as { scheduledId?: unknown }).scheduledId);
const broadcasts = () => emitted.filter(e => e.ev === 'message:new' && e.to === `channel:${channel._id}`);
const timeOut = (userId: string) => mockDb.members.update({ userId, serverId: server._id }, { $set: { timeoutUntil: Date.now() + 10 * 60_000 } });

async function blockWord(word: string, action = 'delete') {
  await mockDb.automodRules.insert({
    _id: randomUUID(), serverId: server._id, type: 'blocked_words', enabled: true,
    config: JSON.stringify({ words: [word], action }), createdAt: Date.now(),
  });
}

describe('a timed-out member', () => {
  it('cannot schedule a message', async () => {
    await timeOut(member._id);
    const res = await schedule('a message for later');
    expect(res.status).toBe(403);
    expect(await mockDb.scheduledMsgs.find({ userId: member._id })).toEqual([]);
  });

  it('timed out after scheduling: the message is not posted when it comes due', async () => {
    const row = await scheduleAndDispatch('a message for later', () => timeOut(member._id));
    expect(await postedFromSchedule()).toEqual([]);
    expect(broadcasts()).toEqual([]);
    expect(row).toMatchObject({ sent: false, failureReason: 'member_timed_out' });
  });
});

describe('the content checks apply when a scheduled message is posted', () => {
  it('AutoMod: a blocked word is not posted', async () => {
    const row = await scheduleAndDispatch('this has forbiddenword in it', () => blockWord('forbiddenword'));
    expect(await postedFromSchedule()).toEqual([]);
    expect(broadcasts()).toEqual([]);
    expect(row).toMatchObject({ sent: false, failureReason: 'automod_blocked' });
  });

  it('AutoMod: a timeout rule times the author out', async () => {
    await scheduleAndDispatch('this has forbiddenword in it', () => blockWord('forbiddenword', 'delete_and_timeout'));
    const m = await mockDb.members.findOne({ userId: member._id, serverId: server._id }) as { timeoutUntil?: number } | null;
    expect(Number(m?.timeoutUntil ?? 0)).toBeGreaterThan(Date.now());
  });

  it(`more than ${ABUSE_POLICY.mentions.perMessage} distinct people is not posted`, async () => {
    const row = await scheduleAndDispatch(people.map(p => `<@${p._id}>`).join(' '));
    expect(await postedFromSchedule()).toEqual([]);
    expect(row).toMatchObject({ sent: false, failureReason: 'too_many_mentions' });
  });

  it('the author\'s permissions at posting time apply: the owner (MENTION_EVERYONE) may mention everyone', async () => {
    const row = await scheduleAndDispatch(people.map(p => `<@${p._id}>`).join(' '), async () => undefined, owner);
    expect(await postedFromSchedule()).toHaveLength(1);
    expect(row).toMatchObject({ sent: true });
  });

  it(`the same text more than ${ABUSE_POLICY.repeat.max} times per window is not posted, counted with channel sends`, async () => {
    const text = 'buy cheap followers at my shop now';
    const row = await scheduleAndDispatch(text, async () => {
      for (let i = 0; i < ABUSE_POLICY.repeat.max; i += 1) {
        const socket = { id: `s-${i}`, rooms: new Set<string>(), on() {}, emit() {}, to() { return { emit() {} }; }, join() {}, leave() {} };
        await sendChannelMessage(
          { channelId: channel._id, serverId: server._id, content: text, ackId: `ack-sched-${i}` } as never,
          socket as never, io as never, member as never, new Map(),
        );
      }
    });
    expect(await postedFromSchedule()).toEqual([]);
    expect(row).toMatchObject({ sent: false, failureReason: 'spam_repeat' });
  });

  it('CONTROL: ordinary text is posted when it comes due', async () => {
    const row = await scheduleAndDispatch('a perfectly ordinary scheduled message', () => blockWord('forbiddenword'));
    expect(await postedFromSchedule()).toHaveLength(1);
    expect(broadcasts()).toHaveLength(1);
    expect(row).toMatchObject({ sent: true });
  });
});
