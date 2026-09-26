// server/tests/federation-social-repository-shapes.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// FEDERASYON SOSYAL UÇLARI — DEPO YÜZEY FARKLARI VE SİLİNMİŞ HESAP
// ════════════════════════════════════════════════════════════════════════════
//
// Bu uçlar iki farklı depo sürücüsüyle çalışır: biri hazır dizi döndürür,
// diğeri zincirlenebilir bir sorgu nesnesi (thenable). Kodda her okuma bu iki
// biçimi de kabul eder; ölçülmemiş dallar tam olarak İKİNCİ biçimdi. Yanlış
// dal, timeline/bildirim uçlarının BOŞ dönmesi ya da çökmesi demektir.
//
// Ayrıca:
//   · SİLİNMİŞ HESAP — jetonu hâlâ geçerli olan ama kullanıcı satırı silinmiş
//     bir istek, federasyon eylemi ÜRETMEMELİDİR (ağa çıkan bir yan etki).
//   · BOZUK GÖVDE — istek gövdesi dizi/metin olabilir; URL doğrulaması bunu
//     "eksik" saymalı, çökmemelidir.
//   · ÖRNEK ADRESİ — `INSTANCE_URL` yoksa yerel adrese düşülür; bu değer
//     giden Undo aktivitesinin aktör kimliğini belirler.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
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
jest.mock('../routes/federation/delivery', () => ({
  sendFollowRequest: jest.fn(), sendUnfollow: jest.fn(), sendLike: jest.fn(),
  sendAnnounce: jest.fn(), deliverApActivity: jest.fn(), deliverToFollowers: jest.fn(),
  signRequest: jest.fn(),
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_q: unknown, _s: unknown, n: () => void) => n() }),
  rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  _resetRateLimitStoreForTest: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

const {
  sendUnfollow, sendLike, sendAnnounce, deliverApActivity,
} = require('../routes/federation/delivery');
const { Federation, Notifications } = require('../db/repositories');

const socialModule = require('../routes/federation/social');
const socialRouter = socialModule.default || socialModule;

const app = express();
app.use(express.json());
app.use('/api/federation', socialRouter);
app.use((err: Error & { status?: number }, _q: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _n: unknown) => res.status(err.status || 500).json({ error: err.message }));

const USER = 'fed-user';
const token = jwt.sign({ id: USER, username: USER, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
const auth = () => ['Authorization', `Bearer ${token}`] as const;

/** Zincirlenebilir sorgu nesnesi döndüren sürücüyü modeller. */
function thenableQuery(rows: unknown[]) {
  const chain = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown[]) => void) => resolve(rows),
  };
  return chain;
}

/** Yalnız `then` taşıyan (zincirsiz) bir sürücü sonucu. */
const thenable = (rows: unknown[]) => ({ then: (resolve: (v: unknown[]) => void) => resolve(rows) });

beforeEach(async () => {
  jest.clearAllMocks();
  mockDb._reset?.();
  await mockDb.users.insert(makeUser({ _id: USER, username: 'ada', apPublicKey: 'PUB' }));
});

afterEach(() => { jest.restoreAllMocks(); });

describe('silinmiş hesap federasyon eylemi üretemez', () => {
  it('takip, takibi bırakma ve beğeni geri alma 401 ile durur', async () => {
    await mockDb.users.remove({ _id: USER });

    const follow = await request(app).post('/api/federation/follow')
      .set(...auth()).send({ actorUrl: 'https://uzak.test/users/bob' });
    expect(follow.status).toBe(401);
    expect(follow.body.error).toBe('Not found');

    const unfollow = await request(app).delete('/api/federation/follow')
      .set(...auth()).send({ actorUrl: 'https://uzak.test/users/bob' });
    expect(unfollow.status).toBe(401);
    expect(sendUnfollow).not.toHaveBeenCalled();

    const unlike = await request(app).delete('/api/federation/like')
      .set(...auth()).send({ objectUrl: 'https://uzak.test/notes/1' });
    expect(unlike.status).toBe(401);
    expect(deliverApActivity).not.toHaveBeenCalled();
  });

  it('anahtarı olmayan hesap beğeni ve boost gönderemez', async () => {
    await mockDb.users.update({ _id: USER }, { $set: { apPublicKey: null } });

    const like = await request(app).post('/api/federation/like')
      .set(...auth()).send({ objectUrl: 'https://uzak.test/notes/1' });
    expect(like.status).toBe(400);
    expect(sendLike).not.toHaveBeenCalled();

    const announce = await request(app).post('/api/federation/announce')
      .set(...auth()).send({ objectUrl: 'https://uzak.test/notes/1' });
    expect(announce.status).toBe(400);
    expect(sendAnnounce).not.toHaveBeenCalled();
  });
});

