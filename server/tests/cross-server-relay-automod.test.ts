// server/tests/cross-server-relay-automod.test.ts
//
// Two relays write into a channel of ANOTHER server:
//   - a channel bridge copies each text message from its source channel into
//     its target channel (socket/handlers/messages-send.ts);
//   - an announcement crosspost copies a published announcement into every
//     follower channel (routes/announcement.ts).
// The copy passed only the SOURCE server's AutoMod; the receiving server's
// own rules never ran, although its moderators configured them for exactly
// that channel and an incoming webhook into it is moderated (`webhook:<id>`).
// Creating a bridge needs MANAGE_CHANNELS, a follow MANAGE_CHANNELS or
// MANAGE_WEBHOOKS, while AutoMod is managed with MANAGE_SERVER: a channel
// manager could route around the server's moderation.
//
// The bridge also relayed the raw socket payload instead of the stored text:
// C0/C1 control characters that storage strips were copied verbatim into the
// other server. (An e2ee message, stored without plaintext, would have had its
// payload `content` copied too; `message:send` refuses that type today, which
// a boundary test below pins.)
//
// Now each relay is a machine principal of the receiving server
// (`bridge:<id>`, `crosspost:<sourceChannelId>`): its rules apply to the copy,
// a match refuses that copy only (the source message stays), and a rule-store
// failure skips the copy (fail closed). Real AutoMod evaluator, real
// permission resolver, in-memory DB.
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
const mockE2EEChannels = new Set<string>();
jest.mock('../lib/channelE2EE', () => ({
  ...jest.requireActual('../lib/channelE2EE'),
  isChannelE2EEEnabled: async (channelId: string) => mockE2EEChannels.has(channelId),
}));
// The crosspost transaction is PostgreSQL-specific; the route under test is
// what decides whether it is reached.
const mockGetFollowers = jest.fn();
const mockPersistCrosspost = jest.fn();
jest.mock('../db/repositories/AnnouncementRepository', () => ({
  Announcements: {
    getFollowers: (...args: unknown[]) => mockGetFollowers(...args),
    persistCrosspost: (...args: unknown[]) => mockPersistCrosspost(...args),
    followChannel: jest.fn(), unfollowChannel: jest.fn(),
  },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { sendChannelMessage } from '../socket/handlers/messages-send';
import { router as announcementRouter, setIo } from '../routes/announcement';
import { invalidatePerms } from '../lib/permCache';
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

let sourceOwner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let targetOwner: ReturnType<typeof makeUser>;
let source: ReturnType<typeof makeServer>;
let target: ReturnType<typeof makeServer>;
let sourceChannel: ReturnType<typeof makeChannel>;
let targetChannel: ReturnType<typeof makeChannel>;
let io: ReturnType<typeof makeIo>;

beforeEach(async () => {
  mockDb._reset();
  mockE2EEChannels.clear();
  jest.clearAllMocks();
  sourceOwner = makeUser(); member = makeUser(); targetOwner = makeUser();
  source = makeServer(sourceOwner._id);
  target = makeServer(targetOwner._id);
  sourceChannel = makeChannel(source._id, { name: 'source' });
  targetChannel = makeChannel(target._id, { name: 'target' });
  for (const u of [sourceOwner, member, targetOwner]) await mockDb.users.insert(u);
  for (const u of [sourceOwner, member]) {
    await mockDb.members.insert({ userId: u._id, serverId: source._id, joinedAt: Date.now(), roles: '[]' });
  }
  await mockDb.members.insert({ userId: targetOwner._id, serverId: target._id, joinedAt: Date.now(), roles: '[]' });
  for (const s of [source, target]) await mockDb.servers.insert(s);
  for (const c of [sourceChannel, targetChannel]) await mockDb.channels.insert(c);
  invalidatePerms(source._id);
  invalidatePerms(target._id);
  io = makeIo();
});

async function blockWord(serverId: string, word = 'forbiddenword') {
  await mockDb.automodRules.insert({
    _id: randomUUID(), serverId, type: 'blocked_words', enabled: true,
    config: JSON.stringify({ words: [word], action: 'delete' }), createdAt: Date.now(),
  });
}
const stored = async (channelId: string) =>
  ((await mockDb.messages.find({ channelId })) as Array<{ content?: string; type?: string }>);
const broadcastsTo = (channelId: string) => io.emitted.filter(e => e.to === `channel:${channelId}` && e.ev === 'message:new');

describe('a channel bridge is moderated by the TARGET server', () => {
  beforeEach(async () => {
    await mockDb.channelBridges.insert({
      _id: 'bridge-1', sourceChannelId: sourceChannel._id, sourceServerId: source._id,
      targetChannelId: targetChannel._id, targetServerId: target._id, active: true, label: 'Relay',
    });
  });

  async function send(payload: Record<string, unknown>) {
    const socket = makeSocket();
    await sendChannelMessage(
      { channelId: sourceChannel._id, serverId: source._id, ackId: `ack-${randomUUID()}`, ...payload } as never,
      socket as never, io as never, member as never, new Map(),
    );
    return socket.emitted.find(e => e.ev.startsWith('error:')) ?? null;
  }

  it('control: without target rules the copy is stored and broadcast in the target channel', async () => {
    expect(await send({ content: 'hello there' })).toBeNull();
    expect((await stored(targetChannel._id)).map(m => m.content)).toEqual(['🌉 **[Relay]** hello there']);
    expect(broadcastsTo(targetChannel._id)).toHaveLength(1);
  });

  it('a word the target refuses is not copied; the source message stays', async () => {
    await blockWord(target._id);
    expect(await send({ content: 'say forbiddenword now' })).toBeNull();
    expect((await stored(sourceChannel._id)).map(m => m.content)).toEqual(['say forbiddenword now']);
    expect(await stored(targetChannel._id)).toEqual([]);
    expect(broadcastsTo(targetChannel._id)).toEqual([]);
  });

  it('a match is written to the target server\'s AutoMod log channel', async () => {
    const logChannel = makeChannel(target._id, { name: 'mod-log' });
    await mockDb.channels.insert(logChannel);
    await mockDb.automodRules.insert({
      _id: randomUUID(), serverId: target._id, type: 'blocked_words', enabled: true,
      config: JSON.stringify({ words: ['forbiddenword'], action: 'delete', logChannelId: logChannel._id }), createdAt: Date.now(),
    });
    await send({ content: 'say forbiddenword now' });
    expect((await stored(logChannel._id)).length).toBe(1);
  });

  it('the target\'s rule-store failure skips the copy (fail closed); the source message stays', async () => {
    const original = Automod.findByServer.bind(Automod);
    const spy = jest.spyOn(Automod, 'findByServer').mockImplementation(async (serverId: string) => {
      if (serverId === target._id) throw new Error('automod rule store unavailable');
      return original(serverId);
    });
    try {
      expect(await send({ content: 'hello there' })).toBeNull();
      expect(await stored(sourceChannel._id)).toHaveLength(1);
      expect(await stored(targetChannel._id)).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('boundary: an e2ee payload is refused at validation, so no plaintext field can reach the target', async () => {
    // `message:send` accepts only normal/file/sticker types today. The relay
    // also skips e2ee messages and copies the stored text, should that change.
    mockE2EEChannels.add(sourceChannel._id);
    const refused = await send({ type: 'e2ee', encryptedContent: 'Y2lwaGVydGV4dA==', iv: 'aXZpdml2aXY=', content: 'leaked plaintext' });
    expect(refused?.data).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await stored(sourceChannel._id)).toEqual([]);
    expect(await stored(targetChannel._id)).toEqual([]);
    expect(JSON.stringify(io.emitted)).not.toContain('leaked plaintext');
  });

  it('the copy carries the stored text: control characters storage strips are not relayed', async () => {
    await send({ content: 'hello\u0001 there\u0007' });
    expect((await stored(sourceChannel._id)).map(m => m.content)).toEqual(['hello there']);
    expect((await stored(targetChannel._id)).map(m => m.content)).toEqual(['🌉 **[Relay]** hello there']);
  });
});

describe('an announcement crosspost is moderated by each FOLLOWER server', () => {
  let other: ReturnType<typeof makeServer>;
  let otherChannel: ReturnType<typeof makeChannel>;
  let app: express.Express;

  beforeEach(async () => {
    await mockDb.channels.update({ _id: sourceChannel._id }, { $set: { type: 'announcement' } });
    other = makeServer(targetOwner._id);
    otherChannel = makeChannel(other._id, { name: 'other' });
    await mockDb.servers.insert(other);
    await mockDb.channels.insert(otherChannel);
    await mockDb.messages.insert({
      _id: 'announcement-1', channelId: sourceChannel._id, serverId: source._id, userId: sourceOwner._id,
      username: 'owner', displayName: 'Owner', content: 'release forbiddenword notes', contentFormat: 1, type: 'normal', createdAt: Date.now(),
    });
    mockGetFollowers.mockResolvedValue([
      { targetChannelId: targetChannel._id, targetServerId: target._id },
      { targetChannelId: otherChannel._id, targetServerId: other._id },
    ]);
    mockPersistCrosspost.mockImplementation(async () => ({ bridgeMessageId: randomUUID(), created: true }));
    setIo(io as never);
    app = express();
    app.use(express.json());
    app.use('/api/channels', announcementRouter);
    app.use(errorHandler);
  });
  afterEach(() => setIo(null as never));

  const publish = () => request(app).post(`/api/channels/${sourceChannel._id}/messages/announcement-1/crosspost`)
    .set('Authorization', `Bearer ${jwt.sign({ id: sourceOwner._id, username: 'owner', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`);
  const persistedTargets = () => mockPersistCrosspost.mock.calls.map(([input]) => (input as { targetChannelId: string }).targetChannelId);
  const newMessageRooms = () => io.emitted.filter(e => e.ev === 'new_message').map(e => e.to);

  it('control: without follower rules both followers receive it', async () => {
    const res = await publish();
    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(2);
    expect(persistedTargets()).toEqual([targetChannel._id, otherChannel._id]);
  });

  it('a follower whose AutoMod refuses the text gets no copy; the other follower still does', async () => {
    await blockWord(target._id);
    const res = await publish();
    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(1);
    expect(res.body.errors).toEqual([`${targetChannel._id}: Refused by the follower server moderation`]);
    expect(persistedTargets()).toEqual([otherChannel._id]);
    expect(newMessageRooms()).toEqual([`channel:${otherChannel._id}`]);
  });

  it('a follower\'s rule-store failure skips that follower with a bounded error (fail closed)', async () => {
    const original = Automod.findByServer.bind(Automod);
    const spy = jest.spyOn(Automod, 'findByServer').mockImplementation(async (serverId: string) => {
      if (serverId === target._id) throw new Error('db host 10.0.0.5 refused connection');
      return original(serverId);
    });
    try {
      const res = await publish();
      expect(res.body.crosspostedTo).toBe(1);
      expect(res.body.errors).toEqual([`${targetChannel._id}: Follower server moderation unavailable`]);
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
      expect(persistedTargets()).toEqual([otherChannel._id]);
    } finally { spy.mockRestore(); }
  });
});
