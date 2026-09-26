// server/tests/friends-security.test.ts
// Faz 10.9 — Friends akışının test edilmemiş sözleşme boşlukları.
//
// Mevcut friends.test.ts şunları zaten kapsıyor: self-request, aynı yönde
// duplicate, bilinmeyen kullanıcı, eksik alan, üçüncü tarafın accept/decline
// denemesi, taraf olmayanın silme denemesi, liste filtreleme.
//
// Burada YALNIZ eksik kalanlar kilitlenir:
//   - TERS YÖNLÜ istek (A→B beklerken B→A)
//   - ZATEN ARKADAŞ iken tekrar istek
//   - liste/pending'in kimliği doğrulanmış kullanıcıya kapsanması
//   - kimliksiz erişim
//   - bozuk hedef girdisi
//
// DURUM MAKİNESİ (SocialRepository):
//   satır: { userId(istek gönderen), friendId(alıcı), status, createdAt }
//   NONE → createFriendship → 'pending' → accept → 'accepted'
//   Çift benzersizliği UYGULAMA seviyesinde `findFriendship` ile korunur;
//   sorgu ÇİFT YÖNLÜDÜR ($or), bu yüzden ters yön de yakalanır.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

jest.mock('../middleware/rateLimit', () => ({
  limits: { friends: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

const rows: Array<{ _id: string; userId: string; friendId: string; status: string }> = [];
const users = new Map<string, Record<string, unknown>>();

jest.mock('../db/repositories', () => ({
  Users: {
    findById: async (id: string) => users.get(id) ?? null,
    findByIds: async (ids: string[]) => ids.map(i => users.get(i)).filter(Boolean),
    findByUsername: async (n: string) => [...users.values()].find(u => u.username === n) ?? null,
  },
  Social: {
    // Üretimdeki çift yönlü semantiğin birebir aynısı (SocialRepository:11-16).
    // `findBlock` GERCEK depoda vardir ve `/request` artik engeli denetler
    // (engellenen kisi istek gonderemez). Mock'ta eksik olmasi, uretimde
    // olmayan bir 500 uretiyordu — eksik olan MOCK'tu, kod degil.
    findBlock: async () => null,
    findBlocksInvolvingUser: async () => [],
    findFriendship: async (a: string, b: string) =>
      rows.find(r => (r.userId === a && r.friendId === b) || (r.userId === b && r.friendId === a)) ?? null,
    findFriendshipById: async (id: string) => rows.find(r => r._id === id) ?? null,
    findFriendships: async (uid: string) => rows.filter(r => r.userId === uid || r.friendId === uid),
    createFriendship: async (a: string, b: string) => {
      const row = { _id: `fr-${rows.length + 1}`, userId: a, friendId: b, status: 'pending' };
      rows.push(row); return row;
    },
    updateFriendship: async (id: string, fields: Record<string, unknown>) => {
      const r = rows.find(x => x._id === id); if (r) Object.assign(r, fields); return r;
    },
    removeFriendship: async (id: string) => {
      const i = rows.findIndex(x => x._id === id); if (i >= 0) rows.splice(i, 1);
    },
  },
}));

jest.mock('../lib/userUtils', () => ({ sanitizeUser: (u: Record<string, unknown>) => ({ _id: u._id, username: u.username }) }));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import friendsRouter from '../routes/friends';

const A = 'user-a', B = 'user-b', C = 'user-c';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/friends', authMiddleware, friendsRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app: express.Express;

beforeEach(() => {
  rows.length = 0;
  users.clear();
  users.set(A, { _id: A, username: 'alice', tokenVersion: 0 });
  users.set(B, { _id: B, username: 'bob',   tokenVersion: 0 });
  users.set(C, { _id: C, username: 'carol', tokenVersion: 0 });
  app = buildApp();
});

const sendRequest = (from: string, toUsername: string) =>
  request(app).post('/api/friends/request')
    .set('Authorization', `Bearer ${tok(from)}`)
    .send({ username: toUsername });

describe('ters yönlü istek (A→B beklerken B→A)', () => {
  it('ikinci yön DUPLİKE SATIR OLUŞTURMAZ', async () => {
    expect((await sendRequest(A, 'bob')).status).toBe(200);
    expect(rows).toHaveLength(1);

    const res = await sendRequest(B, 'alice');   // ters yön

    expect(res.status).toBe(409);
    expect(rows).toHaveLength(1);   // tek mantıksal ilişki korunur
  });

  it('ters yön çelişkili ikinci ilişki yaratmaz (yön korunur)', async () => {
    await sendRequest(A, 'bob');
    await sendRequest(B, 'alice');

    expect(rows[0].userId).toBe(A);      // orijinal istek yönü değişmedi
    expect(rows[0].friendId).toBe(B);
    expect(rows[0].status).toBe('pending');
  });
});

describe('zaten arkadaşken tekrar istek', () => {
  it('kabul edilmiş ilişki varken yeni istek 409 döner', async () => {
    rows.push({ _id: 'fr-x', userId: A, friendId: B, status: 'accepted' });

    const res = await sendRequest(A, 'bob');

    expect(res.status).toBe(409);
    expect(rows).toHaveLength(1);
  });

  it('kabul edilmiş ilişkide TERS yönden istek de 409 döner', async () => {
    rows.push({ _id: 'fr-x', userId: A, friendId: B, status: 'accepted' });

    const res = await sendRequest(B, 'alice');

    expect(res.status).toBe(409);
    expect(rows).toHaveLength(1);
  });
});

describe('kapsam — kimliği doğrulanmış kullanıcı', () => {
  it('GET /api/friends yalnız ÇAĞIRANIN ilişkilerini döner', async () => {
    rows.push({ _id: 'f1', userId: A, friendId: B, status: 'accepted' });
    rows.push({ _id: 'f2', userId: C, friendId: B, status: 'accepted' });

    const res = await request(app).get('/api/friends').set('Authorization', `Bearer ${tok(A)}`);

    expect(res.status).toBe(200);
    // A yalnız B ile arkadaş; C–B ilişkisi sızmamalı.
    expect(JSON.stringify(res.body)).not.toContain('carol');
  });

  it('body/query ile başka kullanıcının grafiği İSTENEMEZ', async () => {
    rows.push({ _id: 'f2', userId: C, friendId: B, status: 'accepted' });

    // A, C'nin listesini almaya çalışıyor
    const res = await request(app).get(`/api/friends?userId=${C}`).set('Authorization', `Bearer ${tok(A)}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('carol');
    expect(JSON.stringify(res.body)).not.toContain('bob');
  });

  it('GET /api/friends/pending yalnız ÇAĞIRANA gelen istekleri döner', async () => {
    rows.push({ _id: 'p1', userId: A, friendId: B, status: 'pending' });   // B'ye gelen
    rows.push({ _id: 'p2', userId: A, friendId: C, status: 'pending' });   // C'ye gelen

    const res = await request(app).get('/api/friends/pending').set('Authorization', `Bearer ${tok(B)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('kimlik ve girdi güvenliği', () => {
  it('kimliksiz istekler reddedilir', async () => {
    expect((await request(app).get('/api/friends')).status).toBe(401);
    expect((await request(app).get('/api/friends/pending')).status).toBe(401);
    expect((await request(app).post('/api/friends/request').send({ username: 'bob' })).status).toBe(401);
  });

  it('body\'deki sahte aktör kimliği YETKİ KAYNAĞI değildir', async () => {
    // A, "ben C'yim" diyerek C adına istek göndermeye çalışıyor.
    const res = await request(app).post('/api/friends/request')
      .set('Authorization', `Bearer ${tok(A)}`)
      .send({ username: 'bob', userId: C, requesterId: C });

    expect(res.status).toBe(200);
    // İlişki DAİMA kimliği doğrulanmış kullanıcıya (A) yazılır.
    expect(rows[0].userId).toBe(A);
    expect(rows[0].userId).not.toBe(C);
  });

  it('bozuk/eksik hedef güvenle reddedilir (500 değil)', async () => {
    for (const body of [{}, { username: '' }, { username: null }, { username: 123 }, { username: {} }]) {
      const res = await request(app).post('/api/friends/request')
        .set('Authorization', `Bearer ${tok(A)}`).send(body);

      expect(res.status).toBeLessThan(500);
      expect([400, 404]).toContain(res.status);
    }
    expect(rows).toHaveLength(0);   // hiçbir yan etki yok
  });
});
