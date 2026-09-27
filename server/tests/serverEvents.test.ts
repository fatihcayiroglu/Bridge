// server/tests/serverEvents.test.ts
// Sprint 98 — serverEvents route tam test paketi
// Kapsam: GET list, POST create, GET detail, PATCH update, DELETE, POST rsvp, DELETE rsvp

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

// ── Mock: ServerEventRepository ──────────────────────────────────────────────
// Brief'teki mock stratejisi: doğrudan ServerEventRepository'yi mock'la
const mockServerEvents = {
  findByServer:   jest.fn(),
  findReferencedChannelIds: jest.fn(),
  findOne:        jest.fn(),
  exists:         jest.fn(),
  findRsvpList:   jest.fn(),
  findMyRsvp:     jest.fn(),
  upsertRsvp:     jest.fn(),
  deleteRsvp:     jest.fn(),
  countAttendees: jest.fn(),
  create:         jest.fn(),
  update:         jest.fn(),
  delete:         jest.fn(),
};

jest.mock('../db/repositories/ServerEventRepository', () => ({
  ServerEvents: mockServerEvents,
}));

// ── Mock: Members repository ──────────────────────────────────────────────────
const mockMembers = {
  findOne: jest.fn(),
};
const mockChannels = {
  findByIdAndServer: jest.fn(),
};

const mockUsers = {
  findById: jest.fn(async (id: string) => ({ _id: id, id, username: `user-${id}`, tokenVersion: 0 })),
};

jest.mock('../db/repositories', () => ({
  Members: mockMembers,
  Channels: mockChannels,
  Users: mockUsers,
}));

const mockResolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => {
  const PERMS = {
    VIEW_CHANNELS: 1 << 0,
    MANAGE_CHANNELS: 1 << 1,
    MANAGE_SERVER: 1 << 3,
    ADMINISTRATOR: 1 << 30,
  };
  return {
    PERMS,
    resolvePermissions: mockResolvePermissions,
    hasPermission: (perms: number, flag: number) => (perms & PERMS.ADMINISTRATOR) !== 0 || (perms & flag) !== 0,
  };
});

// ── Mock: rateLimit middleware (pass-through) ─────────────────────────────────
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    api:   (req: unknown, res: unknown, next: () => void) => next(),
    // limits.write KANONİK olarak bir FABRİKADIR.
    write: () => (req: unknown, res: unknown, next: () => void) => next(),
  },
}));

// ── Mock: security ────────────────────────────────────────────────────────────
jest.mock('../lib/security', () => ({
  isSafeUrl: (url: string) => url.startsWith('https://') || url.startsWith('http://'),
}));

