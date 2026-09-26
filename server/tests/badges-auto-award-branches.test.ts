// server/tests/badges-auto-award-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ROZETLER — OTOMATİK VERME KOŞULLARI VE GÖRÜNTÜLEME YEDEKLERİ
// ════════════════════════════════════════════════════════════════════════════
//
// Otomatik rozet kontrolü giriş akışının İÇİNDE çalışır. Ölçülmemiş dalların
// taşıdığı riskler:
//
//   · GİRİŞİ BLOKLAMA — rozet deposu yoksa ya da bir yazma çakışırsa kontrol
//     SESSİZCE vazgeçmelidir. Fırlatan bir dal giriş akışını düşürürdü.
//   · YANLIŞ ÖDÜL — eşikler (1 yıl / 2 yıl / 3 bağlantı) yanlış tarafa
//     kayarsa kullanıcı hak etmediği bir rozet alır ve geri alınması manuel
//     yönetici işi olur.
//   · ÇİFT ÖDÜL — hâlihazırda sahip olunan rozet yeniden yazılmamalıdır.
//   · GÖRÜNTÜLEME — depoda saklanan etiket/simge eksikse katalogdan, o da
//     yoksa ham anahtardan türetilir; kullanıcıya "undefined" gösterilmez.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

interface Row { [key: string]: unknown }

const badgeRows: Row[] = [];
const connectionRows: Row[] = [];
const botRows: Row[] = [];
const ownedServers: Row[] = [];
const users = new Map<string, Row | null>();
let badgeCollectionPresent = true;
let insertFails = false;

function matches(row: Row, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => row[key] === value);
}

const userBadges = {
  async find(query: Record<string, unknown>) { return badgeRows.filter(row => matches(row, query)); },
  async findOne(query: Record<string, unknown>) { return badgeRows.find(row => matches(row, query)) ?? null; },
  async insert(row: Row) {
    if (insertFails) throw Object.assign(new Error('UNIQUE constraint failed'), { code: '23505' });
    badgeRows.push(row);
    return row;
  },
  async remove(query: Record<string, unknown>) {
    for (let i = badgeRows.length - 1; i >= 0; i -= 1) if (matches(badgeRows[i]!, query)) badgeRows.splice(i, 1);
    return { deleted: true };
  },
};

jest.mock('../db', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get(_target, prop: string) {
      if (prop === 'userBadges') return badgeCollectionPresent ? userBadges : undefined;
      if (prop === 'userConnections') return { find: async (q: Record<string, unknown>) => connectionRows.filter(r => matches(r, q)) };
      if (prop === 'bots') return { findOne: async (q: Record<string, unknown>) => botRows.find(r => matches(r, q)) ?? null };
      return undefined;
    },
  }),
}));
jest.mock('../db/repositories', () => ({
  Users: { findById: async (id: string) => users.get(id) ?? null },
  Servers: { find: async (q: Record<string, unknown>) => ownedServers.filter(r => matches(r, q)) },
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    try { req.user = require('jsonwebtoken').verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
jest.mock('../lib/adminAuthority', () => ({ databaseAdminOnly: (_q: unknown, _s: unknown, next: () => void) => next() }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_q: unknown, _s: unknown, n: () => void) => n() }),
  rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));
jest.mock('../lib/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), child: () => logger };
  return { __esModule: true, default: logger, logger, createLogger: () => logger };
});

import badgesRouter, { BADGE_DEFS, checkAndAwardAutoBadges } from '../routes/badges';

const token = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const ADMIN = 'rozet-admin';
const MEMBER = 'rozet-uye';
const DAY = 86_400_000;

let app: express.Express;

beforeEach(() => {
  badgeRows.length = 0;
  connectionRows.length = 0;
  botRows.length = 0;
  ownedServers.length = 0;
  users.clear();
  users.set(ADMIN, { _id: ADMIN, username: 'admin', createdAt: Date.now() });
  users.set(MEMBER, { _id: MEMBER, username: 'uye', createdAt: Date.now() });
  badgeCollectionPresent = true;
  insertFails = false;

  app = express();
  app.use(express.json());
  app.use('/api', badgesRouter);
  app.use((err: Error & { status?: number }, _q: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _n: unknown) => res.status(500).json({ error: err.message }));
});

