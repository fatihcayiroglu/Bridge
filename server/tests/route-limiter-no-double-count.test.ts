// server/tests/route-limiter-no-double-count.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BİR İSTEK KÜRESEL BÜTÇEDEN BİR KEZ DÜŞMELİ (Final21 — Faz 11'de gözlendi, Faz 19'da kapatıldı)
// ════════════════════════════════════════════════════════════════════════════
// `limits.general()` rota düzeyinde, uygulama çapındaki `/api` sınırlayıcısıyla AYNI `global`
// önekini kullanan ikinci bir sınırlayıcı kuruyordu. Altı rota (pazaryeri listeleri, okundu
// işareti `POST /api/channels/:cid/read`, okunmamış yoklaması
// `GET /api/notification-prefs/unread-channels`) her istekte küresel sayaca İKİ kez yazıyordu:
// etkin sınır yarıya iniyor ve en sık çağrılan iki uç kişinin TÜM /api bütçesini iki kat
// hızla tüketiyordu.
//
// Bu test üretim bileşimini kurar — gerçek `createApp` (küresel sınırlayıcı) + gerçek
// pazaryeri yönlendiricisi, gerçek `middleware/rateLimit` — ve bütçenin istek başına
// tam BİR azaldığını ölçer.

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
process.env.JWT_SECRET      = 'test-jwt-secret-no-double-countxx'.padEnd(64, 'x');
process.env.REFRESH_SECRET  = 'test-refresh-secret-no-double-count'.padEnd(64, 'y');
process.env.NODE_ENV        = 'test';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.RL_GLOBAL_MAX   = '4';
delete process.env.REDIS_URL;

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import { createApp } from '../app/createApp';
import botMarketplaceRouter from '../routes/bot-marketplace';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';

afterAll(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

function app() {
  const built = createApp().app;
  built.use('/api/bots/marketplace', botMarketplaceRouter);
  return built;
}

describe('route limiters do not charge the global /api budget twice', () => {
  beforeEach(() => _resetRateLimitStoreForTest());

  it('RL_GLOBAL_MAX=4 allows exactly 4 requests to a marketplace route, not 2', async () => {
    const a = app();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(a).get('/api/bots/marketplace/categories')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it('the first request leaves 3 of 4 — one unit per request', async () => {
    const res = await request(app()).get('/api/bots/marketplace/categories');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-remaining']).toBe('3');
  });
});
