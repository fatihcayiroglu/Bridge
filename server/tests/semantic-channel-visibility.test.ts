// server/tests/semantic-channel-visibility.test.ts
// FAZ F — SEMANTİK ARAMA UÇLARINDA KANAL GÖRÜNÜRLÜĞÜ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR — CANLI, KOŞULSUZ İÇERİK SIZINTISI
// ════════════════════════════════════════════════════════════════════════════
// `POST /api/semantic/search` yalnızca SUNUCU ÜYELİĞİNİ denetliyor ve
// sunucudaki TÜM kanalların mesajlarını çekiyordu (`{ serverId }` filtresi;
// kanal kapsaması YOK).
//
// Sızıntı hiçbir yapılandırmaya bağlı DEĞİLDİ:
//   · PGVECTOR_ENABLED varsayılan olarak FALSE (opt-in)
//   · AI_ENABLED bu dağıtımda FALSE (sağlayıcı anahtarı yok)
//   · bu durumda kod `keywordSearch` YEDEĞİNE düşer ve eşleşen mesajların
//     TAM `content` alanını döndürür.
//
// Yani sıradan bir sunucu üyesi, GÖREMEDİĞİ özel kanalların METNİNİ bu uçtan
// okuyabiliyordu. Faz D'de `search.ts` sertleştirilmişti; AYNI VERİYE giden bu
// ikinci yol denetimsiz kalmıştı — tek bir ucu korumak yetmiyor.
//
// `GET /api/semantic/digest/:serverId` de aynı sınıftaydı: her kanal için en
// çok tepki alan mesajların ilk 100 karakterini döndürüyordu.
//
// POZİTİF KONTROL KURALI: her "sızmamalı" iddiasının yanında, yetkili yolun
// GERÇEKTEN sonuç ürettiğini gösteren bir kontrol vardır.

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