// ── Mock: logger ──────────────────────────────────────────────────────────────
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import request    from 'supertest';
import express    from 'express';
import jwt        from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import serverEventsRouter from '../routes/serverEvents';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tok(userId: string): string {
  return jwt.sign({ id: userId, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  const mockIo = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
  app.set('io', mockIo);
  app.use(express.json());
  app.use('/api/servers', serverEventsRouter);
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return { app, mockIo };
}

function makeEvent(overrides = {}) {
  return {
    id:          uuidv4(),
    server_id:   'srv-1',
    creator_id:  'usr-1',
    title:       'Test Etkinliği',
    description: 'Açıklama',
    location:    'Online',
    channel_id:  'ch-1',
    starts_at:   new Date(Date.now() + 3600_000).toISOString(),
    ends_at:     new Date(Date.now() + 7200_000).toISOString(),
    cover_image: null,
    status:      'scheduled',
    created_at:  new Date().toISOString(),
    ...overrides,
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

const SID     = 'srv-1';
const EID     = 'evt-1';
const OWNER   = uuidv4();
const MEMBER  = uuidv4();
const STRANGER = uuidv4();

const ownerTok   = tok(OWNER);
const memberTok  = tok(MEMBER);
const strangerTok = tok(STRANGER);

// Üyelik ayrı, izinler canonical bitmask resolver üzerinden mock'lanır.
function asMember(userId: string) {
  // Sorgu nesnesi HEM `userId` HEM `serverId` tasiyabilir; tip yalnizca
  // `userId` diyordu ve `first.serverId` okunamiyordu.
  type MemberQuery = { userId?: string; serverId?: string };
  mockMembers.findOne.mockImplementation(async (first: string | MemberQuery, second?: string) => {
    const uid = typeof first === 'string' ? first : first.userId;
    const sid = typeof first === 'string' ? second : first.serverId;
    if (uid === STRANGER || sid !== SID) return null;
    return { userId: uid, serverId: SID, roles: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers.findById.mockImplementation(async (id: string) => ({ _id: id, id, username: `user-${id}`, tokenVersion: 0 }));
  mockServerEvents.findReferencedChannelIds.mockResolvedValue([]);
  mockChannels.findByIdAndServer.mockImplementation(async (channelId: string, serverId: string) =>
    serverId === SID ? { _id: channelId, serverId: SID, name: 'event-channel' } : null);
  mockResolvePermissions.mockImplementation(async (userId: string, _serverId: string, channelId?: string | null) => {
    if (userId === OWNER) return (1 << 0) | (1 << 1) | (1 << 3);
    return channelId ? (1 << 0) : (1 << 0);
  });
  asMember(OWNER);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /servers/:sid/events — Etkinlik listesi
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /servers/:sid/events', () => {

  it('403 — üye olmayan kullanıcı', async () => {
    mockMembers.findOne.mockResolvedValue(null);
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${strangerTok}`);
    expect(res.status).toBe(403);
  });

  it('200 — upcoming filtresi (varsayılan)', async () => {
    const events = [makeEvent()];
    mockServerEvents.findByServer.mockResolvedValue({ events, total: 1 });
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, MEMBER, 'upcoming', 20, 0, []);
  });

  it('400 — bilinmeyen filter değeri sessizce upcoming olarak yorumlanmaz', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events?filter=typo`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(400);
    expect(mockServerEvents.findByServer).not.toHaveBeenCalled();
  });

  it('200 — past filtresi', async () => {
    mockServerEvents.findByServer.mockResolvedValue({ events: [], total: 0 });
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events?filter=past`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, MEMBER, 'past', 20, 0, []);
  });

  it('200 — all filtresi', async () => {
    mockServerEvents.findByServer.mockResolvedValue({ events: [], total: 0 });
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events?filter=all`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, MEMBER, 'all', 20, 0, []);
  });

  it('200 — limit/offset sayfalama çalışır', async () => {
    mockServerEvents.findByServer.mockResolvedValue({ events: [], total: 50 });
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events?limit=10&offset=20`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(20);
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, MEMBER, 'upcoming', 10, 20, []);
  });


  it.each([
    ['negative limit', 'limit=-1'],
    ['fractional limit', 'limit=1.5'],
    ['unsafe limit', 'limit=9007199254740992'],
    ['negative offset', 'offset=-1'],
    ['fractional offset', 'offset=1.5'],
    ['unsafe offset', 'offset=9007199254740992'],
  ])('400 — %s PostgreSQL pagination katmanına ulaşmaz', async (_name, query) => {
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events?${query}`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(400);
    expect(mockServerEvents.findByServer).not.toHaveBeenCalled();
  });

  it('200 — aşırı büyük pozitif limit uyumluluk için 100 ile clamp edilir', async () => {
    mockServerEvents.findByServer.mockResolvedValue({ events: [], total: 0 });
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events?limit=1000&offset=0`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(SID, MEMBER, 'upcoming', 100, 0, []);
  });

  it('private channel event allowlist is resolved before repository pagination', async () => {
    mockServerEvents.findReferencedChannelIds.mockResolvedValue(['visible-ch', 'private-ch']);
    mockResolvePermissions.mockImplementation(async (_userId: string, _serverId: string, channelId?: string | null) =>
      channelId === 'visible-ch' ? (1 << 0) : 0);
    mockServerEvents.findByServer.mockResolvedValue({ events: [], total: 0 });
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(mockServerEvents.findByServer).toHaveBeenCalledWith(
      SID, MEMBER, 'upcoming', 20, 0, ['visible-ch'],
    );
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// POST /servers/:sid/events — Etkinlik oluştur
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /servers/:sid/events', () => {

  const validBody = {
    title:    'Yeni Etkinlik',
    startsAt: new Date(Date.now() + 3600_000).toISOString(),
    endsAt:   new Date(Date.now() + 7200_000).toISOString(),
  };

  it('403 — canonical event management yetkisi olmayan üye', async () => {
    mockResolvePermissions.mockResolvedValue(1 << 0);
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it('400 — startsAt geçersiz format', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({ ...validBody, startsAt: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  it('400 — endsAt < startsAt', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({
        title:    'Test',
        startsAt: new Date(Date.now() + 7200_000).toISOString(),
        endsAt:   new Date(Date.now() + 3600_000).toISOString(),
      });
    expect(res.status).toBe(400);
  });

  it('400 — coverImage güvensiz URL', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({ ...validBody, coverImage: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });

  it('201 — başarılı oluşturma, io emit kontrolü', async () => {
    const created = makeEvent({ id: 'new-evt', title: 'Yeni Etkinlik', channel_id: null });
    mockServerEvents.create.mockResolvedValue(created);
    const { app, mockIo } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.event.title).toBe('Yeni Etkinlik');
    expect(mockIo.to).toHaveBeenCalledWith(`server:${SID}`);
    expect(mockIo.emit).toHaveBeenCalledWith('server:event:created', { event: created });
  });

  it('channel-bound event is emitted only to its channel room', async () => {
    const created = makeEvent({ id: 'private-evt', channel_id: 'private-ch' });
    mockServerEvents.create.mockResolvedValue(created);
    mockResolvePermissions.mockResolvedValue((1 << 0) | (1 << 1));
    const { app, mockIo } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send({ ...validBody, channelId: 'private-ch' });
    expect(res.status).toBe(201);
    expect(mockIo.to).toHaveBeenCalledWith('channel:private-ch');
    expect(mockIo.to).not.toHaveBeenCalledWith(`server:${SID}`);
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// GET /servers/:sid/events/:eid — Tek etkinlik detayı
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /servers/:sid/events/:eid', () => {

  it('404 — etkinlik yok', async () => {
    mockServerEvents.findOne.mockResolvedValue(null);
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(404);
  });

  it('404 — private channel event is hidden after VIEW_CHANNELS revoke', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: 'private-ch' }));
    mockResolvePermissions.mockResolvedValue(0);
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(404);
    expect(mockServerEvents.findRsvpList).not.toHaveBeenCalled();
  });

  it('200 — rsvps + myRsvp birlikte dönüyor', async () => {
    const event = makeEvent({ id: EID });
    const rsvps = [{ user_id: MEMBER, status: 'going' }];
    mockServerEvents.findOne.mockResolvedValue(event);
    mockServerEvents.findRsvpList.mockResolvedValue(rsvps);
    mockServerEvents.findMyRsvp.mockResolvedValue('going');
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(res.body.event).toBeDefined();
    expect(res.body.rsvps).toHaveLength(1);
    expect(res.body.myRsvp).toBe('going');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /servers/:sid/events/:eid — Etkinlik güncelle
// ══════════════════════════════════════════════════════════════════════════════

describe('PATCH /servers/:sid/events/:eid', () => {

  it('404 — etkinlik yok', async () => {
    mockServerEvents.findOne.mockResolvedValue(null);
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({ title: 'Yeni Başlık' });
    expect(res.status).toBe(404);
  });

  it('400 — güncelleme alanı yok (boş body)', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null }));
    mockServerEvents.update.mockResolvedValue(null);
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('400 — patch startsAt mevcut endsAt sonrasına taşınamaz', async () => {
    const starts = new Date(Date.now() + 10_000);
    const ends = new Date(starts.getTime() + 10_000);
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null, starts_at: starts, ends_at: ends }));
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({ startsAt: new Date(ends.getTime() + 1000).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/endsAt must be after startsAt/);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('400 — patch endsAt mevcut startsAt öncesine taşınamaz', async () => {
    const starts = new Date(Date.now() + 20_000);
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null, starts_at: starts, ends_at: null }));
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({ endsAt: new Date(starts.getTime() - 1000).toISOString() });
    expect(res.status).toBe(400);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('400 — boş channelId PostgreSQL FK katmanına ulaşmaz', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null }));
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({ channelId: '' });
    expect(res.status).toBe(400);
    expect(mockServerEvents.update).not.toHaveBeenCalled();
  });

  it('200 — kısmi güncelleme çalışır', async () => {
    const updated = makeEvent({ id: EID, title: 'Güncellenmiş', channel_id: null });
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null }));
    mockServerEvents.update.mockResolvedValue(updated);
    const { app, mockIo } = buildApp();
    const res = await request(app)
      .patch(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .send({ title: 'Güncellenmiş' });
    expect(res.status).toBe(200);
    expect(res.body.event.title).toBe('Güncellenmiş');
    expect(mockIo.emit).toHaveBeenCalledWith('server:event:updated', { event: updated });
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /servers/:sid/events/:eid — Etkinlik sil
// ══════════════════════════════════════════════════════════════════════════════

describe('DELETE /servers/:sid/events/:eid', () => {

  it('403 — canonical event management yetkisi yok', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null }));
    mockResolvePermissions.mockResolvedValue(1 << 0);
    const { app } = buildApp();
    const res = await request(app)
      .delete(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(403);
  });

  it('200 — başarılı silme + io emit kontrolü', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null }));
    mockServerEvents.delete.mockResolvedValue(undefined);
    const { app, mockIo } = buildApp();
    const res = await request(app)
      .delete(`/api/servers/${SID}/events/${EID}`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockIo.emit).toHaveBeenCalledWith('server:event:deleted', { eventId: EID });
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// POST /servers/:sid/events/:eid/rsvp — RSVP ekle
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /servers/:sid/events/:eid/rsvp', () => {

  it('403 — üye değil', async () => {
    mockMembers.findOne.mockResolvedValue(null);
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events/${EID}/rsvp`)
      .set('Authorization', `Bearer ${strangerTok}`)
      .send({ status: 'going' });
    expect(res.status).toBe(403);
  });

  it('404 — etkinlik yok', async () => {
    mockServerEvents.findOne.mockResolvedValue(null);
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events/${EID}/rsvp`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send({ status: 'going' });
    expect(res.status).toBe(404);
  });

  it('400 — geçersiz status (zod validation)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events/${EID}/rsvp`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send({ status: 'maybe' }); // geçersiz enum
    expect(res.status).toBe(400);
  });

  it('404 — RSVP cannot target a channel-bound event after visibility revoke', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: 'private-ch' }));
    mockResolvePermissions.mockResolvedValue(0);
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events/${EID}/rsvp`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send({ status: 'going' });
    expect(res.status).toBe(404);
    expect(mockServerEvents.upsertRsvp).not.toHaveBeenCalled();
  });

  it('200 — upsert + countAttendees + io emit', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null }));
    mockServerEvents.upsertRsvp.mockResolvedValue(undefined);
    mockServerEvents.countAttendees.mockResolvedValue(5);
    const { app, mockIo } = buildApp();
    const res = await request(app)
      .post(`/api/servers/${SID}/events/${EID}/rsvp`)
      .set('Authorization', `Bearer ${memberTok}`)
      .send({ status: 'going' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('going');
    expect(mockServerEvents.upsertRsvp).toHaveBeenCalledWith(EID, MEMBER, 'going');
    expect(mockServerEvents.countAttendees).toHaveBeenCalledWith(EID);
    expect(mockIo.emit).toHaveBeenCalledWith('server:event:rsvp', {
      eventId: EID, userId: MEMBER, status: 'going', count: 5,
    });
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /servers/:sid/events/:eid/rsvp — RSVP iptal
// ══════════════════════════════════════════════════════════════════════════════

describe('DELETE /servers/:sid/events/:eid/rsvp', () => {

  it('200 — deleteRsvp + io emit (status: null)', async () => {
    mockServerEvents.findOne.mockResolvedValue(makeEvent({ id: EID, channel_id: null }));
    mockServerEvents.deleteRsvp.mockResolvedValue(undefined);
    const { app, mockIo } = buildApp();
    const res = await request(app)
      .delete(`/api/servers/${SID}/events/${EID}/rsvp`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockServerEvents.deleteRsvp).toHaveBeenCalledWith(EID, MEMBER);
    expect(mockIo.emit).toHaveBeenCalledWith('server:event:rsvp', {
      eventId: EID, userId: MEMBER, status: null,
    });
  });

});
