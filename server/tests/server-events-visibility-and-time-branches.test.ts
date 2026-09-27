// server/tests/server-events-visibility-and-time-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SUNUCU ETKİNLİKLERİ — KANAL GÖRÜNÜRLÜĞÜ VE ZAMAN BÜTÜNLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/serverEvents.test.ts` mutlu yolları ölçer. Bu tamamlayıcı takım iki
// sınıfı kapatır:
import type { ServerDouble } from './helpers/socketDoubles';
//
//   · GÖRÜNÜRLÜK. Bir etkinlik bir kanala bağlanabilir. Kanalı GÖREMEYEN bir
//     üye o etkinliği de görmemelidir; aksi hâlde etkinlik başlığı/açıklaması
//     özel bir kanalın varlığını ve konusunu sızdırır. Yetki kanonik bitmask
//     çözücüsünden gelir; kanal sunucuya ait DEĞİLSE görünmez sayılır.
//   · ZAMAN BÜTÜNLÜĞÜ. Kısmi güncelleme (PATCH) sonuçtaki etkinliğe göre
//     doğrulanmalıdır: yalnız gönderilen alanlara bakmak, `startsAt`i mevcut
//     `endsAt`in ötesine taşıyıp bitişi başlangıcından ÖNCE olan bir etkinlik
//     bırakırdı.
//   · KANAL TAŞIMA. Etkinliği başka bir kanala taşımak, HEM eski hem YENİ
//     kanalda yönetim yetkisi ister ve iki odaya da ayrı olay yayınlar.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

const mockServerEvents = {
  findByServer: jest.fn(),
  findReferencedChannelIds: jest.fn(),
  findOne: jest.fn(),
  exists: jest.fn(),
  findRsvpList: jest.fn(),
  findMyRsvp: jest.fn(),
  upsertRsvp: jest.fn(),
  deleteRsvp: jest.fn(),
  countAttendees: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};
jest.mock('../db/repositories/ServerEventRepository', () => ({ ServerEvents: mockServerEvents }));

const mockMembers = { findOne: jest.fn() };
const mockChannels = { findByIdAndServer: jest.fn() };
const mockUsers = {
  findById: jest.fn(async (id: string) => ({ _id: id, id, username: `user-${id}`, tokenVersion: 0 })),
};
jest.mock('../db/repositories', () => ({
  Members: mockMembers, Channels: mockChannels, Users: mockUsers,
}));