describe('bozuk istek gövdesi', () => {
  const cases: Array<[string, 'post' | 'delete', string, string]> = [
    ['takip', 'post', '/api/federation/follow', 'actorUrl must be a valid http(s) URL'],
    ['takibi bırakma', 'delete', '/api/federation/follow', 'actorUrl must be a valid http(s) URL'],
    ['beğeni', 'post', '/api/federation/like', 'objectUrl must be a valid http(s) URL'],
    ['beğeni geri alma', 'delete', '/api/federation/like', 'objectUrl must be a valid http(s) URL'],
    ['boost', 'post', '/api/federation/announce', 'objectUrl must be a valid http(s) URL'],
  ];

  it.each(cases)('%s ucunda dizi gövde "eksik" sayılır', async (_label, method, path, error) => {
    const res = await request(app)[method](path)
      .set(...auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(['dizi']));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });

  it.each(cases)('%s ucunda http(s) olmayan adres reddedilir', async (_label, method, path, error) => {
    const res = await request(app)[method](path)
      .set(...auth())
      .send({ actorUrl: 'javascript:alert(1)', objectUrl: 'javascript:alert(1)' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });
});

describe('depo yüzey farkları', () => {
  it('takip edilenler listesi hem dizi hem zincir sonucundan okunur', async () => {
    const row = { targetActorUrl: 'https://uzak.test/users/bob', accepted: true, createdAt: 7 };

    jest.spyOn(Federation, 'findApOutgoingFollows').mockResolvedValueOnce([row]);
    const asArray = await request(app).get('/api/federation/following').set(...auth());
    expect(asArray.body).toEqual([{ actorUrl: row.targetActorUrl, accepted: true, createdAt: 7 }]);

    jest.spyOn(Federation, 'findApOutgoingFollows').mockResolvedValueOnce(thenable([row]) as never);
    const asThenable = await request(app).get('/api/federation/following').set(...auth());
    expect(asThenable.body).toEqual(asArray.body);
  });

  it('takipçi listesi de her iki biçimi kabul eder', async () => {
    const row = { actorUrl: 'https://uzak.test/users/bob', accepted: true, createdAt: 9 };

    jest.spyOn(Federation, 'findApFollows').mockResolvedValueOnce([row]);
    const asArray = await request(app).get('/api/federation/followers').set(...auth());
    expect(asArray.status).toBe(200);

    jest.spyOn(Federation, 'findApFollows').mockResolvedValueOnce(thenable([row]) as never);
    const asThenable = await request(app).get('/api/federation/followers').set(...auth());
    expect(asThenable.body).toEqual(asArray.body);
  });

  it('boş/eksik depo sonucu boş liste olarak sunulur', async () => {
    jest.spyOn(Federation, 'findApOutgoingFollows').mockResolvedValueOnce(null as never);
    expect((await request(app).get('/api/federation/following').set(...auth())).body).toEqual([]);

    jest.spyOn(Federation, 'findApFollows').mockResolvedValueOnce(null as never);
    expect((await request(app).get('/api/federation/followers').set(...auth())).body).toEqual([]);
  });

  it('timeline zincir sonucundan okunur ve sayfa sayısı hesaplanır', async () => {
    const message = { _id: 'ap-1', actorUrl: 'https://uzak.test/users/bob', content: 'selam', visibility: 'public' };
    jest.spyOn(Federation, 'findApOutgoingFollows')
      .mockResolvedValue(thenable([{ targetActorUrl: 'https://uzak.test/users/bob' }]) as never);
    jest.spyOn(Federation, 'apMessagesFind').mockReturnValue(thenableQuery([message]) as never);
    jest.spyOn(Federation, 'countApMessages').mockResolvedValue(45 as never);

    const res = await request(app).get('/api/federation/timeline?limit=20&page=2').set(...auth());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [message], total: 45, page: 2, limit: 20, pages: 3 });
  });

  it('takip edilen kimse yoksa timeline depoya hiç gitmez', async () => {
    jest.spyOn(Federation, 'findApOutgoingFollows').mockResolvedValue([] as never);
    const find = jest.spyOn(Federation, 'apMessagesFind');

    const res = await request(app).get('/api/federation/timeline').set(...auth());

    expect(res.body).toEqual({ items: [], total: 0, page: 1, limit: 20, pages: 0 });
    expect(find).not.toHaveBeenCalled();
  });

  it('toplam sayı bilinmiyorsa sayfa sayısı sıfır olur', async () => {
    jest.spyOn(Federation, 'findApOutgoingFollows')
      .mockResolvedValue([{ targetActorUrl: 'https://uzak.test/users/bob' }] as never);
    jest.spyOn(Federation, 'apMessagesFind').mockReturnValue(thenableQuery([]) as never);
    jest.spyOn(Federation, 'countApMessages').mockResolvedValue(null as never);

    const res = await request(app).get('/api/federation/timeline').set(...auth());

    expect(res.body).toMatchObject({ total: null, pages: 0 });
  });

  it('bildirimler zincir sonucundan ve boş sonuçtan güvenle okunur', async () => {
    const row = { _id: 'n-1', userId: USER, type: 'ap_follow' };

    jest.spyOn(Notifications, 'inboxFind').mockReturnValueOnce(thenableQuery([row]) as never);
    const asThenable = await request(app).get('/api/federation/notifications').set(...auth());
    expect(asThenable.body).toEqual([row]);

    jest.spyOn(Notifications, 'inboxFind').mockReturnValueOnce(thenableQuery([]) as never);
    expect((await request(app).get('/api/federation/notifications').set(...auth())).body).toEqual([]);
  });

  it('geçersiz sayfalama parametreleri depoya gitmeden reddedilir', async () => {
    const find = jest.spyOn(Federation, 'apMessagesFind');

    expect((await request(app).get('/api/federation/timeline?page=0').set(...auth())).status).toBe(400);
    expect((await request(app).get('/api/federation/timeline?limit=abc').set(...auth())).status).toBe(400);
    expect((await request(app).get('/api/federation/notifications?limit=-1').set(...auth())).status).toBe(400);
    expect(find).not.toHaveBeenCalled();
  });
});

