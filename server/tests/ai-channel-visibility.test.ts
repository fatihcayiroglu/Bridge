// server/tests/ai-channel-visibility.test.ts
// FAZ F — AI UÇLARINDA KANAL GÖRÜNÜRLÜĞÜ (VIEW_CHANNELS).
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `GET /api/ai/:channelId` (özet) ve `GET /api/ai/suggest-reply/:channelId`
// yalnızca SUNUCU ÜYELİĞİNİ denetliyordu. Sunucu üyeliği kanal görünürlüğü
// DEĞİLDİR: özel bir kanal aynı sunucunun üyesine de kapalı olabilir.
//
// Bu, Faz D'de `search.ts` içinde bulunup düzeltilen kusurun AYNI SINIFIDIR.
//
// EN ÖNEMLİSİ — SIZINTI AI'A BAĞLI DEĞİLDİ:
// Sağlayıcı yapılandırılmamışken (bu dağıtımda GROQ/GEMINI/OPENROUTER/OLLAMA
// anahtarlarının HİÇBİRİ yok) özet ucu `rulesSummary` yedeğine düşer ve yine
// de şunları döndürür: KATILIMCI ADLARI, en aktif kullanıcı ve mesaj sayısı,
// toplam mesaj sayısı, ilk/son zaman damgaları, link sayısı.
//
// Yani görmeye yetkisi olmayan bir üye, özel kanalı PROFİLLEYEBİLİYORDU —
// hiçbir AI anahtarı gerekmeden, bugün, canlı olarak.
//
// POZİTİF KONTROL KURALI: her "engellenmeli" iddiasının yanında, aynı akışın
// yetkili kullanıcı için GERÇEKTEN çalıştığını gösteren bir kontrol vardır.
// Hiçbir şey olmadığı için geçen test kanıt sayılmaz.

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

// Önbellek devre dışı: önbelleğe alınmış bir yanıt, izin denetimini
// ATLATARAK ikinci çağrıda içerik döndürebilirdi. Testler her seferinde
// GERÇEK rota yolunu ölçmelidir.
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined), get: async () => null, set: async () => undefined, del: async () => undefined },
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import summarizeRouter from '../routes/ai/summarize';

const app = express();
app.use(express.json());
app.use('/api/ai', summarizeRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const MEMBER   = 'uye-1';
const OUTSIDER = 'yabanci-1';
const SRV_A    = 'srv-A';

const PUBLIC_CH  = 'ch-acik';
const PRIVATE_CH = 'ch-gizli';

const VIEW_CHANNELS = 1 << 0;

/** Özel kanalda geçen, ASLA sızmaması gereken katılımcı adı. */
const GIZLI_KATILIMCI = 'GizliKatilimci';

beforeAll(async () => {
  await mockDb.users.insert({ _id: MEMBER,   username: MEMBER,   displayName: 'Uye' });
  await mockDb.users.insert({ _id: OUTSIDER, username: OUTSIDER, displayName: 'Yabanci' });
  await mockDb.users.insert({ _id: 'gizli-u', username: 'gizli-u', displayName: GIZLI_KATILIMCI });

  // Sahip BAŞKASI: üye, sahip kısayolundan değil GERÇEK üyelik yolundan geçer.
  await mockDb.servers.insert({ _id: SRV_A, name: 'A', ownerId: 'sahip-A', createdAt: 1 });
  await mockDb.members.insert({ userId: MEMBER, serverId: SRV_A, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV_A, name: 'genel', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV_A, name: 'gizli', type: 'text', createdAt: 1 });

  // GİZLİ kanal: @everyone için VIEW_CHANNELS açıkça REDDEDİLİR.
  await mockDb.channelOverrides.insert({
    _id: 'ovr-ai-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV_A,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  await mockDb.messages.insert({
    _id: 'ai-m-acik', channelId: PUBLIC_CH, serverId: SRV_A, userId: MEMBER,
    content: 'acik kanal mesaji', type: 'normal', reactions: {}, createdAt: 1000,
  });
  await mockDb.messages.insert({
    _id: 'ai-m-gizli', channelId: PRIVATE_CH, serverId: SRV_A, userId: 'gizli-u',
    content: 'gizli kanal icerigi https://ornek.test', type: 'normal', reactions: {}, createdAt: 2000,
  });
});

const summarize = (user: string, channelId: string) =>
  request(app).get(`/api/ai/${channelId}`).set('Authorization', `Bearer ${tok(user)}`);

// ════════════════════════════════════════════════════════════════════════════
describe('AI özet — kanal görünürlüğü (VIEW_CHANNELS)', () => {
  it('POZİTİF KONTROL: görünür kanal özetlenebilir', async () => {
    const res = await summarize(MEMBER, PUBLIC_CH);

    // Bu kontrol olmadan aşağıdaki 403 testleri, akış tümüyle bozuk olsa da
    // geçerdi. Yetkili yolun GERÇEKTEN çalıştığı burada kanıtlanır.
    expect(res.status).toBe(200);
    expect(typeof res.body.summary).toBe('string');
    expect(res.body.summary.length).toBeGreaterThan(0);
    expect(res.body.messageCount).toBe(1);
  });

  it('GÖRÜNMEYEN kanal özetlenemez (403)', async () => {
    const res = await summarize(MEMBER, PRIVATE_CH);

    expect(res.status).toBe(403);
  });

  it('görünmeyen kanalın KATILIMCI ADI sızmaz', async () => {
    // Asıl sızıntı vektörü: `rulesSummary` katılımcı adlarını ve en aktif
    // kullanıcıyı döndürüyordu. Gövdenin tamamı taranır.
    const res = await summarize(MEMBER, PRIVATE_CH);

    expect(JSON.stringify(res.body)).not.toContain(GIZLI_KATILIMCI);
  });

  it('görünmeyen kanalın META verisi sızmaz (sayı/zaman damgası)', async () => {
    const res = await summarize(MEMBER, PRIVATE_CH);

    expect(res.body.messageCount).toBeUndefined();
    expect(res.body.participants).toBeUndefined();
    expect(res.body.from).toBeUndefined();
    expect(res.body.to).toBeUndefined();
  });

  it('sunucu ÜYESİ OLMAYAN erişemez (403)', async () => {
    const res = await summarize(OUTSIDER, PUBLIC_CH);

    expect(res.status).toBe(403);
  });

  it('kimliksiz istek reddedilir (401)', async () => {
    const res = await request(app).get(`/api/ai/${PUBLIC_CH}`);

    expect(res.status).toBe(401);
  });

  it('var olmayan kanal 404 döner (403 ile karıştırılmaz)', async () => {
    const res = await summarize(MEMBER, 'yok-boyle-kanal');

    expect(res.status).toBe(404);
  });

  it('SIZINTI AI\'DAN BAĞIMSIZDIR: sağlayıcı kapalıyken de engellenir', async () => {
    // Bu dağıtımda hiçbir AI anahtarı yok → AI_ENABLED false → `rulesSummary`
    // yedeği çalışır. Korumanın AI bayrağına DEĞİL, izne bağlı olduğu kanıtlanır.
    const acik = await summarize(MEMBER, PUBLIC_CH);
    expect(acik.body.provider).toBe('rules');   // yedek yol gerçekten aktif

    const gizli = await summarize(MEMBER, PRIVATE_CH);
    expect(gizli.status).toBe(403);
  });
});