const PERMS = {
  VIEW_CHANNELS: 1 << 0,
  MANAGE_CHANNELS: 1 << 1,
  MANAGE_SERVER: 1 << 3,
  ADMINISTRATOR: 1 << 30,
};
const mockResolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => ({
  PERMS,
  resolvePermissions: (...a: unknown[]) => mockResolvePermissions(...a),
  hasPermission: (perms: number, flag: number) =>
    (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: {
    api: (_req: unknown, _res: unknown, next: () => void) => next(),
    write: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));
jest.mock('../lib/security', () => ({
  isSafeUrl: (url: string) => url.startsWith('https://') || url.startsWith('http://'),
}));
jest.mock('../lib/logger', () => ({
  __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import serverEventsRouter from '../routes/serverEvents';

const SID = 'srv-1';
const EID = 'evt-1';
const USER = 'usr-1';

const tok = (userId: string) => jwt.sign({ id: userId, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

function buildApp() {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = {
    to(room: string) {
      return { emit(event: string, payload: unknown) { emitted.push({ room, event, payload }); } };
    },
  } satisfies ServerDouble;
  const app = express();
  app.set('io', io);
  app.use(express.json());
  app.use('/api/servers', serverEventsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return { app, emitted };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EID, server_id: SID, creator_id: USER, title: 'Etkinlik',
    description: null, location: null, channel_id: 'ch-1',
    starts_at: new Date(Date.now() + 3_600_000).toISOString(),
    ends_at: new Date(Date.now() + 7_200_000).toISOString(),
    cover_image: null, status: 'scheduled', created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Grants `perms` for `channelId` (or the server-wide lookup when null). */
function grant(map: Record<string, number>, fallback = 0) {
  mockResolvePermissions.mockImplementation(async (_u: string, _s: string, channelId: string | null) =>
    map[channelId ?? '__server__'] ?? fallback);
}

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockMembers.findOne.mockResolvedValue({ userId: USER, serverId: SID, roles: [] });
  mockChannels.findByIdAndServer.mockResolvedValue({ _id: 'ch-1', serverId: SID });
  mockServerEvents.findReferencedChannelIds.mockResolvedValue([]);
  mockServerEvents.findByServer.mockResolvedValue({ events: [], total: 0 });
  mockServerEvents.findOne.mockResolvedValue(null);
  mockServerEvents.create.mockImplementation(async (input: Record<string, unknown>) =>
    makeEvent({ channel_id: input.channelId ?? null }));
  mockServerEvents.update.mockImplementation(async () => makeEvent());
  grant({ __server__: 0xffffffff, 'ch-1': 0xffffffff });
});

describe('listing only exposes channels the caller can actually see', () => {
  const list = (query = '') => request(buildApp().app)
    .get(`/api/servers/${SID}/events${query}`).set('Authorization', `Bearer ${tok(USER)}`);

  it('passes only the visible channel ids to the repository', async () => {
    mockServerEvents.findReferencedChannelIds.mockResolvedValue(['ch-visible', 'ch-hidden', 'ch-foreign']);
    mockChannels.findByIdAndServer.mockImplementation(async (channelId: string) =>
      (channelId === 'ch-foreign' ? null : { _id: channelId, serverId: SID }));
    grant({ __server__: 0xffffffff, 'ch-visible': PERMS.VIEW_CHANNELS, 'ch-hidden': 0 });

    const res = await list();

    expect(res.status).toBe(200);
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(
      SID, USER, 'upcoming', 20, 0, ['ch-visible']);
  });

  it('a channel that does not belong to this server is never visible', async () => {
    mockServerEvents.findReferencedChannelIds.mockResolvedValue(['ch-elsewhere']);
    mockChannels.findByIdAndServer.mockResolvedValue(null);
    await list();
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, USER, 'upcoming', 20, 0, []);
  });

  it('a permission lookup failure hides the channel rather than exposing it', async () => {
    mockServerEvents.findReferencedChannelIds.mockResolvedValue(['ch-1']);
    mockResolvePermissions.mockRejectedValue(new Error('permission store offline'));
    await list();
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, USER, 'upcoming', 20, 0, []);
  });

  it('a non-member is refused before any listing work', async () => {
    mockMembers.findOne.mockResolvedValue(null);
    const res = await list();
    expect(res.status).toBe(403);
    expect(mockServerEvents.findByServer).not.toHaveBeenCalled();
  });

  const badFilters = ['?filter=next-week', '?filter=1', '?filter=upcoming&filter=past'];
  for (const query of badFilters) {
    it(`refuses "${query}"`, async () => {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/filter must be/);
      expect(mockServerEvents.findByServer).not.toHaveBeenCalled();
    });
  }

  const validFilters = ['upcoming', 'past', 'all'] as const;
  for (const filter of validFilters) {
    it(`accepts filter=${filter}`, async () => {
      await list(`?filter=${filter}`);
      expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, USER, filter, 20, 0, []);
    });
  }

  const badPaging = ['?limit=abc', '?limit=-1', '?offset=-1', '?offset=1.5'];
  for (const query of badPaging) {
    it(`refuses paging "${query}" instead of silently clamping it`, async () => {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(mockServerEvents.findByServer).not.toHaveBeenCalled();
    });
  }
});

describe('creating an event', () => {
  const create = (body: Record<string, unknown>) => request(buildApp().app)
    .post(`/api/servers/${SID}/events`).set('Authorization', `Bearer ${tok(USER)}`).send(body);

  const validBody = () => ({ title: 'Toplantı', startsAt: soon(3_600_000) });

  it('a server-wide event needs server management, not channel management', async () => {
    grant({ __server__: PERMS.MANAGE_CHANNELS });
    const denied = await create(validBody());
    expect(denied.status).toBe(403);

    grant({ __server__: PERMS.MANAGE_SERVER });
    const allowed = await create(validBody());
    expect(allowed.status).toBe(201);
  });

  it('a channel-bound event may be created by a channel manager who can see it', async () => {
    grant({ 'ch-1': PERMS.VIEW_CHANNELS | PERMS.MANAGE_CHANNELS });
    const res = await create({ ...validBody(), channelId: 'ch-1' });
    expect(res.status).toBe(201);
  });

  it('a channel manager who cannot see the channel is refused', async () => {
    grant({ 'ch-1': PERMS.MANAGE_CHANNELS });
    const res = await create({ ...validBody(), channelId: 'ch-1' });
    expect(res.status).toBe(403);
    expect(mockServerEvents.create).not.toHaveBeenCalled();
  });

  it('a non-member cannot create anything', async () => {
    mockMembers.findOne.mockResolvedValue(null);
    const res = await create(validBody());
    expect(res.status).toBe(403);
    expect(mockServerEvents.create).not.toHaveBeenCalled();
  });

  it('a cover image must be an http(s) url', async () => {
    const res = await create({ ...validBody(), coverImage: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coverImage must be a valid http\/https URL/);
    expect(mockServerEvents.create).not.toHaveBeenCalled();
  });

  it('an end before the start is refused', async () => {
    const res = await create({
      ...validBody(), startsAt: soon(7_200_000), endsAt: soon(3_600_000),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/endsAt must be after startsAt/);
  });

  it('an end exactly equal to the start is refused', async () => {
    const at = soon(3_600_000);
    const res = await create({ ...validBody(), startsAt: at, endsAt: at });
    expect(res.status).toBe(400);
  });

  it('a channel that does not belong to this server is refused', async () => {
    // Permission is granted first so the refusal can only come from the
    // channel/server ownership check itself.
    grant({ 'ch-elsewhere': 0xffffffff });
    mockChannels.findByIdAndServer.mockResolvedValue(null);
    const res = await create({ ...validBody(), channelId: 'ch-elsewhere' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channelId does not belong to this server/);
    expect(mockServerEvents.create).not.toHaveBeenCalled();
  });

  it('announces a channel event in the channel room and a server event server-wide', async () => {
    const channelApp = buildApp();
    mockServerEvents.create.mockResolvedValue(makeEvent({ channel_id: 'ch-1' }));
    await request(channelApp.app).post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${tok(USER)}`)
      .send({ ...validBody(), channelId: 'ch-1' });
    expect(channelApp.emitted).toEqual([
      { room: 'channel:ch-1', event: 'server:event:created', payload: expect.anything() },
    ]);

    const serverApp = buildApp();
    mockServerEvents.create.mockResolvedValue(makeEvent({ channel_id: null }));
    await request(serverApp.app).post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${tok(USER)}`).send(validBody());
    expect(serverApp.emitted[0]!.room).toBe(`server:${SID}`);
  });
});

describe('patching preserves the temporal invariant across the whole event', () => {
  const patch = (body: Record<string, unknown>, app = buildApp()) => ({
    app,
    send: request(app.app).patch(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${tok(USER)}`).send(body),
  });

  beforeEach(() => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent());
  });

  it('an unknown event is a 404 before any permission work', async () => {
    mockServerEvents.findOne.mockResolvedValue(null);
    const res = await patch({ title: 'yeni' }).send;
    expect(res.status).toBe(404);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('management permission is evaluated against the event\'s current channel', async () => {
    grant({ 'ch-1': 0, __server__: 0xffffffff });
    const res = await patch({ title: 'yeni' }).send;
    expect(res.status).toBe(403);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('moving startsAt past the existing endsAt is refused', async () => {
    // Validating only the submitted field would accept this and leave an event
    // that ends before it begins.
    mockServerEvents.findOne.mockResolvedValue(makeEvent({
      starts_at: soon(3_600_000), ends_at: soon(7_200_000),
    }));
    const res = await patch({ startsAt: soon(10_800_000) }).send;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/endsAt must be after startsAt/);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('moving endsAt before the existing startsAt is refused', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({
      starts_at: soon(7_200_000), ends_at: soon(10_800_000),
    }));
    const res = await patch({ endsAt: soon(3_600_000) }).send;
    expect(res.status).toBe(400);
  });

  it('an unparseable submitted date is refused by the schema layer', async () => {
    const badStart = await patch({ startsAt: 'not-a-date' }).send;
    expect(badStart.status).toBe(400);
    const badEnd = await patch({ endsAt: 'not-a-date' }).send;
    expect(badEnd.status).toBe(400);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('a corrupt STORED date is refused by the handler, not written back', async () => {
    // The patch itself is valid; the invariant is recomputed against the whole
    // event, so an unusable persisted timestamp cannot be carried forward.
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ starts_at: 'garbage' }));
    const res = await patch({ title: 'Yeni başlık' }).send;
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid event date');
    expect(mockServerEvents.update).not.toHaveBeenCalled();

    mockServerEvents.findOne.mockResolvedValue(makeEvent({ ends_at: 'garbage' }));
    const endCorrupt = await patch({ title: 'Yeni başlık' }).send;
    expect(endCorrupt.status).toBe(400);
  });

  it('an event with no end can have its start moved freely', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ ends_at: null }));
    const res = await patch({ startsAt: soon(86_400_000) }).send;
    expect(res.status).toBe(200);
    expect(mockServerEvents.update).toHaveBeenCalledWith(EID, SID,
      expect.objectContaining({ startsAt: expect.any(Date) }));
  });

  it('a submitted end date is normalised to a Date before it is stored', async () => {
    const res = await patch({ endsAt: soon(86_400_000) }).send;
    expect(res.status).toBe(200);
    expect(mockServerEvents.update).toHaveBeenCalledWith(EID, SID,
      expect.objectContaining({ endsAt: expect.any(Date) }));
  });

  it('moving the event to a channel the caller cannot manage is refused', async () => {
    grant({ 'ch-1': 0xffffffff, 'ch-2': PERMS.VIEW_CHANNELS });
    mockChannels.findByIdAndServer.mockResolvedValue({ _id: 'ch-2', serverId: SID });
    const res = await patch({ channelId: 'ch-2' }).send;
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/target channel/);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('moving the event to a channel of another server is refused', async () => {
    mockChannels.findByIdAndServer.mockResolvedValue(null);
    const res = await patch({ channelId: 'ch-elsewhere' }).send;
    expect(res.status).toBe(400);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('a successful move announces a removal in the old room and an update in the new one', async () => {
    grant({ 'ch-1': 0xffffffff, 'ch-2': 0xffffffff });
    mockChannels.findByIdAndServer.mockResolvedValue({ _id: 'ch-2', serverId: SID });
    mockServerEvents.update.mockResolvedValue(makeEvent({ channel_id: 'ch-2' }));

    const { app, send } = patch({ channelId: 'ch-2' });
    const res = await send;

    expect(res.status).toBe(200);
    expect(app.emitted).toEqual([
      { room: 'channel:ch-1', event: 'server:event:deleted', payload: { eventId: EID } },
      { room: 'channel:ch-2', event: 'server:event:updated', payload: expect.anything() },
    ]);
  });

  it('an in-place update announces only the update', async () => {
    mockServerEvents.update.mockResolvedValue(makeEvent({ channel_id: 'ch-1' }));
    const { app, send } = patch({ title: 'Yeni başlık' });
    await send;
    expect(app.emitted.map(e => e.event)).toEqual(['server:event:updated']);
  });

  it('a patch that changes nothing is reported as such', async () => {
    mockServerEvents.update.mockResolvedValue(null);
    const res = await patch({ title: 'Yeni başlık' }).send;
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No fields to update');
  });
});

describe('reading one event', () => {
  const detail = () => request(buildApp().app)
    .get(`/api/servers/${SID}/events/${EID}`).set('Authorization', `Bearer ${tok(USER)}`);

  it('a non-member is refused', async () => {
    mockMembers.findOne.mockResolvedValue(null);
    const res = await detail();
    expect(res.status).toBe(403);
    expect(mockServerEvents.findOne).not.toHaveBeenCalled();
  });

  it('an unknown event is a 404', async () => {
    mockServerEvents.findOne.mockResolvedValue(null);
    expect((await detail()).status).toBe(404);
  });

  it('an event bound to a channel the caller cannot see is not disclosed', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ channel_id: 'ch-hidden' }));
    mockChannels.findByIdAndServer.mockResolvedValue({ _id: 'ch-hidden', serverId: SID });
    grant({ 'ch-hidden': 0 });
    const res = await detail();
    expect(res.status).toBe(404);
  });
});
