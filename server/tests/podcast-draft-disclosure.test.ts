// server/tests/podcast-draft-disclosure.test.ts
// FAZ G — KİMLİK DOĞRULAMASIZ TASLAK BÖLÜM İFŞASI.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `GET /api/podcast/:channelId/episodes` KİMLİK DOĞRULAMASIZDIR — ve bu kısmen
// kasıtlıdır: podcast RSS/JSON beslemeleri kamuya açık olmalıdır.
//
// Ancak uç, sorgu parametresine göre YAYINLANMAMIŞ bölümleri de döndürüyordu:
//
//     ?published=all    → yayınlanmış + TASLAK
//     ?published=false  → YALNIZCA taslaklar
//
// Dönen gövde `title`, `description`, `filename` ve `audioUrl` içerir. Yani
// herhangi bir anonim kişi, yalnızca bir channelId ile yayına ALINMAMIŞ
// bölümleri ve ses dosyası yollarını listeleyebiliyordu.
//
// Faz G tehdit modeli tam olarak bunu varsayar: istemcide böyle bir ekran
// olmaması bir koruma DEĞİLDİR — uç doğrudan çağrılabilir.
//
// POZİTİF KONTROL KURALI: "sızmamalı" iddialarının yanında, kamuya açık
// beslemenin GERÇEKTEN çalıştığını gösteren kontroller vardır. Aksi hâlde uç
// tümüyle bozulsa (her zaman boş dönse) testler yine geçerdi.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
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
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
  verifyToken: (t: string) => { try { return require('jsonwebtoken').verify(t, 'test-jwt-secret-long-enough-32chars!!'); } catch { return null; } },
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import podcastRouter from '../routes/podcast';

const app = express();
app.use(express.json());
app.use('/api/podcast', podcastRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const OWNER    = 'sahip-1';
const OUTSIDER = 'yabanci-1';
const SRV      = 'srv-P';
const CH       = 'ch-podcast';

const TASLAK_BASLIK = 'YAYINLANMAMIS-TASLAK-BASLIK';
const TASLAK_DOSYA  = 'gizli-taslak-ses.mp3';

beforeAll(async () => {
  await mockDb.users.insert({ _id: OWNER,    username: OWNER,    displayName: 'Sahip' });
  await mockDb.users.insert({ _id: OUTSIDER, username: OUTSIDER, displayName: 'Yabanci' });

  await mockDb.servers.insert({ _id: SRV, name: 'P', ownerId: OWNER, createdAt: 1 });
  await mockDb.channels.insert({ _id: CH, serverId: SRV, name: 'podcast-kanali', type: 'text', createdAt: 1 });

  await mockDb.podcastEpisodes.insert({
    _id: 'ep-yayinda', channelId: CH, title: 'Yayinlanmis Bolum',
    description: 'aciklama', filename: 'yayinda.mp3', published: true, publishedAt: 2000,
  });
  await mockDb.podcastEpisodes.insert({
    _id: 'ep-taslak', channelId: CH, title: TASLAK_BASLIK,
    description: 'gizli aciklama', filename: TASLAK_DOSYA, published: false, publishedAt: 3000,
  });
});

const episodes = (qs: string, user?: string) => {
  const r = request(app).get(`/api/podcast/${CH}/episodes${qs}`);
  return user ? r.set('Authorization', `Bearer ${tok(user)}`) : r;
};

// ════════════════════════════════════════════════════════════════════════════
describe('PODCAST — taslak bölümler kimliksiz ifşa edilmez', () => {
  it('POZİTİF KONTROL: kamuya açık besleme YAYINLANMIŞ bölümü döndürür', async () => {
    const res = await episodes('');

    expect(res.status).toBe(200);
    const ids = (res.body.episodes as Array<{ _id: string }>).map(e => e._id);
    expect(ids).toContain('ep-yayinda');
  });

  it('varsayılan çağrıda TASLAK yer almaz', async () => {
    const res = await episodes('');

    const ids = (res.body.episodes as Array<{ _id: string }>).map(e => e._id);
    expect(ids).not.toContain('ep-taslak');
  });

  it('?published=all KİMLİKSİZ çağrıda taslak SIZDIRMAZ', async () => {
    const res = await episodes('?published=all');

    expect(res.status).toBe(200);
    const ids = (res.body.episodes as Array<{ _id: string }>).map(e => e._id);
    expect(ids).not.toContain('ep-taslak');
    // Taslak başlığı ve DOSYA ADI gövdenin hiçbir yerinde geçmemeli.
    expect(JSON.stringify(res.body)).not.toContain(TASLAK_BASLIK);
    expect(JSON.stringify(res.body)).not.toContain(TASLAK_DOSYA);
  });

  it('?published=false KİMLİKSİZ çağrıda taslak SIZDIRMAZ', async () => {
    const res = await episodes('?published=false');

    expect(JSON.stringify(res.body)).not.toContain(TASLAK_BASLIK);
    expect(JSON.stringify(res.body)).not.toContain(TASLAK_DOSYA);
  });

  it('YETKİSİZ kullanıcı (kanal yöneticisi değil) taslak GÖREMEZ', async () => {
    const res = await episodes('?published=all', OUTSIDER);

    const ids = (res.body.episodes as Array<{ _id: string }>).map(e => e._id);
    expect(ids).not.toContain('ep-taslak');
    expect(JSON.stringify(res.body)).not.toContain(TASLAK_DOSYA);
  });

  it('POZİTİF KONTROL: sunucu SAHİBİ ?published=all ile taslağı GÖREBİLİR', async () => {
    // Bu kontrol olmadan yukarıdaki testler, uç herkese taslak vermeyi tümden
    // bıraksa da geçerdi. Yetkili yolun korunduğu burada kanıtlanır.
    const res = await episodes('?published=all', OWNER);

    expect(res.status).toBe(200);
    const ids = (res.body.episodes as Array<{ _id: string }>).map(e => e._id);
    expect(ids).toContain('ep-taslak');
    expect(ids).toContain('ep-yayinda');
  });
});