const awarded = (): string[] => badgeRows.map(row => String(row.badge)).sort();

describe('rozet görüntüleme yedekleri', () => {
  it('depodaki etiket öncelikli, yoksa katalog, o da yoksa ham anahtar gösterilir', async () => {
    badgeRows.push(
      { _id: 'b1', userId: MEMBER, badge: 'moderator', label: 'Özel Etiket', icon: '🔥', awardedAt: 1 },
      { _id: 'b2', userId: MEMBER, badge: 'one_year', awardedAt: 2 },
      { _id: 'b3', userId: MEMBER, badge: 'katalogda_yok', awardedAt: 3 },
    );

    const res = await request(app).get(`/api/users/${MEMBER}/badges`).set('Authorization', `Bearer ${token(MEMBER)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { badge: 'moderator', label: 'Özel Etiket', icon: '🔥', description: BADGE_DEFS.moderator!.description, awardedAt: 1 },
      { badge: 'one_year', label: BADGE_DEFS.one_year!.label, icon: BADGE_DEFS.one_year!.icon, description: BADGE_DEFS.one_year!.description, awardedAt: 2 },
      // Katalogda olmayan anahtar icin "undefined" degil, anahtarin kendisi.
      { badge: 'katalogda_yok', label: 'katalogda_yok', icon: '🏷️', description: '', awardedAt: 3 },
    ]);
  });

  it('rozeti olmayan kullanıcı boş liste alır', async () => {
    const res = await request(app).get(`/api/users/${MEMBER}/badges`).set('Authorization', `Bearer ${token(MEMBER)}`);
    expect(res.body).toEqual([]);
  });
});

describe('yönetici rozet verme ve geri alma', () => {
  it('eksik alanlar ve bilinmeyen rozet reddedilir', async () => {
    const missing = await request(app).post('/api/admin/badges/award')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ userId: MEMBER });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('userId ve badge gerekli');

    const noUser = await request(app).post('/api/admin/badges/award')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ badge: 'moderator' });
    expect(noUser.status).toBe(400);

    const unknown = await request(app).post('/api/admin/badges/award')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ userId: MEMBER, badge: 'uydurma' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('Bilinmeyen rozet: uydurma');
    expect(badgeRows).toHaveLength(0);
  });

  it('olmayan kullanıcıya rozet verilemez', async () => {
    const res = await request(app).post('/api/admin/badges/award')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ userId: 'yok-boyle', badge: 'moderator' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Kullanıcı bulunamadı');
  });

  it('aynı rozet iki kez verilemez', async () => {
    const first = await request(app).post('/api/admin/badges/award')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ userId: MEMBER, badge: 'moderator' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ userId: MEMBER, badge: 'moderator', awardedBy: ADMIN });

    const second = await request(app).post('/api/admin/badges/award')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ userId: MEMBER, badge: 'moderator' });
    expect(second.status).toBe(409);
    expect(badgeRows).toHaveLength(1);
  });

  it('geri alma eksik alanlarda reddedilir, tam istekte rozeti siler', async () => {
    badgeRows.push({ _id: 'b1', userId: MEMBER, badge: 'moderator', awardedAt: 1 });

    const missing = await request(app).delete('/api/admin/badges/revoke')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ userId: MEMBER });
    expect(missing.status).toBe(400);
    expect(badgeRows).toHaveLength(1);

    const ok = await request(app).delete('/api/admin/badges/revoke')
      .set('Authorization', `Bearer ${token(ADMIN)}`).send({ userId: MEMBER, badge: 'moderator' });
    expect(ok.status).toBe(200);
    expect(badgeRows).toHaveLength(0);
  });
});

describe('otomatik rozet kontrolü', () => {
  it('rozet deposu yapılandırılmamışsa sessizce vazgeçer', async () => {
    badgeCollectionPresent = false;

    await expect(checkAndAwardAutoBadges(MEMBER)).resolves.toBeUndefined();
    expect(badgeRows).toHaveLength(0);
  });

  it('kullanıcı yoksa hiçbir şey verilmez', async () => {
    await checkAndAwardAutoBadges('yok-boyle');
    expect(badgeRows).toHaveLength(0);
  });

  it('yaş eşikleri kesin sınırla uygulanır', async () => {
    users.set(MEMBER, { _id: MEMBER, createdAt: Date.now() - 364 * DAY });
    await checkAndAwardAutoBadges(MEMBER);
    expect(awarded()).toEqual([]);

    badgeRows.length = 0;
    users.set(MEMBER, { _id: MEMBER, createdAt: Date.now() - 366 * DAY });
    await checkAndAwardAutoBadges(MEMBER);
    expect(awarded()).toEqual(['one_year']);

    badgeRows.length = 0;
    users.set(MEMBER, { _id: MEMBER, createdAt: Date.now() - 731 * DAY });
    await checkAndAwardAutoBadges(MEMBER);
    expect(awarded()).toEqual(['one_year', 'two_years']);
  });

  it('kayıt tarihi olmayan kullanıcı için yaş rozetleri verilir (epoch başlangıcı)', async () => {
    users.set(MEMBER, { _id: MEMBER });

    await checkAndAwardAutoBadges(MEMBER);

    // `createdAt` yoksa 0 kabul edilir; hesap epoch'tan beri var sayilir.
    expect(awarded()).toEqual(['one_year', 'two_years']);
  });

  it('bağlayıcı rozeti tam üç bağlantıda verilir', async () => {
    connectionRows.push({ userId: MEMBER, platform: 'a' }, { userId: MEMBER, platform: 'b' });
    await checkAndAwardAutoBadges(MEMBER);
    expect(awarded()).toEqual([]);

    connectionRows.push({ userId: MEMBER, platform: 'c' });
    await checkAndAwardAutoBadges(MEMBER);
    expect(awarded()).toEqual(['connector']);
  });

  it('sunucu kurucusu ve bot geliştiricisi rozetleri kendi koşullarıyla verilir', async () => {
    ownedServers.push({ _id: 's1', ownerId: MEMBER });
    botRows.push({ _id: 'bot-1', ownerId: MEMBER });

    await checkAndAwardAutoBadges(MEMBER);

    expect(awarded()).toEqual(['bot_developer', 'server_founder']);
    expect(badgeRows.every(row => row.awardedBy === 'system')).toBe(true);
  });

  it('hâlihazırda sahip olunan rozetler yeniden sorgulanmaz ve yeniden verilmez', async () => {
    badgeRows.push(
      { _id: 'b1', userId: MEMBER, badge: 'connector', awardedAt: 1 },
      { _id: 'b2', userId: MEMBER, badge: 'server_founder', awardedAt: 1 },
      { _id: 'b3', userId: MEMBER, badge: 'bot_developer', awardedAt: 1 },
    );
    connectionRows.push({ userId: MEMBER }, { userId: MEMBER }, { userId: MEMBER });
    ownedServers.push({ _id: 's1', ownerId: MEMBER });
    botRows.push({ _id: 'bot-1', ownerId: MEMBER });

    await checkAndAwardAutoBadges(MEMBER);

    expect(badgeRows).toHaveLength(3);
  });

  it('yazma çakışması giriş akışını düşürmez', async () => {
    users.set(MEMBER, { _id: MEMBER, createdAt: Date.now() - 800 * DAY });
    insertFails = true;

    await expect(checkAndAwardAutoBadges(MEMBER)).resolves.toBeUndefined();
    expect(badgeRows).toHaveLength(0);
  });

  it('depo okuması çökerse hata yutulur ve akış sürer', async () => {
    users.set(MEMBER, { _id: MEMBER, createdAt: Date.now() });
    const original = userBadges.find;
    userBadges.find = async () => { throw new Error('badge store offline'); };

    await expect(checkAndAwardAutoBadges(MEMBER)).resolves.toBeUndefined();

    userBadges.find = original;
    expect(badgeRows).toHaveLength(0);
  });
});
