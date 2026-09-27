// server/tests/twofactor-rate-limit.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// 2FA HIZ SINIRI — KAYIP OLAN KANIT
// ════════════════════════════════════════════════════════════════════════════
// `/api/2fa/check` bir 2FA kodunu doğrular ve BAŞARISIZ denemeler ucuzdur.
// Sınır olmadan 6 haneli TOTP kod uzayı (10^6) çevrimiçi kaba kuvvetle
// erişilebilir hâle gelir; yedek kodlar için de aynı yüzey açılır.
//
// ── BU DOSYA NEDEN EKLENDİ ─────────────────────────────────────────────────
// İki 2FA suite'i (`twofactor-regenerate`, `twofactor-backup-codes`) kendi
// ölçümlerini yapabilmek için `RL_2FA_MAX` değerini yükseltiyor. İkisinin de
// yorumu "sınırın kendisi ayrıca brute-force testiyle korunmaktadır" diyordu
// ama BÖYLE BİR TEST YOKTU — atıf yapılan `2fa.spec.ts` dosyası mevcut değil.
// Yani sınır iki yerde bilinçli olarak devre dışı bırakılmış, hiçbir yerde
// kanıtlanmamıştı: `limits.twoFactor()` bir rotadan tamamen kaldırılsa hiçbir
// test düşmezdi.
//
// Bu dosya sınırı ÜRETİM DEĞERİYLE (5 istek / pencere) çalıştırır ve gerçekten
// engellediğini ölçer.

process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-jwt-secret-key-do-not-use-in-production';
process.env.REFRESH_SECRET = 'test-refresh-secret-key-do-not-use-in-production-32chars';

// Üretim varsayılanı zaten 5'tir; AÇIKÇA yazılır ki bu testin neyi ölçtüğü
// başka bir suite'in ortam sızıntısına bağlı kalmasın.
process.env.RL_2FA_MAX = '5';
process.env.RL_2FA_WIN = '300000';

import express from 'express';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));

const request = require('supertest');
import db from '../db/loader';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';
import { issueTwoFactorLoginChallenge } from '../lib/twoFactorLoginChallenge';
import { requireDoc } from './helpers/mockDb';
import twoFactorRouter, {
  __hashBackupCodeForTest as hashBackupCode,
} from '../routes/twoFactor';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/2fa', twoFactorRouter);
  return app;
}

const MAX = 5;

describe('POST /api/2fa/check — hız sınırı GERÇEKTEN uygulanır', () => {
  let app: ReturnType<typeof buildApp>;
  let tempToken: string;
  let userId: string;

  beforeEach(async () => {
    // Sayac SURECI paylasir: sifirlanmazsa bir onceki test bu testin kotasini
    // tuketmis olur ve iddia yanlislikla 429 gorur.
    _resetRateLimitStoreForTest();
    db._reset?.();
    app = buildApp();
    userId = uuidv4();
    await db.users.insert({
      _id: userId, username: `u-${userId.slice(0, 8)}`, tokenVersion: 0,
      twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      twoFactorBackup: JSON.stringify([hashBackupCode('a1b2c3d4e5f60718')]),
    });
    tempToken = await issueTwoFactorLoginChallenge(userId, 0);
  });

  it(`${MAX} YANLIŞ denemeden sonra 429 döner`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i < MAX + 2; i++) {
      const r = await request(app).post('/api/2fa/check').send({ tempToken, code: '000000' });
      statuses.push(r.status);
    }

    // İlk MAX istek sınıra takılmamalı (401 = yanlış kod, doğru davranış).
    expect(statuses.slice(0, MAX).every(s => s !== 429)).toBe(true);
    // Sonrasında sınır DEVREYE GİRMELİ.
    expect(statuses.slice(MAX)).toEqual([429, 429]);
  });

  it('sınır aşıldıktan sonra DOĞRU kod bile kabul edilmez', async () => {
    // En önemli iddia: sınır yalnızca "gürültüyü azaltan" bir sayaç değil,
    // gerçek bir kapıdır. Aksi hâlde saldırgan 429'ları yok sayıp denemeye
    // devam edebilir ve sınır kâğıt üstünde kalırdı.
    for (let i = 0; i < MAX; i++) {
      await request(app).post('/api/2fa/check').send({ tempToken, code: '000000' });
    }

    const r = await request(app)
      .post('/api/2fa/check')
      .send({ tempToken, code: 'a1b2c3d4e5f60718' });

    expect(r.status).toBe(429);
    // Yedek kod TÜKETİLMEMİŞ olmalı: reddedilen istek yan etkisizdir.
    const kalan = JSON.parse(String((await requireDoc(db.users, { _id: userId })).twoFactorBackup));
    expect(kalan).toEqual([hashBackupCode('a1b2c3d4e5f60718')]);
  });

  it('YANLIŞ POZİTİF KONTROLÜ: sınır altındaki geçerli yedek kod 200 döner', async () => {
    // Ayrım: yukarıdaki iddialar "her istek 429" durumunda da geçerdi.
    const r = await request(app)
      .post('/api/2fa/check')
      .send({ tempToken, code: 'a1b2c3d4e5f60718' });

    expect(r.status).toBe(200);
    expect(r.body.usedBackup).toBe(true);
  });
});
