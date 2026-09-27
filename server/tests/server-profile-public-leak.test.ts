// server/tests/server-profile-public-leak.test.ts
// FAZ G — KAMUYA AÇIK VANITY SAYFASINDA ÖZEL KANAL ADI SIZINTISI.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `GET /s/:slug` (serverProfile) KİMLİK DOĞRULAMASIZ bir HTML landing
// sayfasıdır — hesabı olmayan herkes görebilir; bu kasıtlıdır.
//
// Ancak sayfa, sunucunun TÜM metin kanallarını (ilk 8) ADI ve KONUSU ile
// yayınlıyordu:
//
//     Channels.findWhere({ serverId, type: 'text' })   // görünürlük filtresi YOK
//
// Yani bir sunucu vanity URL açtığında, ÖZEL kanallarının adları ve konuları
// da internete açılıyordu. Faz G tehdit modeli için en geniş maruziyet biçimi:
// saldırganın hesap açmasına bile gerek yok.
//
// Kimlik olmadığı için "görünür" ölçütü @everyone'dır: @everyone için
// VIEW_CHANNELS reddedilmiş kanal kamuya açık sayılmaz.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
const mockGetLiveVanityServer = jest.fn((slug: string) => mockDb.servers.findOne({ vanityUrl: slug }));

jest.mock('../db/index', () => mockDb);
jest.mock('../db/repositories/BoostRepository.js', () => ({
  Boosts: { getLiveVanityServer: mockGetLiveVanityServer },
}));
jest.mock('../db/loader', () => require('../db/index'));

import request from 'supertest';
import express from 'express';

import serverProfileRouter from '../routes/serverProfile';

const app = express();
app.use(express.json());
// ÜRETİMDEKİ gibi: kamuya açık yüzey `/s`, API yüzeyi değil.
app.use('/s', serverProfileRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const SRV  = 'srv-V';
const SLUG = 'acik-topluluk';

const ACIK_KANAL  = 'genel-sohbet';
const GIZLI_KANAL = 'yonetim-gizli';
const GIZLI_KONU  = 'ic-yazismalar-gizli-konu';

const VIEW_CHANNELS = 1 << 0;

beforeAll(async () => {
  await mockDb.servers.insert({
    _id: SRV, name: 'Acik Topluluk', ownerId: 'sahip-V',
    vanityUrl: SLUG, description: 'aciklama', createdAt: 1,
  });

  await mockDb.channels.insert({
    _id: 'vch-acik', serverId: SRV, name: ACIK_KANAL, type: 'text', createdAt: 1,
  });
  await mockDb.channels.insert({
    _id: 'vch-gizli', serverId: SRV, name: GIZLI_KANAL, type: 'text',
    topic: GIZLI_KONU, createdAt: 1,
  });

  // GİZLİ kanal: @everyone için VIEW_CHANNELS açıkça REDDEDİLİR.
  await mockDb.channelOverrides.insert({
    _id: 'ovr-vanity-1', channelId: 'vch-gizli', targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });
});

const page = () => request(app).get(`/s/${SLUG}`);

// ════════════════════════════════════════════════════════════════════════════
describe('VANITY SAYFASI — özel kanal adları sızmaz', () => {
  it('POZİTİF KONTROL: sayfa kimliksiz servis edilir ve AÇIK kanalı listeler', async () => {
    const res = await page();

    // Bu kontrol olmadan aşağıdaki testler, sayfa tümüyle bozulsa (ör. hep
    // 404 dönse) da geçerdi.
    expect(res.status).toBe(200);
    expect(res.text).toContain(ACIK_KANAL);
  });

  it('ÖZEL kanalın ADI sayfada GEÇMEZ', async () => {
    const res = await page();

    expect(res.text).not.toContain(GIZLI_KANAL);
  });

  it('ÖZEL kanalın KONUSU sayfada GEÇMEZ', async () => {
    const res = await page();

    expect(res.text).not.toContain(GIZLI_KONU);
  });

  it('var olmayan slug 404 döner (varlık ifşa etmez)', async () => {
    const res = await request(app).get('/s/boyle-bir-slug-yok');

    expect(res.status).toBe(404);
  });
});
