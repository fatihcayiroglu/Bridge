// e2e/tests/e2e-environment-guard.spec.ts
//
// E2E ORTAM SÖZLEŞMESİ — SESSİZ GERİLEMEYİ ENGELLER
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Sunucu yalnızca IPv4 `127.0.0.1` üzerinde dinler. Harness `localhost`
// kullandığında Windows önce IPv6 `::1` adresini dener, bağlantı reddedilir
// ve her istek başarısız bir denemeyle başlar:
//
//     http://localhost:3000   connect = 0.211 s
//     http://127.0.0.1:3000   connect = 0.001 s      ← 211 kat
//
// Uygulama açılışı ~40 istek yapar; bu, açılışı ~27 saniyeye çıkarmış ve
// testlerin 25 sn'lik `#app` beklemesini aşmıştı. Düzeltmeden sonra açılış
// 374–802 ms.
//
// Bu dosya, ayarın sessizce `localhost`a geri dönmesini ENGELLER. Yalnızca
// belgeye güvenmek yeterli değildir — sözleşme çalıştırılabilir olmalıdır.

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('E2E ortam sözleşmesi', () => {
  test.use({ storageState: undefined });

  test('baseURL, sunucunun dinlediği ADRES AİLESİYLE hizalıdır', async ({ baseURL }) => {
    // KANITLAR   : yapılandırma IPv6 geri-düşme cezasına geri dönmemiş.
    // KANITLAMAZ : ağın genel sağlığını.
    expect(baseURL, 'baseURL tanımlı değil').toBeTruthy();
    const host = new URL(baseURL!).hostname;

    const launcher = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'e2e-server.js'), 'utf8',
    );
    const bound = launcher.match(/E2E_HOST \|\| '([^']+)'/)?.[1] ?? '';
    expect(bound, 'launcher HOST okunamadı').toBeTruthy();

    // Sunucu 127.0.0.1'e bağlanıyorsa harness `localhost` KULLANMAMALIDIR.
    if (bound === '127.0.0.1') {
      expect(host, 'baseURL `localhost` — IPv6 geri-düşme cezası geri geldi')
        .not.toBe('localhost');
    }
    expect(host).toBe(bound);
  });

  test('bağlantı kurulumu HIZLI — IPv6 geri düşmesi yok', async ({ request, baseURL }) => {
    // Gerçek ölçüm: art arda istekler toplamda dar bir bütçede kalmalı.
    // Geri düşme yaşansaydı istek başına ~210 ms eklenirdi.
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      const r = await request.get(`${baseURL}/api/health`);
      expect(r.ok()).toBe(true);
    }
    const perRequest = (Date.now() - t0) / 5;
    // 150 ms eşiği ölçüme dayanır: sağlıklı yol ~1-5 ms, bozuk yol ~211 ms.
    expect(perRequest, `istek başına ${Math.round(perRequest)} ms — IPv6 geri düşmesi olabilir`)
      .toBeLessThan(150);
  });

  test('sunucu YENİDEN ÜRETİLEBİLİR biçimde başlatılır', async () => {
    // Elle başlatılmış gizemli bir sürece bağımlılık kalmamalı.
    const cfg = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.ts'), 'utf8');
    expect(cfg, 'webServer launcher kullanmıyor').toMatch(/scripts\/e2e-server\.js/);
    // `NODE_ENV: 'test'` derlenmiş sunucuda mock DB yükleyip çıkıyordu.
    const ws = cfg.slice(cfg.indexOf('webServer:'));
    expect(ws, "webServer NODE_ENV='test' kullanmamalı").not.toMatch(/NODE_ENV:\s*'test'/);
  });

  test('launcher joker (wildcard) CORS kullanmaz', async () => {
    const launcher = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'e2e-server.js'), 'utf8',
    );
    expect(launcher).toMatch(/ALLOWED_ORIGINS/);
    expect(launcher, 'joker origin').not.toMatch(/ALLOWED_ORIGINS[^\n]*['"]\*['"]/);
  });

  test('federasyon kimliği, bind adresi ve WebAuthn RP kaynağı birbirine karışmaz', async () => {
    const launcher = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'e2e-server.js'), 'utf8',
    );
    const passkeySpec = fs.readFileSync(
      path.join(__dirname, 'webauthn-virtual.spec.ts'), 'utf8',
    );

    // Genel E2E/federasyon yolu hızlı IPv4 kimliğini kullanır.
    expect(launcher).toMatch(/E2E_HOST \|\| '127\.0\.0\.1'/);
    expect(launcher).toMatch(/INSTANCE_URL:\s*process\.env\.E2E_INSTANCE_URL \|\| ORIGIN/);
    // Passkey yolu ise rpId=localhost ile eşleşen TAM kaynağı açıkça seçer.
    expect(launcher).toMatch(/E2E_WEBAUTHN_RP_ID \|\| 'localhost'/);
    expect(launcher).toMatch(/E2E_WEBAUTHN_ORIGIN \|\| `http:\/\/localhost:\$\{PORT\}`/);
    expect(passkeySpec).toMatch(/E2E_WEBAUTHN_ORIGIN/);
    expect(passkeySpec).not.toMatch(/process\.env\.E2E_HOST/);

    // CORS iki yazımı da TAM listeyle taşır; bu, WebAuthn'da 127'yi localhost
    // RP'si gibi kabul etmek anlamına gelmez.
    expect(launcher).toContain('`http://127.0.0.1:${PORT}`');
    expect(launcher).toContain('`http://localhost:${PORT}`');
    expect(launcher).not.toMatch(/WEBAUTHN_(?:RP_ID|ORIGIN)[^\n]*\*/);
  });
});
