// server/tests/dm-privacy-security.test.ts
// Faz 10.8 — DM gizlilik politikası uygulaması (REST + socket eşdeğerliği).
//
// ENUM (db/postgres/schema.ts:34, varsayılan 'everyone'):
//   everyone → herkes DM başlatabilir
//   friends  → yalnız karşılıklı KABUL EDİLMİŞ arkadaş
//   none     → hiç kimse yeni konuşma başlatamaz
//
// MEVCUT SÖZLEŞME (socket/handlers/dm.ts:301-303): kısıtlama YALNIZCA yeni
// konuşma açılışına uygulanır; konuşma zaten varsa atlanır.
//
// BULUNAN AÇIK (HIGH): socket yolu hem engeli hem gizliliği kontrol ediyordu,
// ama `POST /api/dm/:userId` HİÇBİRİNİ kontrol etmiyordu. Saldırgan REST ile
// konuşmayı açıp, ardından socket'in "konuşma zaten var" muafiyetine girerek
// gizliliği/engeli KALICI olarak aşabiliyordu.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

jest.mock('../middleware/rateLimit', () => ({
  limits: { dm: () => (_req: unknown, _res: unknown, next: () => void) => next(), messages: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

const store = {
  users: new Map<string, Record<string, unknown>>(),
  convs: new Map<string, unknown>(),
  blocks: [] as Array<{ a: string; b: string }>,
  friendships: [] as Array<{ a: string; b: string; status: string }>,
};

jest.mock('../db/repositories', () => ({
  Users: {
    findById: async (id: string) => store.users.get(id) ?? null,
    findByIds: async (ids: string[]) => ids.map(i => store.users.get(i)).filter(Boolean),
  },
  Dms: {
    findConversation: async () => null,
    findConversationsByUser: async () => [],
    findConversationByParticipants: async (a: string, b: string) =>
      store.convs.get([a, b].sort().join(':')) ?? null,
    findOrCreateConversation: async (a: string, b: string) => {
      const dmId = [a, b].sort().join(':');
      const conv = { _id: dmId, participants: [a, b] };
      store.convs.set(dmId, conv);
      return { conv, dmId };
    },
    findMessages: async () => [],
    countUnread: async () => 0,
  },
  Social: {
    findBlock: async (a: string, b: string) =>
      store.blocks.find(x => x.a === a && x.b === b) ?? null,
    findFriendship: async (a: string, b: string) =>
      store.friendships.find(f => (f.a === a && f.b === b) || (f.a === b && f.b === a)) ?? null,
  },
}));

// `sanitizeUser` sadelestirilir; NORMALLESTIRICILER GERCEK kalir. Bunlar
// alan disi bir `dmPrivacy` degerinin nasil yorumlandigini belirler ve
// taklit edilirlerse bu dosyanin olctugu sey urun davranisi olmaktan cikar.
jest.mock('../lib/userUtils', () => ({
  ...jest.requireActual('../lib/userUtils'),
  sanitizeUser: (u: Record<string, unknown>) => ({ _id: u._id }),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import dmRouter from '../routes/dm';

const ATTACKER = 'user-attacker';
const VICTIM   = 'user-victim';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dm', authMiddleware, dmRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app: express.Express;

function setVictimPrivacy(dmPrivacy: string): void {
  store.users.set(VICTIM, { _id: VICTIM, username: 'victim', tokenVersion: 0, dmPrivacy });
}

beforeEach(() => {
  store.users.clear(); store.convs.clear();
  store.blocks = []; store.friendships = [];
  store.users.set(ATTACKER, { _id: ATTACKER, username: 'attacker', tokenVersion: 0, dmPrivacy: 'everyone' });
  setVictimPrivacy('everyone');
  app = buildApp();
});

const openDm = () =>
  request(app).post(`/api/dm/${VICTIM}`).set('Authorization', `Bearer ${tok(ATTACKER)}`);

describe('dmPrivacy — REST konuşma açma', () => {
  it("everyone: konuşma açılabilir (pozitif kontrol)", async () => {
    setVictimPrivacy('everyone');

    expect((await openDm()).status).toBe(200);
  });

  it("none: konuşma AÇILAMAZ", async () => {
    setVictimPrivacy('none');

    const res = await openDm();

    expect(res.status).toBe(403);
    expect(store.convs.size).toBe(0);   // konuşma yaratılmadı
  });

  it("friends: arkadaş OLMAYAN konuşma açamaz", async () => {
    setVictimPrivacy('friends');

    const res = await openDm();

    expect(res.status).toBe(403);
    expect(store.convs.size).toBe(0);
  });

  it("friends: bekleyen (kabul edilmemiş) istek YETERLİ DEĞİL", async () => {
    setVictimPrivacy('friends');
    store.friendships.push({ a: ATTACKER, b: VICTIM, status: 'pending' });

    expect((await openDm()).status).toBe(403);
  });

  it("friends: karşılıklı KABUL edilmiş arkadaş açabilir", async () => {
    setVictimPrivacy('friends');
    store.friendships.push({ a: ATTACKER, b: VICTIM, status: 'accepted' });

    expect((await openDm()).status).toBe(200);
  });

  it('engellenen kullanıcı konuşma AÇAMAZ (her iki yön)', async () => {
    setVictimPrivacy('everyone');
    store.blocks.push({ a: VICTIM, b: ATTACKER });   // kurban saldırganı engelledi

    expect((await openDm()).status).toBe(403);

    store.blocks = [{ a: ATTACKER, b: VICTIM }];      // ters yön de reddedilmeli
    expect((await openDm()).status).toBe(403);
  });

  it('MEVCUT konuşma block sınırını grandfather etmez', async () => {
    setVictimPrivacy('everyone');
    expect((await openDm()).status).toBe(200);

    // Konuşma daha önce var olsa bile sonradan gelen block her zaman üstün olmalı.
    store.blocks.push({ a: VICTIM, b: ATTACKER });
    expect((await openDm()).status).toBe(403);
  });

  it('MEVCUT konuşma varsa kısıtlama atlanır (socket ile aynı sözleşme)', async () => {
    // Önce everyone iken konuşma açılır
    setVictimPrivacy('everyone');
    expect((await openDm()).status).toBe(200);

    // Sonra kurban kapatır — mevcut konuşma erişimi korunur
    setVictimPrivacy('none');

    expect((await openDm()).status).toBe(200);
  });
});

describe('dmPrivacy — policy store arızaları fail-closed', () => {
  afterEach(() => jest.restoreAllMocks());

  it('block store okunamazsa 503 döner; "block yok" varsaymaz', async () => {
    const repos = jest.requireMock('../db/repositories') as { Social: { findBlock: jest.Mock } };
    jest.spyOn(repos.Social, 'findBlock').mockRejectedValueOnce(new Error('block store down'));
    expect((await openDm()).status).toBe(503);
    expect(store.convs.size).toBe(0);
  });

  it('conversation store okunamazsa privacy kontrolünü bypass etmez', async () => {
    const repos = jest.requireMock('../db/repositories') as { Dms: { findConversationByParticipants: jest.Mock } };
    jest.spyOn(repos.Dms, 'findConversationByParticipants').mockRejectedValueOnce(new Error('conversation store down'));
    expect((await openDm()).status).toBe(503);
    expect(store.convs.size).toBe(0);
  });

  it('friends policy için friendship store okunamazsa 503 döner', async () => {
    setVictimPrivacy('friends');
    const repos = jest.requireMock('../db/repositories') as { Social: { findFriendship: jest.Mock } };
    jest.spyOn(repos.Social, 'findFriendship').mockRejectedValueOnce(new Error('friendship store down'));
    expect((await openDm()).status).toBe(503);
    expect(store.convs.size).toBe(0);
  });
});

describe('dmPrivacy — kimlik ve girdi güvenliği', () => {
  it('payload\'daki sahte gönderen kimliği YETKİ KAYNAĞI değildir', async () => {
    setVictimPrivacy('none');

    const res = await request(app).post(`/api/dm/${VICTIM}`)
      .set('Authorization', `Bearer ${tok(ATTACKER)}`)
      .send({ userId: VICTIM, senderId: VICTIM });   // "ben kurbanım" numarası

    expect(res.status).toBe(403);
  });

  it('var olmayan alıcı güvenle reddedilir (500 değil)', async () => {
    const res = await request(app).post('/api/dm/yok-boyle-kullanici')
      .set('Authorization', `Bearer ${tok(ATTACKER)}`);

    expect(res.status).toBe(404);
  });

  it('kendine DM açma reddedilir', async () => {
    const res = await request(app).post(`/api/dm/${ATTACKER}`)
      .set('Authorization', `Bearer ${tok(ATTACKER)}`);

    expect(res.status).toBe(400);
  });

  it('kimliksiz istek reddedilir', async () => {
    expect((await request(app).post(`/api/dm/${VICTIM}`)).status).toBe(401);
  });
});
