// server/tests/mention-everyone-permission.test.ts
//
// `@everyone` and `@here` notify every member who can see the channel: an
// inbox row, a push, a realtime `notification:mention` and +1 unread each.
// Who may do that is the MENTION_EVERYONE permission ("Mention @everyone" in
// the role editor). It is not in DEFAULT_PERMISSIONS, so an ordinary member
// does not have it.
//
// The contract, through the real send path (`sendChannelMessage`), the real
// permission resolver and the real notification pipeline on the in-memory DB:
//   - without MENTION_EVERYONE in that channel the message is posted as usual,
//     but `@everyone` / `@here` notify nobody;
//   - with it (a role, a channel override, the owner, ADMINISTRATOR) they
//     notify every member who can see the channel;
//   - direct mentions in the same message still notify the people named;
//   - a thread reply (POST /api/threads/:id/messages) follows the same rule.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

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
import { sendChannelMessage } from '../socket/handlers/messages-send';
import threadsRouter from '../routes/threads';
import { invalidatePerms } from '../lib/permCache';
import * as permissions from '../lib/permissions';
import { DEFAULT_PERMISSIONS, PERMS } from '../lib/permissions';
import { processNotifications } from '../lib/notifications';

type Emitted = { ev: string; data: Record<string, unknown>; to?: string };

function makeSocket() {
  const emitted: Emitted[] = [];
  return {
    id: 'sock-everyone', rooms: new Set<string>(), emitted,
    on() {},
    emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data }); },
    to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; },
    join() {}, leave() {},
  };
}
function makeIo() {
  const emitted: Emitted[] = [];
  return { emitted, to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; } };
}

let owner: ReturnType<typeof makeUser>;
let sender: ReturnType<typeof makeUser>;
let bob: ReturnType<typeof makeUser>;
let carol: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let io: ReturnType<typeof makeIo>;
let counter = 0;

beforeEach(async () => {
  mockDb._reset();
  owner = makeUser(); sender = makeUser(); bob = makeUser(); carol = makeUser();
  server = makeServer(owner._id);
  channel = makeChannel(server._id);
  for (const u of [owner, sender, bob, carol]) await mockDb.users.insert(u);
  await mockDb.servers.insert(server);
  await mockDb.channels.insert(channel);
  for (const u of [owner, sender, bob, carol]) {
    await mockDb.members.insert({ userId: u._id, serverId: server._id, joinedAt: Date.now(), roles: '[]' });
  }
  invalidatePerms(server._id);
  io = makeIo();
});

/** Send as `as`; the message itself must always be posted. */
async function send(content: string, as = sender) {
  const socket = makeSocket();
  const before = io.emitted.filter(e => e.ev === 'message:new').length;
  await sendChannelMessage(
    { channelId: channel._id, serverId: server._id, content, ackId: `ack-everyone-${++counter}` } as never,
    socket as never, io as never, as as never, new Map(),
  );
  expect(socket.emitted.filter(e => e.ev === 'error:message')).toEqual([]);
  expect(io.emitted.filter(e => e.ev === 'message:new').length).toBe(before + 1);
  return socket;
}

/** A role with the ordinary member permissions plus `extra`. */
async function grantRole(userId: string, extra: number) {
  await mockDb.roles.insert({ _id: 'role-announce', serverId: server._id, name: 'announcer', permissions: DEFAULT_PERMISSIONS | extra, position: 1, createdAt: 1 });
  await mockDb.members.update({ userId, serverId: server._id }, { $set: { roles: JSON.stringify(['role-announce']) } });
  invalidatePerms(server._id);
}

const notified = async (userId: string) => (await mockDb.notifications.find({ userId })).length;
const mentionEvents = (userId: string) => io.emitted.filter(e => e.to === `user:${userId}` && e.ev === 'notification:mention');
const unread = async (userId: string) => Number((await mockDb.unreadCounts.findOne({ userId, channelId: channel._id }) as { count?: number } | null)?.count ?? 0);
const posted = () => io.emitted.filter(e => e.ev === 'message:new' && e.to === `channel:${channel._id}`);

describe('@everyone / @here without MENTION_EVERYONE', () => {
  it.each(['@everyone standup in 5', '@here standup in 5'])('"%s" is posted but notifies nobody', async (content) => {
    const socket = await send(content);

    expect(socket.emitted.filter(e => e.ev === 'error:message')).toEqual([]);
    expect(posted()).toHaveLength(1);
    for (const u of [owner, bob, carol]) {
      expect(await notified(u._id)).toBe(0);
      expect(mentionEvents(u._id)).toEqual([]);
      expect(await unread(u._id)).toBe(0);
    }
  });

  it('direct mentions in the same message still notify the people named', async () => {
    await send(`@everyone <@${bob._id}> please review`);

    expect(await notified(bob._id)).toBe(1);
    expect(mentionEvents(bob._id)).toHaveLength(1);
    expect(await notified(carol._id)).toBe(0);
    expect(await notified(owner._id)).toBe(0);
  });

  it('a channel override that denies MENTION_EVERYONE wins over a role that grants it', async () => {
    await grantRole(sender._id, PERMS.MENTION_EVERYONE);
    await mockDb.channelOverrides.insert({
      _id: 'ovr-no-everyone', channelId: channel._id, targetType: 'role', targetId: 'role-announce',
      allow: 0, deny: PERMS.MENTION_EVERYONE, position: 0,
    });
    invalidatePerms(server._id);

    await send('@everyone standup in 5');
    for (const u of [owner, bob, carol]) expect(await notified(u._id)).toBe(0);
  });
});

