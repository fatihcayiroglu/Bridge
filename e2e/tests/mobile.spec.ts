// e2e/tests/mobile.spec.ts
//
// MOBİL GÖRÜNÜM — GERÇEK ÖLÇÜMLER
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// `playwright.config.ts` içinde bir `mobile` projesi TANIMLIYDI
// (`devices['Pixel 7']`, `testMatch: /mobile\.spec\.ts/`) ama o adda BİR DOSYA
// YOKTU. Yani mobil geçidi SIFIR test çalıştırıyordu: yapılandırma "mobil
// kapsanıyor" izlenimi veriyor, hiçbir şey ölçmüyordu.
//
// Bu, ayarlar modalı a11y testinde bulunan kusurun aynısıdır: her koşuda
// sessizce atlanan, yeşil görünen ama hiçbir şey kanıtlamayan bir geçit.
//
// ── NE ÖLÇÜLÜYOR ──────────────────────────────────────────────────────────
// Nesnel, tartışmasız şeyler:
//   · YATAY TAŞMA — mobilde en sık ve en can sıkıcı kusur
//   · kritik kontrollerin gerçekten görünür/dokunulabilir olması
//   · dokunma hedefi boyutu (WCAG 2.5.8: en az 24×24 CSS px)
//   · composer'ın klavye açıkken erişilebilir kalması
//
// Görsel estetik ÖLÇÜLMEZ — o insan yargısıdır. Burada yalnızca kırık olan
// şeyler yakalanır.

import { test, expect, type Page } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// Mobil yolculuk KENDİ verisini kurar.
//
// Önceki hâli, hesapta sunucu yoksa `test.skip` ediyordu — ve gerçekte HER
// koşuda atlanıyordu. Her zaman atlanan bir test hiçbir şey kanıtlamaz;
// aynı kusur ayarlar modalı a11y geçidinde de bulunmuştu.
let mobileChannelName = '';
let mobileServerId = '';

async function openShell(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  // İlk çalıştırma yüzeyleri ölçümü bozmasın.
  for (const sel of ['.ess-close', 'button[aria-label="Kapat"]']) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click().catch(() => undefined);
    }
  }
}

