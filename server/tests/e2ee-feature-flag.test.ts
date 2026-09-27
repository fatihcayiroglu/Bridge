// server/tests/e2ee-feature-flag.test.ts
// FAZ D0 — E2EE ÖZELLİK BAYRAĞI VARSAYILAN OLARAK KAPALIDIR.
//
// ════════════════════════════════════════════════════════════════════════════
// DÜZELTİLEN GERÇEK SORUN
// ════════════════════════════════════════════════════════════════════════════
// Bayrak Sprint 115'te varsayılan AÇIK yapılmıştı:
//     enabled: process.env.BRIDGE_E2EE_ENABLED !== 'false'
// Oysa ölçülen gerçek şuydu:
//   · istemcide `crypto.subtle` / anahtar üretimi YOK,
//   · istemci `encryptedContent` veya `type:'e2ee'` ÜRETMİYOR,
//   · sunucudaki anahtar değişim olaylarını çağıran istemci dosyası YOK,
//   · cihaz kimliği / anahtar dağıtımı için tablo YOK,
//   · mesajlar düz metin `content` olarak saklanıyor.
//
// Yani bayrak açıkken ürün, karşılığı olmayan bir güvenlik güvencesi
// verebiliyordu. Eksik bir özellikten farklı olarak bu YANILTICIDIR.
// Durum: E2EE = ARCHITECTURE_REQUIRED — açık rıza (`=== 'true'`) gerekir.
//
// Arka uç iskelesi (rotalar, anahtar değişim olayları, encryptedContent/iv,
// migration'lar) KASITLI olarak korunur ve bu test onları KALDIRMAZ.

process.env.NODE_ENV = 'test';

import request from 'supertest';
import express from 'express';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    write: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    api:   (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const ORIGINAL = process.env.BRIDGE_E2EE_ENABLED;

/** Bayrak modül yüklenme anında değil, istek anında okunur (router içi). */
function buildApp() {
  jest.resetModules();
  const { router } = require('../lib/e2e');
  const app = express();
  app.use(express.json());
  app.use('/api/e2e', router);
  return app;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BRIDGE_E2EE_ENABLED;
  else process.env.BRIDGE_E2EE_ENABLED = ORIGINAL;
});

describe('D0 — GET /api/e2e/feature-status', () => {
  it('GÜVENLİK: bayrak TANIMSIZken KAPALI döner (varsayılan kapalı)', async () => {
    delete process.env.BRIDGE_E2EE_ENABLED;

    const res = await request(buildApp()).get('/api/e2e/feature-status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('GÜVENLİK: "false" DIŞINDAKİ gelişigüzel değerler AÇMAZ', async () => {
    // Eski sözleşme `!== 'false'` idi: "0", "off", "" gibi her değer AÇIK
    // sayılıyordu. Açık rıza artık tam olarak "true" demektir.
    for (const v of ['0', 'off', 'no', '', 'TRUE', 'yes', 'enabled']) {
      process.env.BRIDGE_E2EE_ENABLED = v;

      const res = await request(buildApp()).get('/api/e2e/feature-status');

      expect(res.body).toEqual({ enabled: false });
    }
    // ZAMAN BUTCESI: bu test uygulamayi YEDI KEZ kurar; kardeslerinin hepsi
    // bir kez kurar. Varsayilan 10 sn butcesini paylasmasi, tam paket 8
    // worker ile kosarken (tek basina ~4 sn, cekismeli kosuda ~20 sn)
    // ARALIKLI bir timeout uretiyordu -- urun kusuru degil, yanlis
    // butcelenmis bir test. Butce yapilan ise oranli verilir.
  }, 60_000);

  it('yalnız açık rıza ("true") ile AÇILIR', async () => {
    process.env.BRIDGE_E2EE_ENABLED = 'true';

    const res = await request(buildApp()).get('/api/e2e/feature-status');

    expect(res.body).toEqual({ enabled: true });
  });

  it('açıkça "false" verildiğinde KAPALI kalır', async () => {
    process.env.BRIDGE_E2EE_ENABLED = 'false';

    const res = await request(buildApp()).get('/api/e2e/feature-status');

    expect(res.body).toEqual({ enabled: false });
  });
});

describe('D0 — soket katmanı ile arayüz AYNI şeyi söyler', () => {
  it('GÜVENLİK: soket bayrağı da varsayılan KAPALIdır', () => {
    delete process.env.BRIDGE_E2EE_ENABLED;
    jest.resetModules();

    const { isE2EEProductionEnabled } = require('../socket/handlers/channelE2EEHandlers');

    expect(isE2EEProductionEnabled()).toBe(false);
  });

  it('açık rıza ile soket bayrağı da açılır (iki katman ayrışmaz)', () => {
    process.env.BRIDGE_E2EE_ENABLED = 'true';
    jest.resetModules();

    const { isE2EEProductionEnabled } = require('../socket/handlers/channelE2EEHandlers');

    expect(isE2EEProductionEnabled()).toBe(true);
  });
});

describe('D0 — arka uç iskelesi KORUNUR', () => {
  it('anahtar değişim rotaları hâlâ mevcuttur (mimari silinmedi)', () => {
    jest.resetModules();
    const { router } = require('../lib/e2e');

    const paths = (router.stack as Array<{ route?: { path: string } }>)
      .filter(l => l.route)
      .map(l => l.route!.path);

    expect(paths).toContain('/feature-status');
    expect(paths.length).toBeGreaterThan(1);
  });
});
