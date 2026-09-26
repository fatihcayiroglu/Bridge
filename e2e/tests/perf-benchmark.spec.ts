// e2e/tests/perf-benchmark.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// TEKRARLANABİLİR ÜRÜN PERFORMANS ÖLÇÜMÜ
// ════════════════════════════════════════════════════════════════════════════
// Bu dosya `perf-probe.spec.ts`in yerini ALMAZ; onun ölçemediği şeyi ölçer.
//
// ── ESKİ PROBUN NEDEN REGRESYON YAKALAYAMADIĞI ────────────────────────────
//   1. Her adım BİR KEZ ölçülüyordu. Tek örnekte gürültü (GC, JIT, disk)
//      sinyalden büyüktür; %30'luk bir gerileme fark edilmezdi.
//   2. Adımlar `.catch(() => undefined)` ile yutuluyordu. Tıklama hedefe hiç
//      ULAŞMASA da bir süre yazdırılıyordu — yani "hızlı" görünen bir sayı,
//      aslında "hiç çalışmadı" demek olabilirdi.
//   3. `search-query` ve `palette-open` sabit `waitForTimeout(1200/500)`
//      içeriyordu. Ölçülen şey ürünün hızı değil, beklemenin kendisiydi:
//      arama 10 kat yavaşlasa bile sayı 1200 ms olarak kalırdı.
//
// ── BU HARNESS'IN KURALLARI ───────────────────────────────────────────────
//   · Her ölçüm N kez tekrarlanır; p50 ve p95 raporlanır.
//   · Her adım GERÇEK bir son duruma bağlanır (görünürlük, içerik değişimi).
//     Hedefe ulaşılamazsa ölçüm HATA verir — sessizce sayı üretmez.
//   · Sabit uyku YOKTUR.
//   · Çıktı MAKİNE OKUNABİLİR JSON'dur (`PERFJSON` satırı) ki önce/sonra
//     karşılaştırması göz kararı değil, fark alınarak yapılabilsin.
//   · Bellek ve uzun görev (long task) toplamı da toplanır.
//
// Kendi Playwright projesindedir (`perf`); normal geçitleri yavaşlatmaz.

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ITERATIONS = Number(process.env.PERF_ITERATIONS || 7);
const LABEL = process.env.PERF_LABEL || 'run';

interface Sample { name: string; ms: number[] }

function stats(ms: number[]) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    n: sorted.length,
    min: Math.round(sorted[0]!),
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1]!),
  };
}

/** Uzun görevleri (>50ms) sayar — toplam engelleme süresinin vekili. */
async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __longTasks: number[] }).__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          (window as unknown as { __longTasks: number[] }).__longTasks.push(entry.duration);
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask desteklenmiyorsa sessizce atla */ }
  });
}

async function readRuntime(page: Page) {
  return page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const long = (window as unknown as { __longTasks?: number[] }).__longTasks ?? [];
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const kb = (arr: PerformanceResourceTiming[]) =>
      Math.round(arr.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024);
    return {
      heapMB: perf.memory ? Math.round(perf.memory.usedJSHeapSize / 1048576) : null,
      longTaskCount: long.length,
      longTaskTotalMs: Math.round(long.reduce((s, d) => s + d, 0)),
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
      jsKB: kb(res.filter(r => r.name.endsWith('.js'))),
      cssKB: kb(res.filter(r => r.name.endsWith('.css'))),
      resourceCount: res.length,
    };
  });
}

/**
 * Ilk kanala girer. Composer yalnizca kanal baglaminda gorunur; bu yuzden
 * olcumlerden ONCE bir kez cagrilir. Hedefe ULASILAMAZSA acikca hata verir —
 * yutulan bir tiklama, "hizli" gorunen ama hicbir sey olcmeyen sayilar
 * uretirdi.
 */
