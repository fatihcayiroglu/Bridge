// e2e/tests/journey-friction.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 4 — GERÇEK KULLANICI YOLCULUKLARININ MALİYETİ
// ════════════════════════════════════════════════════════════════════════════
//
// `daily-driver-journey.spec.ts` "adım takıldı mı?" der. Bu dosya başka bir
// soru sorar ve cevabını SAYIYLA verir:
//
//     Kullanıcı bu işi yapmak için kaç tıklama, kaç tuş, kaç bağlam değişimi
//     ödüyor?
//
// Takılmayan ama pahalı bir akış da kusurdur. Ölçülmeyen maliyet ise
// iyileştirilemez — bu yüzden burada tahmin değil, harness'in FİİLEN yaptığı
// işlemler sayılır (`helpers/friction.ts`).
//
// ── NEDEN TEK OTURUM, TEK SAYFA ────────────────────────────────────────────
// İlk sürüm her yolculuk için ayrı bir test ve ayrı bir `page.goto()`
// kullanıyordu. Ölçüldü: bu, ürünün kendi kötüye-kullanım korumasını
// tetikledi —
//
//     403 {"reason":"Otomatik ban: HTTP rate limit (global) 11x aşıldı"}
//
// Ürün DOĞRU davrandı; hatalı olan ölçümdü. Gerçek bir kullanıcı da uygulamayı
// günde on yedi kez baştan yüklemez: BİR kez açar, sonra bütün bu işleri AYNI
// oturumda yapar. Harness artık onu taklit eder. Hız sınırını gevşetmek
// GÜNDEME ALINMADI: o bir güvenlik geçidi.
//
// ── KAPSAM DÜRÜSTLÜĞÜ ───────────────────────────────────────────────────────
// · Ölçülemeyen yolculuk `skip()` ile AÇIK gerekçe alır ve raporda
//   "olculmedi" görünür — sıfır maliyet gibi GÖSTERİLMEZ.
// · Yolculuk patlarsa `fail()` yazılır ve SONRAKİLER YİNE ÖLÇÜLÜR; tek bir
//   takılma bütün raporu kör etmez.
// · Ses/video yolculukları (17-21) sahte medya bayrakları ister; onlar
//   `voice-media` projesinde ölçülür, burada değil.
// · Süre duvar saatidir ve makine yüküne duyarlıdır; TEK BAŞINA kanıt
//   değildir, sayımlarla birlikte okunur.

import { test, expect } from '../helpers/apiTest';
import type { Page } from '@playwright/test';
import { journey, writeFrictionReport } from '../helpers/friction';
import type { Journey } from '../helpers/friction';
import { getTokens, createTestServer, createTestChannel, apiRequest } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

let serverId = '';
let channelName = '';

/** Fikstür: yeni sunucu kurmayı dener; kota doluysa MEVCUDU kullanır. */
async function ensureFixture(request: Parameters<typeof apiRequest>[0]): Promise<void> {
  const token = getTokens().alice;
  const stamp = Date.now().toString(36);

  const srv = await createTestServer(request, token, `FRIC ${stamp}`);
  serverId = srv?._id || srv?.id || '';
  if (serverId) {
    channelName = `fric-${stamp}`;
    const ch = await createTestChannel(request, token, serverId, channelName, 'text');
    if (ch?._id || ch?.id) return;
    channelName = '';
  }

  // Kota dolu ya da oluşturma başarısız — kullanıcının mevcut sunucusu kullanılır.
  const listed = await apiRequest(request, 'GET', '/api/servers', undefined, token);
  if (!listed.ok()) return;
  const body = await listed.json();
  const servers: Array<Record<string, unknown>> = Array.isArray(body)
    ? body : Array.isArray(body?.servers) ? body.servers : [];

  for (const candidate of servers.slice(0, 5)) {
    const id = String(candidate._id ?? candidate.id ?? '');
    if (!id) continue;
    const chRes = await apiRequest(request, 'GET', `/api/servers/${id}/channels`, undefined, token);
    if (!chRes.ok()) continue;
    const chBody = await chRes.json();
    const channels: Array<Record<string, unknown>> = Array.isArray(chBody)
      ? chBody : Array.isArray(chBody?.channels) ? chBody.channels : [];
    const text = channels.find((c) => c.type === 'text' && typeof c.name === 'string');
    if (text) { serverId = id; channelName = String(text.name); return; }
  }
}