describe('örnek adresi çözümü', () => {
  it('INSTANCE_URL yoksa yerel adrese düşülür', async () => {
    const previousInstance = process.env.INSTANCE_URL;
    const previousPort = process.env.PORT;
    delete process.env.INSTANCE_URL;
    process.env.PORT = '4321';
    try {
      jest.spyOn(Federation, 'findApLikeOne').mockResolvedValue({ _id: 'like-1' } as never);
      jest.spyOn(Federation, 'removeApLike').mockResolvedValue(undefined as never);

      const res = await request(app).delete('/api/federation/like')
        .set(...auth()).send({ objectUrl: 'https://uzak.test/notes/1' });

      expect(res.status).toBe(200);
      const [, activity] = deliverApActivity.mock.calls[0] ?? [];
      expect(JSON.stringify(activity ?? {})).toContain('http://localhost:4321/api/federation/users/ada');
    } finally {
      if (previousInstance === undefined) delete process.env.INSTANCE_URL; else process.env.INSTANCE_URL = previousInstance;
      if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    }
  });

  it('PORT da yoksa varsayılan port kullanılır', async () => {
    const previousInstance = process.env.INSTANCE_URL;
    const previousPort = process.env.PORT;
    delete process.env.INSTANCE_URL;
    delete process.env.PORT;
    try {
      jest.spyOn(Federation, 'findApLikeOne').mockResolvedValue({ _id: 'like-1' } as never);
      jest.spyOn(Federation, 'removeApLike').mockResolvedValue(undefined as never);

      await request(app).delete('/api/federation/like')
        .set(...auth()).send({ objectUrl: 'https://uzak.test/notes/1' });

      const [, activity] = deliverApActivity.mock.calls[0] ?? [];
      expect(JSON.stringify(activity ?? {})).toContain('http://localhost:3001/api/federation/users/ada');
    } finally {
      if (previousInstance === undefined) delete process.env.INSTANCE_URL; else process.env.INSTANCE_URL = previousInstance;
      if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    }
  });

  it('beğeni kaydı yoksa geri alma 404 verir ve ağa çıkılmaz', async () => {
    jest.spyOn(Federation, 'findApLikeOne').mockResolvedValue(null as never);

    const res = await request(app).delete('/api/federation/like')
      .set(...auth()).send({ objectUrl: 'https://uzak.test/notes/1' });

    expect(res.status).toBe(404);
    expect(deliverApActivity).not.toHaveBeenCalled();
  });
});