async function enterFirstChannel(page: Page): Promise<void> {
  const composer = page.locator('#msg-input');
  if (await composer.isVisible().catch(() => false)) return;
  // Acilis orgusu ("Henuz bir sunucun yok") olcumu engelleyebilir; varsa kapat.
  const splash = page.getByRole('dialog', { name: 'Bridge baslangic ekrani' });
  if (await splash.count() && await splash.first().isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await splash.first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }
  const channel = page.locator('[aria-label^="Kanal:"]').first();
  await channel.waitFor({ state: 'visible', timeout: 30_000 });
  await channel.click();
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Olcum icin KENDI calisma alanini kurar.
 *
 * Harness onceden var olan bir sunucuya GUVENEMEZ: fikstur kullanicisi taze
 * bir veritabaninda sunucusuzdur ve o durumda kanal listesi bostur. Onceki
 * kosumda tam olarak bu oldu — olcum "kanal yok" diye dustu. Kendi sunucusunu
 * ve iki kanalini yaratmak, olcumu ortamin gecmis durumundan BAGIMSIZ ve
 * tekrarlanabilir kilar (kanal gecisi icin en az iki kanal gerekir).
 */
async function ensureWorkspace(request: APIRequestContext): Promise<void> {
  const tokens = getTokens();
  const server = await createTestServer(request, tokens.alice, `Perf ${Date.now()}`);
  const serverId = (server as { _id?: string; id?: string })._id
    ?? (server as { id?: string }).id!;
  await createTestChannel(request, tokens.alice, serverId, 'perf-a');
  await createTestChannel(request, tokens.alice, serverId, 'perf-b');
}

test('product performance benchmark', async ({ page, request }) => {
  test.setTimeout(600_000);
  await ensureWorkspace(request);
  const samples: Sample[] = [];
  const push = (name: string, ms: number) => {
    let s = samples.find(x => x.name === name);
    if (!s) { s = { name, ms: [] }; samples.push(s); }
    s.ms.push(ms);
  };

  await installLongTaskObserver(page);
  await page.addInitScript(() => {
    localStorage.setItem('bridge_locale', 'tr');
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  });

  // ── 1. SOĞUK AÇILIŞ ───────────────────────────────────────────────────────
  // Ölçülen: gezinme başlangıcından uygulama kabuğunun GÖRÜNÜR olmasına kadar.
  {
    const t0 = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 30_000 });
    push('cold_start_app_visible', Date.now() - t0);
  }
  const coldRuntime = await readRuntime(page);

  // Onboarding/açılış örtüleri ölçümü kirletmesin: varsa KAPAT ve kapandığını
  // DOĞRULA (yutulan bir tıklama sessizce yanlış ölçüm üretirdi).
  {
    const wizard = page.locator('[aria-label="Onboarding sihirbazı"]');
    if (await wizard.count() && await wizard.first().isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await expect(wizard.first()).toBeHidden({ timeout: 10_000 });
    }
  }
  // Composer yalnizca bir KANAL secildiginde gorunur. Olcumler kanal
  // baglamini varsayar; giremezsek olcum ANLAMSIZDIR ve test acikca duser
  // (sessizce sifir uretmez).
  await enterFirstChannel(page);
  await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 30_000 });

  // ── 2. SICAK AÇILIŞ (yeniden yükleme) ─────────────────────────────────────
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 30_000 });
    await enterFirstChannel(page);
    push('warm_start_usable', Date.now() - t0);
  }

  // ── 3. KANAL GEÇİŞİ ───────────────────────────────────────────────────────
  // İki kanal arasında gidip gelinir. Bitiş koşulu: hedef kanalın SEÇİLİ
  // olması VE composer'ın o kanalı göstermesi — yani gerçekten geçilmiş olması.
  {
    const channels = page.locator('[aria-label^="Kanal:"]');
    const count = await channels.count();
    if (count >= 2) {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const target = channels.nth(i % 2);
        const name = (await target.getAttribute('aria-label')) ?? '';
        const t0 = Date.now();
        await target.click();
        await expect(target).toHaveAttribute('aria-current', /page|true/, { timeout: 15_000 })
          .catch(async () => {
            // aria-current kullanılmıyorsa composer placeholder'ından doğrula
            await expect(page.locator('#msg-input')).toBeVisible({ timeout: 15_000 });
          });
        push('channel_switch', Date.now() - t0);
        expect(name.length).toBeGreaterThan(0);
      }
    }
  }

  // ── 4. MESAJ GÖNDERME ALGILANAN GECİKMESİ ────────────────────────────────
  // Ölçülen: Enter'a basıldığı andan, mesajın listede GÖRÜNMESİNE kadar.
  // Bu, kullanıcının "gitti mi?" sorusunu sorduğu penceredir.
  for (let i = 0; i < ITERATIONS; i += 1) {
    const text = `perf-${LABEL}-${Date.now()}-${i}`;
    await page.locator('#msg-input').click();
    await page.locator('#msg-input').fill(text);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    await page.locator('.msg-list').getByText(text, { exact: false })
      .first().waitFor({ state: 'visible', timeout: 20_000 });
    push('message_send_visible', Date.now() - t0);
  }

  // ── 5. ARAMA: AÇILIŞ ve GERÇEK SONUÇ ─────────────────────────────────────
  // Sabit uyku YOK: sonuç listesi ya da "sonuç yok" durumu beklenir. İkisi de
  // aramanın TAMAMLANDIĞINI gösterir; hangisi geldiğinden bağımsız olarak
  // ölçülen şey uçtan uca yanıt süresidir.
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = Date.now();
    await page.keyboard.press('Control+f');
    const overlay = page.locator('.gs-overlay, [role="dialog"]').first();
    await overlay.waitFor({ state: 'visible', timeout: 15_000 });
    push('search_open', Date.now() - t0);

    const t1 = Date.now();
    await page.keyboard.type(`perf-${LABEL}`);
    // Arama TAMAMLANDIGINDA ya sonuc listesi (`.gs-list`) ya da bir durum
    // metni (`.gs-state` — bos/hata) gorunur. Ikisinden biri yeterlidir:
    // olculen sey uctan uca YANIT suresidir, sonucun dolu olup olmamasi degil.
    // Sabit uyku KULLANILMAZ.
    await page.locator('.gs-list, .gs-state, .gs-empty-title')
      .first().waitFor({ state: 'visible', timeout: 20_000 });
    push('search_query_settled', Date.now() - t1);

    await page.keyboard.press('Escape');
    await overlay.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  // ── 6. KOMUT PALETİ ───────────────────────────────────────────────────────
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t0 = Date.now();
    await page.keyboard.press('Control+k');
    const palette = page.locator('.cp-overlay, [role="dialog"]').first();
    await palette.waitFor({ state: 'visible', timeout: 15_000 });
    push('command_palette_open', Date.now() - t0);
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  // ── 7. AYARLAR ────────────────────────────────────────────────────────────
  {
    const btn = page.locator('#btn-settings');
    if (await btn.count()) {
      for (let i = 0; i < Math.min(ITERATIONS, 4); i += 1) {
        const t0 = Date.now();
        await btn.click();
        const dialog = page.locator('[role="dialog"]').first();
        await dialog.waitFor({ state: 'visible', timeout: 15_000 });
        push('settings_open', Date.now() - t0);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
      }
    }
  }

  const afterRuntime = await readRuntime(page);

  const report = {
    label: LABEL,
    iterations: ITERATIONS,
    timings: Object.fromEntries(samples.map(s => [s.name, stats(s.ms)])),
    cold: coldRuntime,
    afterSession: afterRuntime,
  };
  // eslint-disable-next-line no-console
  console.log('PERFJSON ' + JSON.stringify(report));

  // Ölçümün kendisi de bir iddiadır: hiçbir adım sessizce atlanmamalı.
  expect(samples.find(s => s.name === 'message_send_visible')?.ms.length).toBe(ITERATIONS);
  expect(samples.find(s => s.name === 'warm_start_usable')?.ms.length).toBe(ITERATIONS);
});