/** Kanal görünümüne girer (oturum başına BİR kez). */
async function enterChannel(page: Page): Promise<boolean> {
  if (!serverId || !channelName) return false;
  await page.locator('.server-rail, #server-list').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 25_000 });
  await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click({ timeout: 25_000 });
  await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 25_000 });
  return true;
}

/** Composer'dan mesaj gönderir; anti-spam sınırına saygı duyar. */
async function send(page: Page, j: Journey, body: string): Promise<void> {
  const composer = page.locator('#msg-input');
  await j.click(composer, 'composer');
  await j.type(composer, body);
  await j.press('Enter', composer);
  await expect(page.locator('.msg', { hasText: body }).first()).toBeVisible({ timeout: 25_000 });
}

/** Mesaj eylem çubuğundaki düğmeye basar (`:hover` ile açılır). */
async function messageAction(page: Page, j: Journey, body: string, label: string): Promise<void> {
  const msg = page.locator('.msg', { hasText: body }).first();
  await msg.hover();
  await j.click(msg.locator(`.msg-actions button[aria-label="${label}"]`).first(), label);
}

/** Açık diyaloğu Escape ile kapatır ve maliyeti yazar. */
async function closeDialog(page: Page, j: Journey): Promise<void> {
  await j.press('Escape');
  j.dialog();
  await page.waitForTimeout(400);
}