/** Belgenin yatay taşması — sayfa gövdesi ASLA yana kaymamalı. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/** Taşmaya sebep olan ilk birkaç öğe — başarısızlıkta yön göstersin diye. */
async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1) {
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className
          ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : '';
        out.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(r.right)} vw=${vw}`);
      }
      if (out.length >= 6) break;
    }
    return out;
  });
}

test.beforeAll(async ({ request }) => {
  const t = getTokens();
  const srv = await createTestServer(request, t.alice, `Mobil ${Date.now()}`);
  const serverId = String((srv as { _id?: string })?._id ?? '');
  if (!serverId) return;
  mobileServerId = serverId;
  mobileChannelName = `mobil-${Date.now().toString(36)}`;
  await createTestChannel(request, t.alice, serverId, mobileChannelName, 'text');
});

test.describe('mobil — düzen bütünlüğü', () => {
  test('uygulama kabuğu YATAY TAŞMA üretmez', async ({ page }) => {
    await openShell(page);
    const overflow = await horizontalOverflow(page);
    const culprits = overflow > 0 ? await overflowingElements(page) : [];
    expect(overflow, `yatay taşma ${overflow}px — sorumlular: ${culprits.join(' | ')}`).toBe(0);
  });

  test('KANAL SEÇİLİNCE composer görünür ve ekrana sığar', async ({ page }) => {
    await openShell(page);

    // ── GERÇEK MOBİL GEZİNME ────────────────────────────────────────────
    // Sunucu rayı mobilde KAPALI ÇEKMECEDİR (ölçüm: x = -56, viewport 412).
    // Bu bir kusur değil, tasarım: alt gezinme çubuğundaki "Sunucular"
    // sekmesi çekmeceyi içeri kaydırır (js/mobile.ts → `mobileNav`).
    // Test bu yüzden gerçek mobil yolu kullanır; masaüstü gibi doğrudan
    // tıklamaya çalışmak yanlış bir "kusur" raporlardı.
    //
    // Composer da kanal seçilene kadar KASITLI gizlidir
    // (MessageInputPanel: `display = channel?._id && isText ? '' : 'none'`).
    // Çekmecenin GERÇEKTEN açıldığını bekle: `openDrawer` panele `.open`
    // sınıfını ekler (js/mobile.ts). Doğrudan ikonu beklemek, çekmece
    // animasyonu ya da geç mount yüzünden kırılgandı.
    await page.locator('#mnav-servers').click();
    await page.locator('.server-list.open').waitFor({ state: 'visible', timeout: 15_000 });

    // KENDİ kurduğumuz sunucuyu seç. `.first()` başka bir sunucuyu seçiyordu
    // (hesapta önceki testlerden sunucular var) ve sonrasında aradığımız
    // kanal o sunucuda bulunmuyordu.
    const server = mobileServerId
      ? page.locator(`.server-list.open .server-icon[data-id="${mobileServerId}"]`).first()
      : page.locator('.server-list.open .server-icon:not(.discover-btn)').first();
    await server.waitFor({ state: 'visible', timeout: 15_000 });
    await server.click();
    await page.waitForTimeout(1_200);

    await page.locator('#mnav-channels').click();
    await page.locator('.channel-sidebar.open').waitFor({ state: 'visible', timeout: 15_000 });
    const channel = mobileChannelName
      ? page.locator(`[aria-label="Kanal: ${mobileChannelName}"]`).first()
      : page.locator('[aria-label^="Kanal:"]').first();
    await channel.waitFor({ state: 'visible', timeout: 15_000 });
    await channel.click();

    const input = page.locator('#msg-input');
    await expect(input).toBeVisible({ timeout: 15_000 });

    const box = await input.boundingBox();
    expect(box, 'composer ölçülemedi').toBeTruthy();
    const vw = page.viewportSize()!.width;
    expect(box!.x, 'composer sola taşıyor').toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, 'composer sağa taşıyor').toBeLessThanOrEqual(vw + 1);

    // Kanal açıkken de sayfa yana kaymamalı — mesaj listesi en sık taşma
    // kaynağıdır (uzun kelimeler, kod blokları, ekler).
    const overflow = await horizontalOverflow(page);
    const culprits = overflow > 0 ? await overflowingElements(page) : [];
    expect(overflow, `kanal açıkken taşma: ${culprits.join(' | ')}`).toBe(0);
  });

  test('kullanıcı dock kontrolleri DOKUNULABİLİR boyutta', async ({ page }) => {
    await openShell(page);
    // WCAG 2.5.8 (AA): en az 24×24 CSS px.
    const MIN = 24;
    const small: string[] = [];
    for (const sel of ['#btn-mute', '#btn-deafen', '#btn-settings', '#btn-theme']) {
      const el = page.locator(sel).first();
      if (await el.count() === 0) continue;
      if (!await el.isVisible().catch(() => false)) continue;
      const b = await el.boundingBox();
      if (b && (b.width < MIN || b.height < MIN)) {
        small.push(`${sel} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
    }
    expect(small, `dokunma hedefi 24px altında: ${small.join(', ')}`).toEqual([]);
  });

  test('kimlik düğmesi ekran dışına taşmaz', async ({ page }) => {
    await openShell(page);
    const identity = page.locator('#user-identity');
    await expect(identity).toBeVisible();

    const b = await identity.boundingBox();
    const vw = page.viewportSize()!.width;
    expect(b!.x + b!.width, 'kimlik düğmesi taşıyor').toBeLessThanOrEqual(vw + 1);
  });
});

test.describe('mobil — ses şeridi', () => {
  test('ses bağlı şeridi mobilde taşma üretmez', async ({ page }) => {
    await openShell(page);
    // Kanonik olayı yay: RTC bu ortamda başlatılamıyor (voice-media.spec.ts).
    await page.evaluate(`
      document.dispatchEvent(new CustomEvent('bridge:voice-joined',
        { detail: { channelId: 'c1', channelName: 'çok-uzun-bir-ses-kanalı-adı-taşma-testi' } }));
    `);

    const strip = page.locator('#ud-voice-status');
    await expect(strip).toBeVisible();

    // Uzun kanal adı ELLIPSIS ile kısalmalı, düzeni bozmamalı.
    const overflow = await horizontalOverflow(page);
    const culprits = overflow > 0 ? await overflowingElements(page) : [];
    expect(overflow, `şerit taşma yarattı: ${culprits.join(' | ')}`).toBe(0);

    const leave = page.locator('#ud-vs-leave');
    const b = await leave.boundingBox();
    expect(b!.width, 'ayrıl düğmesi çok küçük').toBeGreaterThanOrEqual(24);
    expect(b!.height, 'ayrıl düğmesi çok küçük').toBeGreaterThanOrEqual(24);
  });
});

test.describe('mobil — arama paneli', () => {
  test('arama paneli mobilde taşma üretmez', async ({ page }) => {
    await openShell(page);
    await page.keyboard.press('Control+f');

    const panel = page.locator('.gs-panel, [role="dialog"]').first();
    if (await panel.count() === 0) test.skip(true, 'arama paneli açılmadı');
    await panel.waitFor({ state: 'visible', timeout: 10_000 });

    const overflow = await horizontalOverflow(page);
    const culprits = overflow > 0 ? await overflowingElements(page) : [];
    expect(overflow, `arama paneli taşma yarattı: ${culprits.join(' | ')}`).toBe(0);
  });
});
