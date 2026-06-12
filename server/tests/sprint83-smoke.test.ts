// server/tests/sprint83-smoke.test.ts
// Sprint 83 — Temel smoke testleri
// Kapsam:
//   1. bot-marketplace route (in-memory Map yerine DB mock)
//   2. stage-video-grid handler
//   3. draw-together aktivitesi

'use strict';
process.env.NODE_ENV = 'test';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. BOT MARKETPLACE — Route smoke testleri
// ═══════════════════════════════════════════════════════════════════════════════

// Mock pg pool (route içindeki getPool() yerine)
const _mpRows: Record<string, unknown>[] = [
  {
    id: 'bridge-music', name: 'Bridge Music', author: 'Bridge Team',
    authorVerified: true, avatar: '🎵', category: 'music',
    tags: ['müzik'], description: 'Müzik botu', longDescription: '',
    verified: true, featured: true, installs: 12840, rating: '4.8',
    ratingCount: 3241, commands: ['/play'], permissions: [],
    changelog: '', supportUrl: '#', sourceUrl: '#',
    approved: true, submittedBy: null, createdAt: 1700000000000, updatedAt: 1700000000000,
  },
  {
    id: 'bridge-guard', name: 'Bridge Guard', author: 'Bridge Team',
    authorVerified: true, avatar: '🛡️', category: 'moderation',
    tags: ['güvenlik'], description: 'Moderasyon botu', longDescription: '',
    verified: true, featured: false, installs: 38700, rating: '4.9',
    ratingCount: 7821, commands: ['/ban'], permissions: [],
    changelog: '', supportUrl: '#', sourceUrl: '#',
    approved: true, submittedBy: null, createdAt: 1700000000000, updatedAt: 1700000000000,
  },
];

// ── Mock pool ─────────────────────────────────────────────────────────────────
jest.mock('../db/postgres/pool', () => ({
  getPool: () => ({
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('SELECT COUNT')) {
        const cat = params[0] as string | undefined;
        const rows = cat ? _mpRows.filter(r => r.category === cat) : _mpRows;
        return { rows: [{ total: rows.filter(r => r.approved).length }], rowCount: 1 };
      }

      if (s.startsWith('SELECT * FROM BOT_MARKETPLACE WHERE ID')) {
        const id = params[0] as string;
        const row = _mpRows.find(r => r.id === id && r.approved);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      if (s.startsWith('SELECT * FROM BOT_MARKETPLACE')) {
        const filtered = _mpRows.filter(r => r.approved);
        return { rows: filtered, rowCount: filtered.length };
      }

      if (s.startsWith('INSERT INTO BOT_MARKETPLACE')) {
        return { rows: [], rowCount: 1 };
      }

      if (s.startsWith('UPDATE BOT_MARKETPLACE')) {
        return { rows: [], rowCount: 1 };
      }

      if (s.startsWith('DELETE FROM BOT_MARKETPLACE')) {
        const id = params[0] as string;
        const exists = _mpRows.some(r => r.id === id);
        return { rows: [], rowCount: exists ? 1 : 0 };
      }

      return { rows: [], rowCount: 0 };
    }),
  }),
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { _id: 'u1', username: 'testuser', isAdmin: true };
    next();
  },
  castAuthed: (req: Record<string, unknown>) => req,
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: {
    general: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    bots:    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));

import request from 'supertest';
import express from 'express';
import botMarketplaceRouter from '../routes/bot-marketplace';

function buildMarketplaceApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bots/marketplace', botMarketplaceRouter);
  return app;
}