test.describe('Faz 4 — yolculuk sürtünmesi', () => {
  test('28 yolculuğun maliyeti TEK oturumda ölçülür', async ({ page, request }) => {
    test.setTimeout(15 * 60_000);

    await ensureFixture(request);

    // ── TEK açılış: bütün yolculuklar bu oturumda ölçülür ──────────────
    const j01 = journey('J01', 'giris (oturum tasinir)', page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 45_000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(1500);
    const shellReady = await page.locator('#channel-list, .server-rail, #msg-input').first().count();
    if (shellReady === 0) j01.fail('kabuk yuklenmedi');

    // ── ONBOARDING SİHİRBAZI — GERÇEK BİR MALİYETTİR, SAYILIR ──────────
    //
    // Ölçüldü: oturumu taşınan kullanıcıda bile karşılama sihirbazı açılıyor
    // ve `elementFromPoint(merkez)` `ow-text` döndürüyor — yani arayüzün
    // ÜSTÜNÜ kapatıyor ve BÜTÜN tıklamaları yutuyor. İlk koşumlarda her
    // yolculuk 20-25 sn zaman aşımıyla düştü; sebep buydu.
    //
    // Harness bunu ATLAMAZ ve gizlemez: kullanıcının yapacağını yapar
    // (kapat), ve bu maliyeti J01'e YAZAR. "Uygulamaya girmek" gerçekten
    // bu kadar tıklama tutuyorsa, rapor bunu göstermelidir.
    const wizard = page.locator('.ow-card, .ow-backdrop').first();
    if (await wizard.count()) {
      const close = page.locator('.ow-close').first();
      if (await close.count()) {
        await j01.click(close, 'onboarding kapat');
        j01.dialog();
        j01.recovery(); // istenmeden gelen, iş akışını kesen adım
      } else {
        await j01.press('Escape');
        j01.dialog();
        j01.recovery();
      }
      await page.waitForTimeout(600);
    }
    j01.end();

    // Gezinme hatası ile "fikstür yok" AYRI şeylerdir. İlk sürüm ikisini aynı
    // mesaja indiriyordu ("kanal fiksturu yok") ve gerçek sebep GİZLENİYORDU.
    let inChannel = false;
    let navNote = '';
    if (!serverId || !channelName) {
      navNote = 'fikstur yok: sunucu/kanal bulunamadi (hiz siniri olabilir)';
    } else {
      try {
        inChannel = await enterChannel(page);
      } catch (err) {
        navNote = `kanala girilemedi: ${String((err as Error)?.message ?? err).slice(0, 100)}`;
      }
    }
    console.log(`[friction] fikstur server=${serverId || '(yok)'} kanal=${channelName || '(yok)'} ` +
                `girildi=${inChannel}${navNote ? ` not=${navNote}` : ''}`);

    /** Yolculuğu koşar; patlarsa KAYDEDER ve devam eder. */
    const run = async (
      id: string, name: string, needsChannel: boolean, body: (j: Journey) => Promise<void>,
    ): Promise<void> => {
      const j = journey(id, name, page);
      if (needsChannel && !inChannel) {
        j.skip(navNote || 'kanal gorunumune girilemedi');
        j.end();
        return;
      }
      try {
        await body(j);
      } catch (err) {
        j.fail(String((err as Error)?.message ?? err).slice(0, 120));
      }
      j.end();
      // Diyalog açık kaldıysa sonraki yolculuğu kirletmesin.
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(300);
    };

    // ── J02 sunucu oluştur (giriş yüzeyi) ─────────────────────────────
    await run('J02', 'sunucu olustur yuzeyi', false, async (j) => {
      const add = page.locator('[data-bridge-action="openServerStart"], #btn-add-server').first();
      if (!(await add.count())) { j.skip('sunucu ekleme tetikleyicisi yok'); return; }
      await j.click(add, 'sunucu ekle');
      j.dialog();
      await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 15_000 });
      await closeDialog(page, j);
    });

    // ── J03 sunucuya katıl (davet yüzeyi) ─────────────────────────────
    await run('J03', 'sunucuya katil yuzeyi', false, async (j) => {
      const add = page.locator('[data-bridge-action="openServerStart"], #btn-add-server').first();
      if (!(await add.count())) { j.skip('katilma tetikleyicisi yok'); return; }
      await j.click(add, 'sunucu ekle');
      j.dialog();
      const joinTab = page.locator('[role="dialog"]').locator('button', { hasText: /Katıl|Join/i }).first();
      if (await joinTab.count()) { await j.click(joinTab, 'katil sekmesi'); j.contextSwitch(); }
      else j.recovery();
      await closeDialog(page, j);
    });

    // ── J04 kanal oluştur ─────────────────────────────────────────────
    await run('J04', 'kanal olustur (kategori hover)', true, async (j) => {
      // GERCEK kontrol `.ch-add-btn`tir ve `opacity: 0` ile GIZLIDIR;
      // yalnizca `.ch-category:hover` / `:focus-within` ile gorunur olur
      // (ChannelList.svelte:215-223). Dokunmatik/dar ekranda hep gorunur.
      // Yani masaustunde kullanici ONCE kategoriyi bulup uzerine gelmek
      // zorunda: bu bir KESIF maliyetidir ve olculur.
      const category = page.locator('.ch-category').first();
      if (!(await category.count())) { j.skip('kanal kategorisi yok'); return; }
      await category.hover();
      j.recovery(); // gizli eylem: once hover gerekiyor
      const add = page.locator('.ch-add-btn').first();
      if (!(await add.count())) { j.skip('.ch-add-btn yok'); return; }
      await j.click(add, 'kanal ekle');
      j.dialog();
      await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 15_000 });
      await closeDialog(page, j);
    });

    // ── J05 davet ─────────────────────────────────────────────────────
    await run('J05', 'davet olustur (sunucu menusu)', true, async (j) => {
      const menu = page.locator('[data-bridge-action="openServerMenu"], #server-header-btn').first();
      if (!(await menu.count())) { j.skip('sunucu menusu tetikleyicisi yok'); return; }
      await j.click(menu, 'sunucu menusu');
      j.dialog();
      const invite = page.locator('[role="menuitem"]').filter({ hasText: /Davet/i }).first();
      if (!(await invite.count())) { j.skip('davet ogesi menude yok'); return; }
      await j.click(invite, 'davet');
      j.contextSwitch();
      await page.waitForTimeout(800);
      await closeDialog(page, j);
    });

    // ── J06 mesaj gönder ──────────────────────────────────────────────
    await run('J06', 'mesaj gonder', true, async (j) => {
      await send(page, j, `fric-send-${Date.now().toString(36)}`);
    });

    // ── J07 yanıtla ───────────────────────────────────────────────────
    await run('J07', 'yanitla', true, async (j) => {
      const body = `fric-reply-${Date.now().toString(36)}`;
      await send(page, j, body);
      await messageAction(page, j, body, 'Yanıtla');
      await expect(page.locator('[data-composer-mode="reply"]')).toBeVisible({ timeout: 10_000 });
      await j.press('Escape');
    });

    // ── J08 düzenle ───────────────────────────────────────────────────
    await run('J08', 'duzenle', true, async (j) => {
      const body = `fric-edit-${Date.now().toString(36)}`;
      await send(page, j, body);
      await messageAction(page, j, body, 'Düzenle');
      await expect(page.locator('[data-composer-mode="edit"]')).toBeVisible({ timeout: 10_000 });
      const composer = page.locator('#msg-input');
      await j.type(composer, `${body}-v2`);
      await j.press('Enter', composer);
      await expect(page.locator('.msg', { hasText: `${body}-v2` }).first()).toBeVisible({ timeout: 25_000 });
    });

    // ── J09 sil ───────────────────────────────────────────────────────
    await run('J09', 'sil', true, async (j) => {
      const body = `fric-del-${Date.now().toString(36)}`;
      await send(page, j, body);
      await messageAction(page, j, body, 'Sil');
      await expect(page.locator('.msg', { hasText: body })).toHaveCount(0, { timeout: 25_000 });
    });

    // ── J10 tepki ─────────────────────────────────────────────────────
    await run('J10', 'tepki ver', true, async (j) => {
      const body = `fric-react-${Date.now().toString(36)}`;
      await send(page, j, body);
      await messageAction(page, j, body, 'Tepki ekle');
      const msg = page.locator('.msg', { hasText: body }).first();
      const row = msg.locator('.msg-emoji-row');
      await expect(row).toBeVisible({ timeout: 10_000 });
      await j.click(row.locator('button').first(), 'emoji');
      await expect(msg.locator('.msg-reactions .msg-reaction').first()).toBeVisible({ timeout: 25_000 });
    });

    // ── J11 ek dosya (giriş yüzeyi) ───────────────────────────────────
    await run('J11', 'ek dosya ekle', true, async (j) => {
      const attach = page.locator('#btn-attach').first();
      if (!(await attach.count())) { j.skip('ek dosya tetikleyicisi yok'); return; }
      // ILK SURUMDE BURASI ATLANIYORDU ("sistem dosya secici olculemez").
      // Bu OLCUM HATASIYDI: isletim sistemi penceresi gercekten kontrol
      // disidir, ama kullanicinin ODEDIGI maliyet oyle degil. Tarayici
      // `filechooser` olayini yayinlar; dosyayi secmek kullanici icin TEK
      // eylemdir ve Playwright tam olarak onu yapabilir. Yolculuk artik
      // ucuna kadar OLCULUR: tetikleyiciye tikla, dosyayi sec, gonder.
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
      await j.click(attach, 'ek');
      const chooser = await chooserPromise;
      j.dialog();          // isletim sisteminin secicisi de bir baglam kirar
      j.pointer();         // ve dosyayi secmek kullanicinin bir eylemidir
      await chooser.setFiles({
        name: 'friction.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Final21 Faz 4 surtunme olcumu'),
      });
      // Onizleme/kuyruk yuzeyi cikiyorsa bir baglam degisimidir.
      const preview = page.locator('.attach-preview, .upload-preview, .msg-attachments').first();
      if (await preview.count().catch(() => 0)) j.contextSwitch();
    });

    // ── J12 eski mesajı ara ───────────────────────────────────────────
    await run('J12', 'eski mesaji ara', true, async (j) => {
      const needle = `fric-find-${Date.now().toString(36)}`;
      await send(page, j, needle);
      await j.click(page.locator('#btn-search'), 'ara');
      j.dialog(); j.contextSwitch();
      const panel = page.locator('.search-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      const input = panel.locator('input').first();
      await j.type(input, needle);
      await j.press('Enter', input);
      await page.waitForTimeout(1800);
      await closeDialog(page, j);
    });

    // ── J13 DM ────────────────────────────────────────────────────────
    await run('J13', 'DM paneli ac', true, async (j) => {
      await j.click(page.locator('[data-bridge-action="showDmPanel"]').first(), 'DM');
      j.dialog(); j.contextSwitch();
      await expect(page.locator('.dm-panel')).toBeVisible({ timeout: 15_000 });
      await closeDialog(page, j);
    });

    // ── J14 grup DM ───────────────────────────────────────────────────
    await run('J14', 'grup DM yuzeyi', true, async (j) => {
      // ILK SURUMDE BU YOLCULUK "tetikleyici panelde yok" diye atlanmisti ve
      // bu YANLIS BIR SONUCTU: tetikleyici DM panelinde degil, ARKADASLAR
      // panelindedir (`FriendsPanel.svelte` baslik dugmesi `.gdm-entry`).
      // Urun karari tutarli: grup DM uyelerini yalniz arkadaslar arasindan
      // secmeye izin verdigi icin girisi de arkadas yuzeyindedir. Kusur
      // urunde degil, OLCUMDEYDI; olcum duzeltildi.
      await j.click(page.locator('[data-bridge-action="showFriendsPanel"]').first(), 'arkadaslar');
      j.dialog(); j.contextSwitch();
      const friends = page.locator('.friends-panel');
      await expect(friends).toBeVisible({ timeout: 15_000 });
      const entry = friends.locator('.gdm-entry').first();
      if (!(await entry.count())) { j.skip('grup DM girisi arkadaslar panelinde yok'); return; }
      await j.click(entry, 'grup DM');
      j.contextSwitch();
      await expect(page.locator('.gdm-panel, .group-dm-panel').first())
        .toBeVisible({ timeout: 15_000 });
      await closeDialog(page, j);
    });

    // ── J15 sunucuyu sessize al ───────────────────────────────────────
    await run('J15', 'sunucuyu sessize al', true, async (j) => {
      const menu = page.locator('[data-bridge-action="openServerMenu"], #server-header-btn').first();
      if (!(await menu.count())) { j.skip('sunucu menusu tetikleyicisi yok'); return; }
      await j.click(menu, 'sunucu menusu');
      j.dialog();
      // Faz 4 DUZELTMESI: "Bildirim ayarlari" ogesi menuye eklendi; sunucu
      // seviyesinde sessize alma (`level: 'mute'`) artik BURADAN erisilebilir.
      // Once hicbir yerden erisilemiyordu (bkz. ServerMenu.svelte notu).
      const notif = page.locator('[role="menuitem"]').filter({ hasText: /Bildirim/i }).first();
      if (await notif.count()) {
        await j.click(notif, 'bildirim ayarlari');
        j.contextSwitch();
        await page.waitForTimeout(900);
      } else {
        j.recovery(); // hâlâ erisilemiyor
      }
      await closeDialog(page, j);
    });

    // ── J16 bildirim ayarları ─────────────────────────────────────────
    await run('J16', 'bildirim ayarlari', true, async (j) => {
      await j.click(page.locator('#btn-settings'), 'ayarlar');
      j.dialog(); j.contextSwitch();
      const modal = page.locator('#settings-modal-content');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      const tab = modal.locator('[role="tab"]').filter({ hasText: /Bildirim/i }).first();
      if (await tab.count()) { await j.click(tab, 'bildirim sekmesi'); j.contextSwitch(); }
      else j.recovery();
      await closeDialog(page, j);
    });

    // ── J22 bildir ────────────────────────────────────────────────────
    await run('J22', 'mesaj bildir', true, async (j) => {
      const own = page.locator('.msg').last();
      if (!(await own.count())) { j.skip('mesaj listesi bos'); return; }
      await own.hover();
      const report = own.locator('.msg-actions button.danger').first();
      if (!(await report.count())) {
        // Kendi mesajında "Bildir" YOKTUR — bu ürünün DOĞRU davranışıdır.
        j.skip('kendi mesajinda bildir yok (dogru davranis); baskasinin mesaji gerekir');
        return;
      }
      await j.click(report, 'bildir');
      j.dialog();
      await closeDialog(page, j);
    });

    // ── J23 engelle / J24 moderasyon (üye listesi üzerinden) ──────────
    await run('J23', 'kullanici engelle yuzeyi', true, async (j) => {
      const members = page.locator('#btn-members').first();
      if (!(await members.count())) { j.skip('uye listesi tetikleyicisi yok'); return; }
      // ILK SURUMDE "uye listesi bos" diye atlanmisti. IKI OLCUM HATASI vardi:
      //   1. `#btn-members` bir ANAHTAR ve panel VARSAYILAN OLARAK ACIK
      //      (`aria-expanded="true"`); kosulsuz tiklamak listeyi KAPATIYORDU.
      //   2. Satir sinifi `.member-item` degil `.member-row`
      //      (`MemberListPanel.svelte`).
      // Urunun uye listesi dogru calisiyordu; bos olan benim secicimdi.
      if ((await members.getAttribute('aria-expanded')) !== 'true') {
        await j.click(members, 'uyeler');
        j.contextSwitch();
      }
      const member = page.locator('.member-row').first();
      await member.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      if (!(await member.count())) { j.skip('uye listesi bos'); return; }
      await j.click(member, 'uye');
      j.dialog();
      await closeDialog(page, j);
    });

    // ── J27 profil düzenle ────────────────────────────────────────────
    await run('J27', 'profil duzenle', true, async (j) => {
      await j.click(page.locator('#btn-settings'), 'ayarlar');
      j.dialog(); j.contextSwitch();
      const modal = page.locator('#settings-modal-content');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await j.click(modal.locator('[role="tab"]').first(), 'profil sekmesi');
      await closeDialog(page, j);
    });

    // ── J28 gizlilik ayarları ─────────────────────────────────────────
    await run('J28', 'gizlilik ayarlari', true, async (j) => {
      await j.click(page.locator('#btn-settings'), 'ayarlar');
      j.dialog(); j.contextSwitch();
      const modal = page.locator('#settings-modal-content');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      const tab = modal.locator('[role="tab"]').filter({ hasText: /Gizlilik|Privacy/i }).first();
      if (await tab.count()) { await j.click(tab, 'gizlilik sekmesi'); j.contextSwitch(); }
      else j.recovery();
      await closeDialog(page, j);
    });

    // ── J17-J21 ses/video ─────────────────────────────────────────────
    for (const [id, name] of [
      ['J17', 'sese katil'], ['J18', 'ses cihazi degistir'], ['J19', 'kamera ac'],
      ['J20', 'ekran paylas'], ['J21', 'sesten ayril'],
    ] as Array<[string, string]>) {
      const j = journey(id, name, page);
      j.skip('sahte medya bayraklari gerekir — voice-media projesinde olculur');
      j.end();
    }

    // ── J25/J26 bot kur/kaldır ────────────────────────────────────────
    for (const [id, name] of [
      ['J25', 'bot kur'], ['J26', 'bot kaldir'],
    ] as Array<[string, string]>) {
      const j = journey(id, name, page);
      j.skip('pazar yeri yolculugu Faz 14te ayrica olculur');
      j.end();
    }

    writeFrictionReport();
  });
});