// Önbellek kapalı: önbelleğe alınmış yanıt izin denetimini atlatabilirdi.
//
// DİKKAT: modülün TAMAMI değiştirilemez. `middleware/rateLimit.ts` aynı
// modülden `isRedisAvailable`ı da içe aktarır; tümüyle değiştirilirse
// `limits.ai()` çalışırken patlar ve uç 500 döner — yani testler izin
// denetimine HİÇ ULAŞAMADAN "başarısız" olur. Gerçek modül korunur,
// yalnızca `cache` geçersiz kılınır.
jest.mock('../lib/redisAdapter', () => ({
  ...jest.requireActual('../lib/redisAdapter'),
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined), get: async () => null, set: async () => undefined, del: async () => undefined },
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import semanticRouter from '../routes/semantic';

const app = express();
app.use(express.json());
app.use('/api/semantic', semanticRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const MEMBER = 'uye-1';
const SRV    = 'srv-S';
const PUBLIC_CH  = 'sch-acik';
const PRIVATE_CH = 'sch-gizli';

const VIEW_CHANNELS = 1 << 0;

/** Her iki kanalda geçen ortak arama terimi. */
const TERIM = 'projeplani';
/** ASLA sızmaması gereken özel kanal metni. */
const GIZLI_METIN = `GIZLI ${TERIM} sifresi 12345`;

beforeAll(async () => {
  await mockDb.users.insert({ _id: MEMBER, username: MEMBER, displayName: 'Uye' });
  await mockDb.users.insert({ _id: 'gizli-u', username: 'gizli-u', displayName: 'GizliKisi' });

  // Sahip BAŞKASI → üye, sahip kısayolundan değil gerçek üyelik yolundan geçer.
  await mockDb.servers.insert({ _id: SRV, name: 'S', ownerId: 'sahip-S', createdAt: 1 });
  await mockDb.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });

  await mockDb.channelOverrides.insert({
    _id: 'ovr-sem-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  const now = Date.now();
  await mockDb.messages.insert({
    _id: 'sm-acik', channelId: PUBLIC_CH, serverId: SRV, userId: MEMBER,
    content: `acik ${TERIM} notu`, type: 'normal', reactions: '{}', createdAt: now - 1000,
  });
  await mockDb.messages.insert({
    _id: 'sm-gizli', channelId: PRIVATE_CH, serverId: SRV, userId: 'gizli-u',
    content: GIZLI_METIN, type: 'normal', reactions: '{}', createdAt: now - 500,
  });
});

const semSearch = (user: string, query: string) =>
  request(app).post('/api/semantic/search')
    .set('Authorization', `Bearer ${tok(user)}`)
    .send({ query, serverId: SRV, days: 30 });

// ════════════════════════════════════════════════════════════════════════════
describe('SEMANTİK ARAMA — kanal görünürlüğü', () => {
  it('POZİTİF KONTROL: görünür kanaldaki eşleşme DÖNER', async () => {
    const res = await semSearch(MEMBER, TERIM);

    // Bu kontrol olmadan aşağıdaki sızıntı testleri, uç tümüyle bozuk olsa
    // (ör. her zaman boş dönse) da geçerdi.
    expect(res.status).toBe(200);
    const ids = (res.body.matches as Array<{ _id: string }>).map(m => m._id);
    expect(ids).toContain('sm-acik');
  });

  it('GÖRÜNMEYEN kanalın mesajı sonuçlarda YOKTUR', async () => {
    const res = await semSearch(MEMBER, TERIM);

    const ids = (res.body.matches as Array<{ _id: string }>).map(m => m._id);
    expect(ids).not.toContain('sm-gizli');
  });

  it('görünmeyen kanalın METNİ gövdenin hiçbir yerinde geçmez', async () => {
    // Asıl sızıntı vektörü tam `content` alanıydı; tüm gövde taranır
    // (açıklama/snippet gibi ikincil alanlar da dahil).
    const res = await semSearch(MEMBER, TERIM);

    expect(JSON.stringify(res.body)).not.toContain('sifresi 12345');
    expect(JSON.stringify(res.body)).not.toContain(GIZLI_METIN);
  });

  it('SIZINTI YAPILANDIRMADAN BAĞIMSIZ ENGELLENİR (pgvector/AI kapalı)', async () => {
    // Bu dağıtımda PGVECTOR_ENABLED ve AI_ENABLED false → keywordSearch yedeği
    // çalışır. Korumanın bir özellik bayrağına DEĞİL, izne bağlı olduğu kanıtlanır.
    const res = await semSearch(MEMBER, TERIM);

    expect(res.status).toBe(200);
    expect(['rules', 'none']).toContain(res.body.provider);   // yedek yol aktif
    expect(JSON.stringify(res.body)).not.toContain('sifresi 12345');
  });

  it('sunucu üyesi OLMAYAN reddedilir (403)', async () => {
    const res = await request(app).post('/api/semantic/search')
      .set('Authorization', `Bearer ${tok('yabanci-x')}`)
      .send({ query: TERIM, serverId: SRV, days: 30 });

    expect(res.status).toBe(403);
  });

  it('kimliksiz istek reddedilir (401)', async () => {
    const res = await request(app).post('/api/semantic/search').send({ query: TERIM, serverId: SRV });

    expect(res.status).toBe(401);
  });
});

describe('SEMANTİK DIGEST — kanal görünürlüğü', () => {
  const digest = (user: string) =>
    request(app).get(`/api/semantic/digest/${SRV}?days=30`).set('Authorization', `Bearer ${tok(user)}`);

  it('POZİTİF KONTROL: digest görünür kanal için üretilir', async () => {
    const res = await digest(MEMBER);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('genel');
  });

  it('görünmeyen kanal digest\'te YER ALMAZ', async () => {
    const res = await digest(MEMBER);

    const raw = JSON.stringify(res.body);
    // Kanal ADI ve İÇERİĞİ sızmamalı. ('gizli' düz araması fazla genişti:
    // `topUsers` içindeki `gizli-u` KULLANICI kimliğine de takılıyordu.)
    expect(raw).not.toContain('"channelName":"gizli"');
    expect(raw).not.toContain(GIZLI_METIN);
    expect(raw).not.toContain('sifresi 12345');
    // channelStats YALNIZ görülebilen kanalı içerir.
    const ids = (res.body.channelStats as Array<{ channelId: string }>).map(c => c.channelId);
    expect(ids).toEqual([PUBLIC_CH]);
  });
});

describe('SEMANTİK DIGEST/ENGAGEMENT — meta sızıntısı', () => {
  const digest = (user: string) =>
    request(app).get(`/api/semantic/digest/${SRV}?days=30`).set('Authorization', `Bearer ${tok(user)}`);
  const engagement = (user: string) =>
    request(app).get(`/api/semantic/engagement/${SRV}?days=30`).set('Authorization', `Bearer ${tok(user)}`);

  it('topUsers YALNIZ görülebilen kanallardan hesaplanır', async () => {
    // `gizli-u` SADECE özel kanala yazdı. Sıralamada görünmesi, o kullanıcının
    // görünmeyen bir kanaldaki etkinliğini ifşa ederdi.
    const res = await digest(MEMBER);

    const ids = (res.body.topUsers as Array<{ userId: string }>).map(u => u.userId);
    expect(ids).not.toContain('gizli-u');
  });

  it('POZITIF KONTROL: gorunur kanala yazan kullanici topUsers icinde VARDIR', async () => {
    const res = await digest(MEMBER);

    const ids = (res.body.topUsers as Array<{ userId: string }>).map(u => u.userId);
    expect(ids).toContain(MEMBER);
  });

  it('totalMessages görünmeyen kanalın mesajını SAYMAZ', async () => {
    const res = await digest(MEMBER);

    // Fikstürde 2 mesaj var: 1 açık + 1 gizli. Yalnız açık olan sayılmalı.
    expect(res.body.totalMessages).toBe(1);
  });

  it('engagement aktif kullanıcı sayısı görünmeyen kanaldan ETKİLENMEZ', async () => {
    const res = await engagement(MEMBER);

    expect(res.status).toBe(200);
    // Gercek govde: { serverId, periods: [{days, messages, activeUsers, ...}], ... }
    const periods = res.body.periods as Array<{ days: number; messages: number; activeUsers: number }>;
    expect(periods.length).toBeGreaterThan(0);
    // Fikstur: 1 acik + 1 gizli mesaj. Gizli olan HICBIR donemde sayilmamali.
    for (const p of periods) {
      expect(p.messages).toBe(1);
      expect(p.activeUsers).toBe(1);
    }
  });
});

describe('SEMANTİK — vektör sonuçları OKUMA ANINDA yeniden yetkilendirilir', () => {
  it('görünürlük filtresi pgvector dalından ÖNCE uygulanır', () => {
    // G12 gereği: embedding/indeks PROVENANSINA güvenilmez. Vektör araması
    // bayat gömmeler döndürebilir (mesaj silinmiş, kanal gizlenmiş, izin geri
    // alınmış). Bu yüzden vektör isabetleri, GÜNCEL izinlere göre filtrelenmiş
    // `messages` dizisinde ID ile aranır; dizide yoksa DÜŞER.
    //
    // Bu sıralama güvenliğin taşıyıcısıdır, bu yüzden kaynakta kilitlenir:
    // pgvector bu dağıtımda KAPALI olduğu icin davranışsal olarak çalıştırılamaz.
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, '../routes/semantic.ts'), 'utf8');

    const filterIdx  = src.indexOf('messages = messages.filter(m => viewable.has');
    const vectorIdx  = src.indexOf('if (PGVECTOR_ENABLED)');
    const lookupIdx  = src.indexOf('messages.find(m => m._id === vm.message_id)');

    expect(filterIdx).toBeGreaterThan(-1);
    expect(vectorIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeGreaterThan(-1);

    // Filtre ÖNCE gelmeli.
    expect(filterIdx).toBeLessThan(vectorIdx);
    // Vektör isabetleri FİLTRELENMİŞ diziden çözülmeli.
    expect(lookupIdx).toBeGreaterThan(filterIdx);
  });

  it('pgvector bu dağıtımda KAPALIDIR (varsayılan opt-in)', () => {
    // SEMANTIC_SEARCH = CONFIG_REQUIRED doğrulaması.
    expect(process.env.PGVECTOR_ENABLED === 'true').toBe(false);
  });
});