describe('bot-marketplace route', () => {
  const app = buildMarketplaceApp();

  it('GET /categories — kategori listesini döndürür', async () => {
    const res = await request(app).get('/api/bots/marketplace/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('id');
    expect(res.body[0]).toHaveProperty('icon');
    expect(res.body[0]).toHaveProperty('label');
  });

  it('GET / tüm approved botları döndürür', async () => {
    const res = await request(app).get('/api/bots/marketplace');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bots');
    expect(Array.isArray(res.body.bots)).toBe(true);
    expect(res.body).toHaveProperty('total');
  });

  it('GET / ?category filtresi çalışır', async () => {
    const res = await request(app).get('/api/bots/marketplace?category=music');
    expect(res.status).toBe(200);
  });

  it('GET /:botId bilinen botu döndürür', async () => {
    const res = await request(app).get('/api/bots/marketplace/bridge-music');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('bridge-music');
  });

  it('GET /:botId bilinmeyen bot için 404', async () => {
    const res = await request(app).get('/api/bots/marketplace/unknown-bot-xyz');
    expect(res.status).toBe(404);
  });

  it('POST / zorunlu alanlar eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/bots/marketplace')
      .send({ name: 'Test Bot' }); // id, description, category eksik
    expect(res.status).toBe(400);
  });

  it('POST / geçersiz id formatı için 400 döner', async () => {
    const res = await request(app)
      .post('/api/bots/marketplace')
      .send({ id: 'INVALID ID!', name: 'Bot', description: 'Desc', category: 'utility' });
    expect(res.status).toBe(400);
  });

  it('DELETE /:botId — admin botu silebilir (204)', async () => {
    const res = await request(app).delete('/api/bots/marketplace/bridge-music');
    expect(res.status).toBe(204);
  });

  it('DELETE /:botId bilinmeyen bot için 404', async () => {
    const res = await request(app).delete('/api/bots/marketplace/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. STAGE VIDEO GRID — Handler smoke testleri
// ═══════════════════════════════════════════════════════════════════════════════

import { registerVideoGridHandlers, videoGridRooms } from '../socket/handlers/stage-video-grid';

// sfuPeers mock
jest.mock('../socket/handlers/mediasoup/rooms', () => ({
  sfuPeers: new Map(),
  sfuRooms: new Map(),
}));

function makeGridSocket(id: string) {
  const handlers: Record<string, ((...a: unknown[]) => void)> = {};
  const emitted: { ev: string; data: unknown }[] = [];
  const rooms = new Set<string>();
  return {
    id, rooms,
    on:   (ev: string, fn: (...a: unknown[]) => void) => { handlers[ev] = fn; },
    emit: (ev: string, data: unknown) => { emitted.push({ ev, data }); },
    join: (room: string) => rooms.add(room),
    to:   (_r: string) => ({ emit: jest.fn() }),
    _handlers: handlers,
    _emitted:  emitted,
    async _trigger(ev: string, data?: unknown) {
      if (handlers[ev]) await handlers[ev](data as never);
    },
  };
}

function makeGridIo() {
  const emitted: { ev: string; data: unknown; room: string }[] = [];
  return {
    _emitted: emitted,
    to: (room: string) => ({
      emit: (ev: string, data: unknown) => emitted.push({ ev, data, room }),
    }),
  };
}

describe('stage-video-grid handler', () => {
  beforeEach(() => videoGridRooms.clear());
  afterEach(()  => videoGridRooms.clear());

  it('stage:video-join — oda oluşturulur ve katılımcı eklenir', async () => {
    const socket = makeGridSocket('s-vg1');
    const io     = makeGridIo();
    const user   = { _id: 'u1', displayName: 'Alice', avatarColor: '#ff0000' };

    registerVideoGridHandlers(socket as never, io as never, user);
    await socket._trigger('stage:video-join', { channelId: 'ch-1' });

    expect(videoGridRooms.has('ch-1')).toBe(true);
    const room = videoGridRooms.get('ch-1')!;
    expect(room.peers.has('s-vg1')).toBe(true);
    expect(socket.rooms.has('video-grid:ch-1')).toBe(true);

    const stateEvent = socket._emitted.find(e => e.ev === 'stage:video-state');
    expect(stateEvent).toBeDefined();
  });

  it('stage:video-join — yeni katılana mevcut state gönderilir', async () => {
    const user1 = { _id: 'u1', displayName: 'Alice', avatarColor: '#f00' };
    const user2 = { _id: 'u2', displayName: 'Bob',   avatarColor: '#00f' };

    const s1 = makeGridSocket('s-vg-a');
    const s2 = makeGridSocket('s-vg-b');
    const io  = makeGridIo();

    registerVideoGridHandlers(s1 as never, io as never, user1);
    await s1._trigger('stage:video-join', { channelId: 'ch-multi' });

    registerVideoGridHandlers(s2 as never, io as never, user2);
    await s2._trigger('stage:video-join', { channelId: 'ch-multi' });

    // s2'ye gönderilen state'de s1 zaten var olmalı
    const stateEvent = s2._emitted.find(e => e.ev === 'stage:video-state');
    expect(stateEvent).toBeDefined();
    const peers = (stateEvent!.data as { peers: unknown[] }).peers;
    expect(peers.length).toBeGreaterThanOrEqual(1);
  });

  it('stage:video-leave — peer odadan ayrılır', async () => {
    const socket = makeGridSocket('s-leave');
    const io     = makeGridIo();
    const user   = { _id: 'u3', displayName: 'Carol', avatarColor: '#0f0' };

    registerVideoGridHandlers(socket as never, io as never, user);
    await socket._trigger('stage:video-join',  { channelId: 'ch-leave' });
    expect(videoGridRooms.get('ch-leave')?.peers.has('s-leave')).toBe(true);

    await socket._trigger('stage:video-leave', { channelId: 'ch-leave' });
    expect(videoGridRooms.has('ch-leave')).toBe(false); // oda boştu, silindi
  });

  it('disconnect — tüm grid odalarından temizlenir', async () => {
    const socket = makeGridSocket('s-dc');
    const io     = makeGridIo();
    const user   = { _id: 'u4', displayName: 'Dave', avatarColor: '#abc' };

    registerVideoGridHandlers(socket as never, io as never, user);
    await socket._trigger('stage:video-join', { channelId: 'ch-dc1' });
    await socket._trigger('stage:video-join', { channelId: 'ch-dc2' });
    expect(videoGridRooms.size).toBe(2);

    await socket._trigger('disconnect');
    expect(videoGridRooms.has('ch-dc1')).toBe(false);
    expect(videoGridRooms.has('ch-dc2')).toBe(false);
  });

  it('stage:video-layout — sadece host değiştirebilir', async () => {
    const host    = makeGridSocket('s-host');
    const nonHost = makeGridSocket('s-nonhost');
    const io      = makeGridIo();

    registerVideoGridHandlers(host    as never, io as never, { _id: 'uHost', displayName: 'Host', avatarColor: '#000' });
    registerVideoGridHandlers(nonHost as never, io as never, { _id: 'uGuest', displayName: 'Guest', avatarColor: '#fff' });

    await host._trigger('stage:video-join',    { channelId: 'ch-layout' });
    await nonHost._trigger('stage:video-join', { channelId: 'ch-layout' });

    // non-host layout değiştirmeye çalışıyor
    await nonHost._trigger('stage:video-layout', { channelId: 'ch-layout', layout: 'spotlight' });
    const errEvent = nonHost._emitted.find(e => e.ev === 'stage:video-error');
    expect(errEvent).toBeDefined();

    // host değiştirebilir
    await host._trigger('stage:video-layout', { channelId: 'ch-layout', layout: 'spotlight', spotlightId: 's-host' });
    const layoutEvent = io._emitted.find(e => e.ev === 'stage:video-layout-changed');
    expect(layoutEvent).toBeDefined();
    expect((layoutEvent!.data as { layout: string }).layout).toBe('spotlight');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DRAW TOGETHER — Handler smoke testleri
// ═══════════════════════════════════════════════════════════════════════════════

import { registerDrawTogetherHandlers, drawSessions } from '../socket/handlers/activities/draw-together';

function makeDrawSocket(id: string) {
  const handlers: Record<string, ((...a: unknown[]) => void)> = {};
  const emitted: { ev: string; data: unknown }[] = [];
  const rooms = new Set<string>();
  return {
    id, rooms,
    on:   (ev: string, fn: (...a: unknown[]) => void) => { handlers[ev] = fn; },
    emit: (ev: string, data?: unknown) => { emitted.push({ ev, data }); },
    join: (room: string) => rooms.add(room),
    to:   (_r: string) => ({ emit: jest.fn() }),
    _handlers: handlers,
    _emitted:  emitted,
    async _trigger(ev: string, data?: unknown) {
      if (handlers[ev]) await handlers[ev](data as never);
    },
  };
}

function makeDrawIo() {
  const emitted: { ev: string; data: unknown; room: string }[] = [];
  return {
    _emitted: emitted,
    to: (room: string) => ({
      emit: (ev: string, data: unknown) => emitted.push({ ev, data, room }),
    }),
  };
}

const STROKE_VALID = {
  id: 'stroke-1', tool: 'pen', color: '#ff0000', size: 5, opacity: 1,
  points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
};

describe('draw-together handler', () => {
  beforeEach(() => drawSessions.clear());
  afterEach(()  => drawSessions.clear());

  it('draw:join — session oluşturulur ve state gönderilir', async () => {
    const socket = makeDrawSocket('s-dt1');
    const io     = makeDrawIo();
    const user   = { _id: 'u1', displayName: 'Alice', avatarColor: '#f00' };

    registerDrawTogetherHandlers(socket as never, io as never, user);
    await socket._trigger('draw:join', { channelId: 'ch-dt', sessionId: 'sess-1' });

    expect(drawSessions.has('ch-dt')).toBe(true);
    expect(socket.rooms.has('draw:ch-dt')).toBe(true);

    const stateEv = socket._emitted.find(e => e.ev === 'draw:state');
    expect(stateEv).toBeDefined();
    expect((stateEv!.data as { strokes: unknown[] }).strokes).toEqual([]);
  });

  it('draw:stroke — geçerli stroke diğer katılımcılara iletilir', async () => {
    const socket = makeDrawSocket('s-dt2');
    const io     = makeDrawIo();
    const user   = { _id: 'u2', displayName: 'Bob', avatarColor: '#00f' };

    registerDrawTogetherHandlers(socket as never, io as never, user);
    await socket._trigger('draw:join', { channelId: 'ch-stroke', sessionId: 'sess-2' });

    const toMock = jest.fn(() => ({ emit: jest.fn() }));
    (socket as unknown as { to: jest.Mock }).to = toMock;

    await socket._trigger('draw:stroke', { channelId: 'ch-stroke', ...STROKE_VALID });
    // session'da activeStrokes güncellendi
    expect(drawSessions.get('ch-stroke')!.activeStrokes.has('s-dt2')).toBe(true);
  });

  it('draw:stroke — geçersiz tool için error emit edilir', async () => {
    const socket = makeDrawSocket('s-dt3');
    const io     = makeDrawIo();
    const user   = { _id: 'u3', displayName: 'Carol', avatarColor: '#0f0' };

    registerDrawTogetherHandlers(socket as never, io as never, user);
    await socket._trigger('draw:join', { channelId: 'ch-badtool', sessionId: 'sess-3' });

    await socket._trigger('draw:stroke', {
      channelId: 'ch-badtool',
      id: 'bad-1', tool: 'spray', color: '#fff', size: 5, opacity: 1,
      points: [{ x: 0, y: 0 }],
    });

    const err = socket._emitted.find(e => e.ev === 'draw:error');
    expect(err).toBeDefined();
  });

  it('draw:stroke-end — stroke buffer\'a eklenir', async () => {
    const socket = makeDrawSocket('s-dt4');
    const io     = makeDrawIo();
    const user   = { _id: 'u4', displayName: 'Dave', avatarColor: '#abc' };

    registerDrawTogetherHandlers(socket as never, io as never, user);
    await socket._trigger('draw:join', { channelId: 'ch-end', sessionId: 'sess-4' });
    await socket._trigger('draw:stroke', { channelId: 'ch-end', ...STROKE_VALID });
    await socket._trigger('draw:stroke-end', { channelId: 'ch-end', strokeId: 'stroke-1' });

    const session = drawSessions.get('ch-end')!;
    expect(session.strokes.length).toBe(1);
    expect(session.strokes[0].complete).toBe(true);
    expect(session.activeStrokes.has('s-dt4')).toBe(false);
  });

  it('draw:undo — kullanıcının son stroke\'u kaldırılır', async () => {
    const socket = makeDrawSocket('s-dt5');
    const io     = makeDrawIo();
    const user   = { _id: 'u5', displayName: 'Eve', avatarColor: '#eee' };

    registerDrawTogetherHandlers(socket as never, io as never, user);
    await socket._trigger('draw:join', { channelId: 'ch-undo', sessionId: 'sess-5' });
    await socket._trigger('draw:stroke',     { channelId: 'ch-undo', ...STROKE_VALID });
    await socket._trigger('draw:stroke-end', { channelId: 'ch-undo', strokeId: 'stroke-1' });

    expect(drawSessions.get('ch-undo')!.strokes.length).toBe(1);

    await socket._trigger('draw:undo', { channelId: 'ch-undo' });
    expect(drawSessions.get('ch-undo')!.strokes.length).toBe(0);

    const undoEv = io._emitted.find(e => e.ev === 'draw:undo');
    expect(undoEv).toBeDefined();
    expect((undoEv!.data as { strokeId: string }).strokeId).toBe('stroke-1');
  });

  it('draw:clear — sadece host temizleyebilir', async () => {
    const host    = makeDrawSocket('s-host-dt');
    const nonHost = makeDrawSocket('s-guest-dt');
    const io      = makeDrawIo();

    registerDrawTogetherHandlers(host    as never, io as never, { _id: 'uH', displayName: 'Host',  avatarColor: '#000' });
    registerDrawTogetherHandlers(nonHost as never, io as never, { _id: 'uG', displayName: 'Guest', avatarColor: '#fff' });

    await host._trigger('draw:join',    { channelId: 'ch-clear', sessionId: 'sess-c' });
    await nonHost._trigger('draw:join', { channelId: 'ch-clear', sessionId: 'sess-c' });

    // Stroke ekle
    await host._trigger('draw:stroke',     { channelId: 'ch-clear', ...STROKE_VALID });
    await host._trigger('draw:stroke-end', { channelId: 'ch-clear', strokeId: 'stroke-1' });
    expect(drawSessions.get('ch-clear')!.strokes.length).toBe(1);

    // non-host temizlemeye çalışıyor
    await nonHost._trigger('draw:clear', { channelId: 'ch-clear' });
    const errEv = nonHost._emitted.find(e => e.ev === 'draw:error');
    expect(errEv).toBeDefined();

    // host temizliyor
    await host._trigger('draw:clear', { channelId: 'ch-clear' });
    expect(drawSessions.get('ch-clear')!.strokes.length).toBe(0);

    const clearEv = io._emitted.find(e => e.ev === 'draw:clear');
    expect(clearEv).toBeDefined();
  });

  it('draw:cursor — throttle çalışır (aynı anda iki event → sadece biri geçer)', async () => {
    const socket = makeDrawSocket('s-cursor');
    const io     = makeDrawIo();
    const user   = { _id: 'u6', displayName: 'Frank', avatarColor: '#123' };

    registerDrawTogetherHandlers(socket as never, io as never, user);
    await socket._trigger('draw:join', { channelId: 'ch-cur', sessionId: 'sess-cur' });

    const toEmits: unknown[] = [];
    (socket as unknown as { to: (...a: unknown[]) => { emit: (...a: unknown[]) => void } }).to =
      () => ({ emit: (...a: unknown[]) => toEmits.push(a) });

    // Hızlı 3 cursor event — throttle nedeniyle sadece ilki geçmeli
    await socket._trigger('draw:cursor', { channelId: 'ch-cur', x: 10, y: 10 });
    await socket._trigger('draw:cursor', { channelId: 'ch-cur', x: 11, y: 11 });
    await socket._trigger('draw:cursor', { channelId: 'ch-cur', x: 12, y: 12 });

    expect(toEmits.length).toBeLessThanOrEqual(1);
  });

  it('disconnect — session temizlenir ve katılımcılar bilgilendirilir', async () => {
    const s1 = makeDrawSocket('s-dc1');
    const s2 = makeDrawSocket('s-dc2');
    const io  = makeDrawIo();
    const u1  = { _id: 'u7', displayName: 'George', avatarColor: '#777' };
    const u2  = { _id: 'u8', displayName: 'Hannah', avatarColor: '#888' };

    registerDrawTogetherHandlers(s1 as never, io as never, u1);
    registerDrawTogetherHandlers(s2 as never, io as never, u2);

    await s1._trigger('draw:join', { channelId: 'ch-dcdraw', sessionId: 'sess-dc' });
    await s2._trigger('draw:join', { channelId: 'ch-dcdraw', sessionId: 'sess-dc' });
    expect(drawSessions.get('ch-dcdraw')!.participants.size).toBe(2);

    await s1._trigger('disconnect');
    // s1 ayrıldı; session hâlâ var (s2 var)
    expect(drawSessions.has('ch-dcdraw')).toBe(true);
    expect(drawSessions.get('ch-dcdraw')!.participants.has('s-dc1')).toBe(false);

    await s2._trigger('disconnect');
    // s2 de ayrıldı; session silindi
    expect(drawSessions.has('ch-dcdraw')).toBe(false);
  });
});
