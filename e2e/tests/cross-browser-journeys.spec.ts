// e2e/tests/cross-browser-journeys.spec.ts
//
// ÇAPRAZ TARAYICI — GERÇEK KULLANICI YOLCULUKLARI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA v1.123'TE EKLENDİ
// ════════════════════════════════════════════════════════════════════════════
// `cross-browser-core.spec.ts` yalnızca kabuğun yüklendiğini, taşma
// olmadığını ve bir API çağrısının çalıştığını doğruluyordu. Bu, "Firefox'ta
// çalışıyor" demek için YETERSİZDİR: sürüm öncesi asıl soru, kullanıcının
// gerçekten yaptığı işlerin üç motorda da yürüyüp yürümediğidir.
//
// Bu dosya, motora GERÇEKTEN bağlı olan yüzeyleri sınar:
//   · oturum/depolama       — localStorage semantiği motorlar arası farklıdır
//   · REST yolculukları     — fetch + kimlik + CSRF davranışı
//   · odak/klavye           — Firefox ve WebKit farklı odak modeli uygular
//   · kalıcı depolama       — WebKit'te kota/erişim davranışı farklıdır
//
// ── DÜRÜSTLÜK ─────────────────────────────────────────────────────────────
// Playwright WebKit GERÇEK Safari DEĞİLDİR. Medya/WebRTC iddiası burada
// YAPILMAZ; motorlar arası medya yetenekleri farklıdır ve sahte medya
// bayraklarıyla "destekleniyor" demek yanıltıcı olurdu.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

let token: string;
let serverId: string;
let channelId: string;

test.beforeAll(async ({ request }) => {
  token = getTokens().alice;
  const srv = await createTestServer(request, token, `XB ${Date.now()}`);
  serverId = srv?._id || srv?.id;
  expect(serverId, 'Cross-browser journey: sunucu fixture oluşturulamadı').toBeTruthy();
  const ch = await createTestChannel(request, token, serverId, 'genel', 'text');
  channelId = ch?._id || ch?.id;
  expect(channelId, 'Cross-browser journey: kanal fixture oluşturulamadı').toBeTruthy();
});