describe('when the sender\'s permissions cannot be resolved', () => {
  afterEach(() => jest.restoreAllMocks());

  it('@everyone fails closed: nobody is notified', async () => {
    const real = permissions.resolvePermissions;
    jest.spyOn(permissions, 'resolvePermissions').mockImplementation(async (userId, ...rest) => {
      if (userId === owner._id) throw new Error('permission store unavailable');
      return real(userId, ...rest);
    });
    // The owner would be allowed; only the failed lookup stands in the way.
    await processNotifications(
      { _id: 'msg-fail-closed', content: '@everyone standup', channelId: channel._id, serverId: server._id, userId: owner._id, createdAt: 1 } as never,
      io, new Map(),
    );
    for (const u of [sender, bob, carol]) expect(await notified(u._id)).toBe(0);
  });
});

describe('@everyone / @here with MENTION_EVERYONE', () => {
  it.each([
    '@everyone_else is a username, not a mass ping',
    '@here123 is a username, not a mass ping',
    '@everyoneElse is a username, not a mass ping',
  ])('a privileged user writing %s does not trigger a mass notification', async (content) => {
    await grantRole(sender._id, PERMS.MENTION_EVERYONE);
    await send(content);
    expect(posted()).toHaveLength(1);
    for (const u of [owner, bob, carol]) {
      expect(await notified(u._id)).toBe(0);
      expect(mentionEvents(u._id)).toEqual([]);
      expect(await unread(u._id)).toBe(0);
    }
  });

  it('a role that grants it: every member who can see the channel is notified', async () => {
    await grantRole(sender._id, PERMS.MENTION_EVERYONE);
    await send('@everyone standup in 5');

    for (const u of [owner, bob, carol]) {
      expect(await notified(u._id)).toBe(1);
      expect(mentionEvents(u._id)).toHaveLength(1);
      expect(await unread(u._id)).toBe(1);
    }
    expect(await notified(sender._id)).toBe(0);
  });

  it('ADMINISTRATOR: notified', async () => {
    await grantRole(sender._id, PERMS.ADMINISTRATOR);
    await send('@here standup in 5');
    for (const u of [owner, bob, carol]) expect(await notified(u._id)).toBe(1);
  });

  it('the server owner: notified', async () => {
    await send('@everyone standup in 5', owner);
    for (const u of [sender, bob, carol]) expect(await notified(u._id)).toBe(1);
  });

  it('a member who cannot see the channel is still not notified', async () => {
    await grantRole(sender._id, PERMS.MENTION_EVERYONE);
    await mockDb.channelOverrides.insert({
      _id: 'ovr-carol-hidden', channelId: channel._id, targetType: 'user', targetId: carol._id,
      allow: 0, deny: PERMS.VIEW_CHANNELS, position: 0,
    });
    invalidatePerms(server._id);

    await send('@everyone standup in 5');
    expect(await notified(bob._id)).toBe(1);
    expect(await notified(carol._id)).toBe(0);
  });
});

describe('thread replies follow the same rule', () => {
  let app: express.Express;
  const token = (userId: string) => jwt.sign({ id: userId, username: 'tester', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

  beforeEach(async () => {
    const parent = { _id: 'parent-msg', channelId: channel._id, serverId: server._id, userId: owner._id, content: 'topic', createdAt: 1 };
    await mockDb.messages.insert(parent);
    await mockDb.threads.insert({
      _id: 'thread-1', channelId: channel._id, serverId: server._id, parentMessageId: parent._id, name: 'topic',
      createdBy: owner._id, createdAt: 1, lastMessageAt: 1, messageCount: 0,
    });
    app = express();
    app.set('io', io);
    app.set('socketUsers', new Map());
    app.use(express.json());
    app.use('/api/threads', threadsRouter);
  });

  const reply = (content: string, as = sender) => request(app)
    .post('/api/threads/thread-1/messages')
    .set('Authorization', `Bearer ${token(as._id)}`)
    .send({ content });

  it('without MENTION_EVERYONE: the reply is posted, @everyone notifies nobody', async () => {
    const res = await reply('@everyone look at this');
    expect(res.status).toBe(200);
    for (const u of [owner, bob, carol]) {
      expect(await notified(u._id)).toBe(0);
      expect(mentionEvents(u._id)).toEqual([]);
    }
  });

  it('with MENTION_EVERYONE: every member who can see the channel is notified', async () => {
    await grantRole(sender._id, PERMS.MENTION_EVERYONE);
    const res = await reply('@everyone look at this');
    expect(res.status).toBe(200);
    for (const u of [owner, bob, carol]) expect(await notified(u._id)).toBe(1);
  });
});
