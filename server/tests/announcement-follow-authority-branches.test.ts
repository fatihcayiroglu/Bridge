// server/tests/announcement-follow-authority-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DUYURU KANALLARI — TAKİP YETKİSİ VE KAYNAK/HEDEF BAĞI
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/announcement-crosspost.test.ts` yayınlama (publish) dayanıklılığını
// ölçer. Bu tamamlayıcı takım TAKİP kurulumunu ve okuma uçlarını ölçer —
// çapraz-kiracı sızıntısının kurulacağı yer orasıdır:
//
//   · İKİ TARAFLI YETKİ. Takip iki kanalı birbirine bağlar. Yalnız HEDEF
//     tarafta yetki aramak yeterli değildir: kaynağı GÖREMEYEN biri, göremediği
//     bir kanalın mesajlarını kendi sunucusuna akıtmayı kurabilirdi.
//   · HEDEF TÜRÜ. Ses/kategori gibi mesaj taşımayan bir kanal hedef olamaz;
//     olsaydı crosspost'lar hiçbir yere ulaşmadan kaybolurdu.
//   · MESAJ BAĞI. Yayınlanan mesaj GERÇEKTEN o duyuru kanalına ait olmalıdır;
//     yalnız id ile eşleşmek, başka bir kanalın mesajını duyuru gibi
//     yayınlamaya izin verirdi.
//   · KENDİNİ TAKİP. Bir kanal kendini takip edemez; ederse her yayın sonsuz
//     bir döngü üretirdi.

'use strict';
process.env.NODE_ENV = 'test';

import type { RequestBody } from './helpers/httpDoubles';
import { createMockDb, makeChannel, makeMessage } from './helpers/mockDb';
let db = createMockDb();

jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

const mockGetFollowers = jest.fn();
const mockPersistCrosspost = jest.fn();
const mockFollowChannel = jest.fn();
const mockUnfollowChannel = jest.fn();
jest.mock('../db/repositories/AnnouncementRepository', () => ({
  Announcements: {
    getFollowers: (...a: unknown[]) => mockGetFollowers(...a),
    persistCrosspost: (...a: unknown[]) => mockPersistCrosspost(...a),
    followChannel: (...a: unknown[]) => mockFollowChannel(...a),
    unfollowChannel: (...a: unknown[]) => mockUnfollowChannel(...a),
  },
}));

const PERMS = {
  VIEW_CHANNELS: 1 << 0,
  MANAGE_CHANNELS: 1 << 1,
  SEND_MESSAGES: 1 << 8,
  MANAGE_MESSAGES: 1 << 9,
  MANAGE_WEBHOOKS: 1 << 24,
  ADMINISTRATOR: 1 << 30,
};
const mockResolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => ({
  PERMS,
  hasPermission: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
  resolvePermissions: (...a: unknown[]) => mockResolvePermissions(...a),
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: () => void) => {
    req.user = { id: String(req.headers['x-test-user'] ?? 'publisher'), displayName: 'Publisher' };
    next();
  },
  castAuthed: (req: any) => ({ user: req.user }),
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { api: () => (_req: any, _res: any, next: () => void) => next() },
}));

import express from 'express';
import request from 'supertest';
import { router, setIo } from '../routes/announcement';

const SRC_SERVER = 'srv-source';
const SRC_CHANNEL = 'ch-announcement';
const TARGET_SERVER = 'srv-target';
const TARGET_CHANNEL = 'ch-target';
const USER = 'publisher';
const MESSAGE_ID = 'msg-source';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/channels', router);
  return a;
}

/** Grants every permission everywhere unless a test narrows it. */
function allowAll() { mockResolvePermissions.mockResolvedValue(0x7fffffff); }

/** Grants exactly `perms` in `channelId` and everything elsewhere. */
function limitChannel(channelId: string, perms: number) {
  mockResolvePermissions.mockImplementation(async (_u: string, _s: string, cid: string) =>
    (cid === channelId ? perms : 0x7fffffff));
}

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  jest.clearAllMocks();
  allowAll();
  setIo(null as never);
  mockGetFollowers.mockResolvedValue([]);
  mockFollowChannel.mockResolvedValue(undefined);
  mockUnfollowChannel.mockResolvedValue(undefined);

  await db.channels.insert(makeChannel(SRC_SERVER, { _id: SRC_CHANNEL, name: 'news', type: 'announcement' }));
  await db.channels.insert(makeChannel(TARGET_SERVER, { _id: TARGET_CHANNEL, name: 'genel', type: 'text' }));
  await db.members.insert({ userId: USER, serverId: SRC_SERVER, roles: [], joinedAt: Date.now() });
  await db.members.insert({ userId: USER, serverId: TARGET_SERVER, roles: [], joinedAt: Date.now() });
});

const follow = (body: RequestBody | undefined, cid = SRC_CHANNEL) =>
  request(app()).post(`/api/channels/${cid}/follow`).set('x-test-user', USER).send(body ?? {});
const unfollow = (body: RequestBody | undefined, cid = SRC_CHANNEL) =>
  request(app()).delete(`/api/channels/${cid}/follow`).set('x-test-user', USER).send(body);

describe('setting up a follow', () => {
  it('links the two channels and announces it in the target', async () => {
    const res = await follow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sourceChannelId: SRC_CHANNEL, targetChannelId: TARGET_CHANNEL });
    expect(mockFollowChannel).toHaveBeenCalledWith(SRC_CHANNEL, SRC_SERVER, TARGET_CHANNEL, TARGET_SERVER, USER);
  });

  const missingTarget: Array<[string, RequestBody | undefined]> = [
    ['an absent body', undefined],
    ['an empty object', {}],
    ['a blank target', { targetChannelId: '' }],
    ['a non-string target', { targetChannelId: 42 }],
    ['an array body', []],
  ];
  for (const [name, body] of missingTarget) {
    it(`refuses ${name} before reading any channel`, async () => {
      const res = await follow(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('targetChannelId required');
      expect(mockFollowChannel).not.toHaveBeenCalled();
    });
  }

  it('refuses a source channel that is not an announcement channel', async () => {
    const res = await follow({ targetChannelId: TARGET_CHANNEL }, TARGET_CHANNEL);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ANNOUNCEMENT');
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('refuses a source channel that does not exist at all', async () => {
    const res = await follow({ targetChannelId: TARGET_CHANNEL }, 'ch-missing');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ANNOUNCEMENT');
  });

  it('refuses a target channel that does not exist', async () => {
    const res = await follow({ targetChannelId: 'ch-missing' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Target channel not found');
  });

  const unsupportedTargets = ['voice', 'category', 'stage'];
  for (const type of unsupportedTargets) {
    it(`refuses a ${type} channel as a follow target`, async () => {
      await db.channels.insert(makeChannel(TARGET_SERVER, { _id: `ch-${type}`, type }));
      const res = await follow({ targetChannelId: `ch-${type}` });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not support announcement messages/);
      expect(mockFollowChannel).not.toHaveBeenCalled();
    });
  }

  it('accepts a forum channel as a target', async () => {
    await db.channels.insert(makeChannel(TARGET_SERVER, { _id: 'ch-forum', type: 'forum' }));
    const res = await follow({ targetChannelId: 'ch-forum' });
    expect(res.status).toBe(200);
  });

  it('refuses a target server the caller is not a member of', async () => {
    await db.channels.insert(makeChannel('srv-elsewhere', { _id: 'ch-elsewhere', type: 'text' }));
    const res = await follow({ targetChannelId: 'ch-elsewhere' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member of the target server/);
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('refuses a caller who cannot see the SOURCE channel', async () => {
    // Otherwise a member who cannot read the announcements could still pipe
    // them into a server they do control.
    limitChannel(SRC_CHANNEL, 0);
    const res = await follow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Source channel is not visible/);
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('refuses a caller who cannot see the target channel', async () => {
    limitChannel(TARGET_CHANNEL, 0);
    const res = await follow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/No permission to configure announcement follows/);
  });

  it('refuses a caller who can see but not configure the target channel', async () => {
    limitChannel(TARGET_CHANNEL, PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES);
    const res = await follow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  const configuringPerms: Array<[string, number]> = [
    ['manage webhooks', PERMS.VIEW_CHANNELS | PERMS.MANAGE_WEBHOOKS],
    ['manage channels', PERMS.VIEW_CHANNELS | PERMS.MANAGE_CHANNELS],
  ];
  for (const [name, perms] of configuringPerms) {
    it(`accepts a caller with ${name} on the target`, async () => {
      limitChannel(TARGET_CHANNEL, perms);
      const res = await follow({ targetChannelId: TARGET_CHANNEL });
      expect(res.status).toBe(200);
    });
  }

  it('a permission lookup failure is treated as no permission', async () => {
    mockResolvePermissions.mockRejectedValue(new Error('permission store offline'));
    const res = await follow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('a channel cannot follow itself', async () => {
    const res = await follow({ targetChannelId: SRC_CHANNEL });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot follow own channel');
    expect(mockFollowChannel).not.toHaveBeenCalled();
  });

  it('a persistence failure is reported rather than reported as success', async () => {
    mockFollowChannel.mockRejectedValue(new Error('follow table offline'));
    const res = await follow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB error');
  });
});

describe('removing a follow', () => {
  it('removes the link for an authorized caller', async () => {
    const res = await unfollow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(200);
    expect(mockUnfollowChannel).toHaveBeenCalledWith(SRC_CHANNEL, TARGET_CHANNEL);
  });

  it('requires a target channel id', async () => {
    const res = await unfollow({});
    expect(res.status).toBe(400);
    expect(mockUnfollowChannel).not.toHaveBeenCalled();
  });

  it('refuses an unknown target channel', async () => {
    const res = await unfollow({ targetChannelId: 'ch-missing' });
    expect(res.status).toBe(404);
  });

  it('refuses a non-member of the target server', async () => {
    await db.channels.insert(makeChannel('srv-elsewhere', { _id: 'ch-elsewhere', type: 'text' }));
    const res = await unfollow({ targetChannelId: 'ch-elsewhere' });
    expect(res.status).toBe(403);
    expect(mockUnfollowChannel).not.toHaveBeenCalled();
  });

  it('refuses a member who cannot configure the target channel', async () => {
    limitChannel(TARGET_CHANNEL, PERMS.VIEW_CHANNELS);
    const res = await unfollow({ targetChannelId: TARGET_CHANNEL });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/No permission to remove announcement follows/);
  });
});

describe('listing followers', () => {
  const followers = (cid = SRC_CHANNEL) =>
    request(app()).get(`/api/channels/${cid}/followers`).set('x-test-user', USER);

  it('returns the follower list with its count', async () => {
    mockGetFollowers.mockResolvedValue([
      { targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER },
    ]);
    const res = await followers();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.followers).toHaveLength(1);
  });

  it('refuses an unknown channel', async () => {
    const res = await followers('ch-missing');
    expect(res.status).toBe(404);
    expect(mockGetFollowers).not.toHaveBeenCalled();
  });

  it('refuses a non-member of the channel server', async () => {
    await db.channels.insert(makeChannel('srv-elsewhere', { _id: 'ch-elsewhere', type: 'announcement' }));
    const res = await followers('ch-elsewhere');
    expect(res.status).toBe(403);
    expect(mockGetFollowers).not.toHaveBeenCalled();
  });

  it('refuses a member who cannot view the channel', async () => {
    limitChannel(SRC_CHANNEL, 0);
    const res = await followers();
    expect(res.status).toBe(403);
    expect(mockGetFollowers).not.toHaveBeenCalled();
  });
});

describe('publishing a message binds it to its own announcement channel', () => {
  const crosspost = (cid = SRC_CHANNEL, mid = MESSAGE_ID) =>
    request(app()).post(`/api/channels/${cid}/messages/${mid}/crosspost`).set('x-test-user', USER);

  beforeEach(async () => {
    await db.messages.insert(makeMessage(SRC_CHANNEL, SRC_SERVER, USER, {
      _id: MESSAGE_ID, content: 'Durable announcement', displayName: 'Alice', username: 'alice',
    }));
  });

  it('refuses a source channel that is not an announcement channel', async () => {
    const res = await crosspost(TARGET_CHANNEL);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ANNOUNCEMENT');
  });

  it('refuses a message that does not exist', async () => {
    const res = await crosspost(SRC_CHANNEL, 'msg-missing');
    expect(res.status).toBe(404);
  });

  it('refuses a message that belongs to another channel', async () => {
    await db.messages.insert(makeMessage(TARGET_CHANNEL, TARGET_SERVER, USER, { _id: 'msg-elsewhere' }));
    const res = await crosspost(SRC_CHANNEL, 'msg-elsewhere');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong to announcement channel/);
  });

  it('refuses a message whose server does not match the channel server', async () => {
    await db.messages.insert(makeMessage(SRC_CHANNEL, 'srv-other', USER, { _id: 'msg-crosstenant' }));
    const res = await crosspost(SRC_CHANNEL, 'msg-crosstenant');
    expect(res.status).toBe(400);
    expect(mockGetFollowers).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not a member of the source server', async () => {
    const res = await request(app())
      .post(`/api/channels/${SRC_CHANNEL}/messages/${MESSAGE_ID}/crosspost`)
      .set('x-test-user', 'stranger');
    expect(res.status).toBe(403);
    expect(mockGetFollowers).not.toHaveBeenCalled();
  });

  it('refuses a member who cannot view the source channel', async () => {
    limitChannel(SRC_CHANNEL, 0);
    const res = await crosspost();
    expect(res.status).toBe(403);
  });

  it('lets an author publish their own message with send permission', async () => {
    limitChannel(SRC_CHANNEL, PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES);
    const res = await crosspost();
    expect(res.status).toBe(200);
    expect(res.body.crosspostedTo).toBe(0);
  });

  it('refuses an author who has lost send permission', async () => {
    limitChannel(SRC_CHANNEL, PERMS.VIEW_CHANNELS);
    const res = await crosspost();
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/No permission to publish this message/);
  });

  it('lets a moderator publish someone else\'s message', async () => {
    await db.messages.insert(makeMessage(SRC_CHANNEL, SRC_SERVER, 'someone-else', {
      _id: 'msg-other-author', displayName: 'Bob', username: 'bob',
    }));
    limitChannel(SRC_CHANNEL, PERMS.VIEW_CHANNELS | PERMS.MANAGE_MESSAGES);
    const res = await crosspost(SRC_CHANNEL, 'msg-other-author');
    expect(res.status).toBe(200);
  });

  it('refuses a non-moderator publishing someone else\'s message', async () => {
    await db.messages.insert(makeMessage(SRC_CHANNEL, SRC_SERVER, 'someone-else', {
      _id: 'msg-other-author-2', displayName: 'Bob', username: 'bob',
    }));
    limitChannel(SRC_CHANNEL, PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES);
    const res = await crosspost(SRC_CHANNEL, 'msg-other-author-2');
    expect(res.status).toBe(403);
  });

  it('a message with no followers is a successful no-op', async () => {
    mockGetFollowers.mockResolvedValue([]);
    const res = await crosspost();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, crosspostedTo: 0, message: 'No followers' });
    expect(mockPersistCrosspost).not.toHaveBeenCalled();
  });

  it('falls back to the display name when the author has no username', async () => {
    await db.messages.insert(makeMessage(SRC_CHANNEL, SRC_SERVER, USER, {
      _id: 'msg-no-username', displayName: 'Alice', username: undefined,
    }));
    mockGetFollowers.mockResolvedValue([{ targetChannelId: TARGET_CHANNEL, targetServerId: TARGET_SERVER }]);
    mockPersistCrosspost.mockResolvedValue({ bridgeMessageId: 'bridge-1', created: true });

    const res = await crosspost(SRC_CHANNEL, 'msg-no-username');

    expect(res.status).toBe(200);
    expect(mockPersistCrosspost).toHaveBeenCalledWith(expect.objectContaining({
      username: 'Alice', displayName: '📢 Alice',
    }));
  });
});