test.describe('çapraz tarayıcı — yolculuklar', () => {
  // ── Oturum devamlılığı ────────────────────────────────────────────────────
  test('oturum yeniden yüklemeden SONRA da korunur', async ({ page }) => {
    // ════════════════════════════════════════════════════════════════════════
    // v1.124 DUZELTMESI — v1.123'TEKI TESHIS YANLISTI
    // ════════════════════════════════════════════════════════════════════════
    // v1.123 bunu "Firefox servis calisani kusuru" olarak raporladi. O teshis
    // YANLISTI ve burada geri alinmistir. Sistematik bisection:
    //
    //   1. Servis calisani scripti AG SEVIYESINDE engellendi (hic kaydolmadi)
    //      -> Playwright `page.reload()` YINE asili kaldi.  SW SEBEP DEGIL.
    //   2. `fetch` isleyicisi tamamen devre disi -> yine asili kaldi.
    //   3. `skipWaiting`/`clients.claim` devre disi -> yine asili kaldi.
    //   4. Socket.IO rota duzeyinde engellendi -> reload 709 ms'de BASARILI.
    //   5. `closeOnBeforeunload:false` ve yalnizca-polling tasima -> fayda yok.
    //   6. SAYFA ICINDEN `location.reload()` (gercek kullanici yolu), servis
    //      calisani KONTROL EDERKEN: 4/4 kosumda belge degisti ve uygulama
    //      ~400-900 ms icinde render edildi.
    //
    // SONUC: uygulamada kusur YOKTUR. Playwright'in Firefox surumu, ACIK bir
    // Socket.IO baglantisi varken `page.reload()` icin gezinme tamamlanma
    // sinyalini almiyor (`waitUntil:'commit'` 80 ms'de donuyordu, ki bu da
    // ayni sonuca isaret eder). Bu bir KOSUM ORTAMI sinirlamasidir.
    //
    // Bu yuzden test, tarayici surucusunun gezinme tespitine degil,
    // KULLANICININ GORDUGU sonuca bakar: belge gercekten degisti mi ve
    // uygulama yeniden render edildi mi?
    await page.goto(BASE_URL);
    await page.locator('#app').waitFor({ state: 'attached', timeout: 15_000 });

    const before = await page.evaluate(() =>
      localStorage.getItem('token') || localStorage.getItem('bridge_token'));
    expect(before, 'oturum jetonu depolamada yok').toBeTruthy();

    // Eski belgeyi isaretle: reload sonrasi bu isaret KAYBOLMALIDIR.
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__bridgeReloadMarker = 'v1124'; });
    await page.evaluate(() => { setTimeout(() => location.reload(), 50); });

    let documentReplaced = false;
    let rendered = false;
    for (let i = 0; i < 40 && !rendered; i++) {
      await page.waitForTimeout(400);
      try {
        const state = await page.evaluate(() => ({
          marker: (window as unknown as Record<string, unknown>).__bridgeReloadMarker ?? null,
          children: document.querySelector('#app')?.children.length ?? 0,
          readyState: document.readyState,
        }));
        if (state.marker === null) documentReplaced = true;
        if (documentReplaced && state.children > 0 && state.readyState !== 'loading') rendered = true;
      } catch { /* gezinme sirasinda yurutme baglami yikilabilir */ }
    }

    expect(documentReplaced, 'belge yeniden yuklenmedi').toBe(true);
    expect(rendered, 'yeniden yukleme sonrasi uygulama render edilmedi').toBe(true);

    // Ve asil iddia: oturum yeniden yuklemeden SAG cikti.
    const after = await page.evaluate(() =>
      localStorage.getItem('token') || localStorage.getItem('bridge_token'));
    expect(after, 'yeniden yükleme jetonu düşürdü').toBe(before);
  });

  // ── REST yolculuğu: oluştur → oku → düzenle → sil ─────────────────────────
  test('kanal yaşam döngüsü REST üzerinden ÇALIŞIR', async ({ request }) => {
    expect(serverId, 'Sunucu fixture gerekli').toBeTruthy();

    const created = await request.post(`/api/servers/${serverId}/channels`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `xb-${Date.now()}`, type: 'text' },
    });
    expect([200, 201]).toContain(created.status());
    const ch = await created.json();
    const id = ch._id || ch.id;
    expect(id).toBeTruthy();

    const read = await request.get(`/api/servers/${serverId}/channels`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status()).toBe(200);
    const body = await read.json();
    const arr = Array.isArray(body) ? body : (body.channels || []);
    expect(arr.some((c: { _id?: string; id?: string }) => (c._id || c.id) === id)).toBe(true);

    const removed = await request.delete(`/api/servers/${serverId}/channels/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 204]).toContain(removed.status());
  });

  // ── Yetki reddi motorlar arası AYNI davranmalı ────────────────────────────
  test('kimliksiz istek TUTARLI biçimde reddedilir', async ({ request }) => {
    const res = await request.get('/api/servers', { headers: {} });
    // 401 beklenir; motor farkı burada bir sapma YARATMAMALIDIR.
    expect([401, 403]).toContain(res.status());
    const body = await res.text();
    // Ham yığın izi/SQL sızıntısı olmamalı.
    expect(body).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/);
    expect(body).not.toMatch(/SELECT .* FROM/i);
  });

  // ── Klavye/odak — motorlar arasında en çok sapan yüzey ────────────────────
  test('Tab ile odaklanılabilir bir öğeye ULAŞILIR ve odak GÖRÜNÜR', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.locator('#app').waitFor({ state: 'attached', timeout: 15_000 });

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return !!el && el !== document.body && el.tagName !== 'HTML';
      });
    }
    expect(reached, 'Tab hiçbir öğeye odaklanmadı').toBe(true);

    // Odak GÖRÜNÜR olmalı — aksi hâlde klavye kullanıcısı kaybolur.
    const visible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const st = getComputedStyle(el);
      const ow = parseFloat(st.outlineWidth || '0');
      return (ow > 0 && st.outlineStyle !== 'none') || (!!st.boxShadow && st.boxShadow !== 'none');
    });
    expect(visible, 'odaklanan öğede görünür gösterge yok').toBe(true);
  });

  // ── Depolama: outbox/çevrimdışı kuyruk motorun kotasına bağlıdır ──────────
  test('kalıcı depolama YAZILIP okunabilir', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.locator('#app').waitFor({ state: 'attached', timeout: 15_000 });

    const roundTrip = await page.evaluate(() => {
      try {
        const key = '__bridge_xb_probe__';
        localStorage.setItem(key, 'v1123');
        const read = localStorage.getItem(key);
        localStorage.removeItem(key);
        return read;
      } catch { return null; }   // WebKit gizli modda fırlatabilir
    });
    // Outbox ve taslak korumasi buna dayanir; motor reddediyorsa BILMEK gerekir.
    expect(roundTrip).toBe('v1123');
  });

  // ── Konsol: motora özgü ölümcül hata olmamalı ─────────────────────────────
  test('gezinme sırasında ölümcül konsol hatası YOK', async ({ page }) => {
    const fatal: string[] = [];
    page.on('pageerror', e => fatal.push(String(e)));

    await page.goto(BASE_URL);
    await page.locator('#app').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForTimeout(1500);

    expect(fatal, `yakalanmamış hata: ${fatal.join(' | ')}`).toEqual([]);
  });
});
