// e2e/tests/visual-review.spec.ts
//
// GÖRSEL İNCELEME HARNESS'I
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// UI/UX kararları STİL SAYFASI OKUYARAK verilemez. "Mesaj listesi kart gibi
// mi duruyor", "dock dağınık mı", "yoğunluk doğru mu" — bunlar RENDER edilmiş
// sonuca bakmayı gerektirir.
//
// Bu paket bir TEST DEĞİLDİR: bir üretici. Gerçek çalışan uygulamadan,
// belirlenimci fikstür durumlarıyla ekran görüntüleri üretir; sonra o
// görüntüler incelenip yalnızca KANITLANMIŞ kusurlar düzeltilir.
//
// ── KURALLAR ──────────────────────────────────────────────────────────────
// · Üretim kodu ekran görüntüsü için DEĞİŞTİRİLMEZ.
// · Fikstürler gerçek API üzerinden kurulur — sahte DOM enjekte edilmez.
// · Piksel karşılaştırması YAPILMAZ; bu kırılgan olurdu. Çıktı insan/model
//   incelemesi içindir.
//
// Çalıştırma:
//   npx playwright test tests/visual-review.spec.ts --project=chromium
//   npx playwright test tests/visual-review.spec.ts --project=mobile

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens, joinServer } from '../helpers/bridge';
import { openSocket, waitForEvent, paceSends } from '../helpers/socket';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const SHOTS = path.join(__dirname, '..', 'screenshots');

let serverId = '';
let textChannel = '';
let textChannelId = '';
let voiceChannel = '';

function uid(token: string): string {
  try {
    return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).id ?? '');
  } catch { return ''; }
}

async function authHeaders(request: APIRequestContext, token: string) {
  const csrf = await request.get(`${BASE_URL}/api/csrf-token`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const t = (await csrf.json())?.token;
  return { Authorization: `Bearer ${token}`, 'X-CSRF-Token': String(t), 'Content-Type': 'application/json' };
}

/**
 * Gerçekçi bir konuşma kurar — KANONİK yoldan.
 *
 * ÖNEMLİ: Bridge'de kanal mesajı gönderimi REST DEĞİLDİR.
 * `POST /api/channels/:id/messages` diye bir uç YOKTUR (ölçüldü: 404) ve
 * `messaging.spec.ts` bunu zaten belgeleyip atlamış. Tek yazma yolu
 * Socket.IO `message:send` → `message:ack`.
 *
 * İlk denemede REST kullanılmıştı; bu yüzden konuşma HİÇ oluşmadı ve mesaj
 * listesi BOŞ ekrandan değerlendirilmeye çalışıldı. Boş ekrandan yoğunluk /
 * gruplama / hover kararı verilemez.
 */
async function seedConversation(): Promise<void> {
  const t = getTokens();
  const alice = await openSocket(t.alice);
  const bob = await openSocket(t.bob);

  const send = async (sock: typeof alice, content: string, extra: Record<string, unknown> = {}) => {
    // Fail closed: a blocked, rate-limited or missing fixture message is not visual evidence.
    await paceSends(sock === alice ? 'alice' : 'bob');
    const ackId = `vis-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ ackId: string; messageId: string }>(
      sock, 'message:ack', 15_000, (event) => event.ackId === ackId,
    );
    sock.emit('message:send', { channelId: textChannelId, serverId, content, ackId, ...extra });
    const got = await ack;
    if (!got.messageId) throw new Error(`Visual fixture send returned no messageId for ${ackId}`);
    return got.messageId;
  };

  try {
    // Aynı kişiden ARDIŞIK mesajlar — gruplama davranışı buradan görülür.
    await send(alice, 'Selam! Bugünkü dağıtımı konuşalım mı?');
    await send(alice, 'Migration dosyasını hazırladım, gözden geçirmen gerekiyor.');
    await send(alice, 'Özellikle 027 numaralı olan biraz karışık oldu.');

    // FARKLI kişi — ayrışma davranışı.
    await send(bob, 'Tabii, birazdan bakarım.');

    // UZUN mesaj — satır yüksekliği ve okunabilirlik.
    await send(bob, 'Bu arada staging ortamında bir sorun var gibi görünüyor: loglarda '
      + 'bağlantı zaman aşımı görüyorum ve bu yalnızca yoğun saatlerde oluyor. '
      + 'Redis tarafındaki bağlantı havuzuyla ilgili olabilir, ama emin değilim.');

    // KISA mesaj + EMOJI-ONLY — uç boyutlar.
    await send(alice, 'Anladım.');
    await send(alice, '👍');

    // MENTION — vurgulu satır.
    // `aliceName` diye bir alan HIC yoktu; cast onu gizliyordu ve mention
    // her zaman 'alice' fallback'ine dusuyordu. Kanonik ad kullanilir.
    await send(bob, `@${getTokens().users.alice.username} bu akşam bakabilir misin?`);

    // YANIT — reply önizlemesi.
    const target = await send(alice, 'Migration dosyasını buraya bırakıyorum.');
    if (target) {
      const ackId = `vis-r-${Date.now()}`;
      bob.emit('message:reply', {
        channelId: textChannelId, serverId, content: 'Teşekkürler, inceliyorum.',
        replyToId: target, ackId,
      });
      await waitForEvent(bob, 'message:ack', 10_000).catch(() => null);

      // REAKSİYON — yerleşim ve yoğunluk.
      bob.emit('message:react', { messageId: target, channelId: textChannelId, emoji: '✅' });
      alice.emit('message:react', { messageId: target, channelId: textChannelId, emoji: '🎉' });
      await new Promise(r => setTimeout(r, 600));
    }

    // DÜZENLENMİŞ mesaj — "düzenlendi" etiketi.
    const edited = await send(alice, 'Bu mesaj birazdan düzenlenecek.');
    if (edited) {
      alice.emit('message:edit', { messageId: edited, channelId: textChannelId, content: 'Bu mesaj DÜZENLENDİ.' });
      await new Promise(r => setTimeout(r, 600));
    }

    await new Promise(r => setTimeout(r, 1_000));
  } finally {
    alice.disconnect();
    bob.disconnect();
  }
}

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const t = getTokens();

  const srv = await createTestServer(request, t.alice, `Görsel İnceleme ${Date.now()}`);
  serverId = String((srv as { _id?: string })?._id ?? '');
  if (!serverId) throw new Error('Visual fixture: test server was not created');

  textChannel = 'genel';
  const ch = await createTestChannel(request, t.alice, serverId, textChannel, 'text');
  textChannelId = String((ch as { _id?: string })?._id ?? '');

  await createTestChannel(request, t.alice, serverId, 'duyurular', 'text');
  await createTestChannel(request, t.alice, serverId, 'çok-uzun-bir-kanal-adı-örneği', 'text');
  voiceChannel = 'sohbet-odası';
  await createTestChannel(request, t.alice, serverId, voiceChannel, 'voice');

  if (!textChannelId) throw new Error('Visual fixture: text channel was not created');
  if (!await joinServer(request, t.alice, t.bob, serverId)) {
    throw new Error('Visual fixture: Bob failed to join the test server');
  }
  await seedConversation();
});

async function openShell(page: Page, locale = 'tr'): Promise<void> {
  await page.addInitScript((l: string) => {
    localStorage.setItem('bridge_locale', l);
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  }, locale);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  // İlk çalıştırma yüzeylerini kapat — inceleme konusu onlar değil.
  for (const sel of ['.ess-close', 'button[aria-label="Kapat"]']) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
}

async function enterChannel(page: Page): Promise<void> {
  if (!serverId) return;
  await page.locator(`.server-icon[data-id="${serverId}"]`).first().click().catch(() => undefined);
  await page.waitForTimeout(900);
  await page.locator(`[aria-label="Kanal: ${textChannel}"]`).first().click().catch(() => undefined);
  await page.waitForTimeout(1_400);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

// ════════════════════════════════════════════════════════════════════════════
test.describe('görsel inceleme — masaüstü', () => {
  test.use({ storageState: 'fixtures/auth-state.json', viewport: { width: 1440, height: 900 } });

  test('kabuk ve sohbet', async ({ page }) => {
    await openShell(page);
    await shot(page, 'd01-shell-empty');

    await enterChannel(page);
    await shot(page, 'd02-shell-conversation');

    // Mesaj üzerine gelince araç çubuğu — düzen kaymamalı.
    const msg = page.locator('.message, .msg, [data-message-id]').first();
    if (await msg.count()) {
      await msg.hover().catch(() => undefined);
      await page.waitForTimeout(400);
      await shot(page, 'd03-message-hover');
    }
  });

  test('UX-6 ÖLÇÜM — eşdeğer compact satırların dikey ritmi', async ({ page }) => {
    // ══════════════════════════════════════════════════════════════════════
    // NEDEN ÖLÇÜLÜYOR
    // ══════════════════════════════════════════════════════════════════════
    // Ekran görüntüsünde aynı göndericiye ait ardışık mesajlar arasındaki
    // boşluk EŞİT DEĞİLMİŞ gibi görünüyordu. Göz kararıyla CSS değiştirmek
    // yanlış olurdu; geometri ölçülür.
    //
    // KRİTİK: yalnızca GERÇEKTEN EŞDEĞER satırlar karşılaştırılır. Yanıt
    // önizlemesi, reaksiyon satırı, düzenleme etiketi veya ek taşıyan bir
    // mesaj daha uzundur ve farkı "boşluk hatası" saymak YANLIŞ olurdu.
    await openShell(page);
    await enterChannel(page);

    const rows = await page.evaluate(() => {
      const list = Array.from(document.querySelectorAll('article.msg')) as HTMLElement[];
      return list.map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          compact: el.classList.contains('msg-compact'),
          // Eşdeğerlik için: bu satırda ek yapı var mı?
          hasReply: !!el.querySelector('.msg-reply, .reply-preview, [class*="reply"]'),
          hasReactions: !!el.querySelector('[class*="reaction"]'),
          hasEdited: /düzenlend|edited/i.test(el.textContent || ''),
          hasAttachment: !!el.querySelector('img, video, [class*="attach"]'),
          top: r.top, bottom: r.bottom,
          marginTop: cs.marginTop, paddingTop: cs.paddingTop,
          text: (el.textContent || '').trim().slice(0, 30),
        };
      });
    });

    // Yalnızca SADE compact satırlar: ek yapı taşıyan hiçbir şey yok.
    const plain = rows.filter(r => r.compact && !r.hasReply && !r.hasReactions
      && !r.hasEdited && !r.hasAttachment);

    const gaps: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (!plain.includes(cur)) continue;
      if (prev.hasReply || prev.hasReactions || prev.hasEdited || prev.hasAttachment) continue;
      gaps.push(Math.round(cur.top - prev.bottom));
    }

    console.log('UX6_GAPS ' + JSON.stringify(gaps));

    // ── ÖLÇÜM SONUCU ────────────────────────────────────────────────────
    // Dört eşdeğer compact satır arası boşluk: [0,0,0,0].
    // Tüm compact satırlar `margin-top: 0px` / `padding-top: 2px`;
    // grup BAŞLATAN satırlar ise `margin-top: 10px` alıyor — yani ritim
    // tutarlı ve gruplama kasıtlı.
    //
    // Ekran görüntüsündeki "farklı boşluk" izlenimi YANLIŞTI: fark satır
    // sarmasından (uzun metin iki satıra iniyor) geliyordu, boşluktan değil.
    // Göz kararıyla CSS değiştirilseydi sağlam bir düzen bozulacaktı.
    expect(gaps.length, 'ölçülecek eşdeğer compact satır bulunamadı').toBeGreaterThanOrEqual(2);
    const uniqueGaps = [...new Set(gaps)];
    expect(uniqueGaps, `eşdeğer compact satırlar farklı boşluk aldı: ${JSON.stringify(gaps)}`)
      .toHaveLength(1);

    // Grup başlangıcı ile devam satırı AYRIŞMALI (kasıtlı hiyerarşi).
    const starters = rows.filter(r => !r.compact);
    const continuations = rows.filter(r => r.compact);
    expect(starters.length).toBeGreaterThan(0);
    expect(continuations.length).toBeGreaterThan(0);
    expect(new Set(starters.map(r => r.marginTop)).size, 'grup başlangıçları tutarsız').toBe(1);
    expect(starters[0].marginTop).not.toBe(continuations[0].marginTop);
  });

  test('kullanıcı dock — boşta ve seste', async ({ page }) => {
    await openShell(page);
    await enterChannel(page);
    const dock = page.locator('.user-panel');
    await dock.screenshot({ path: path.join(SHOTS, 'd04-dock-idle.png') }).catch(() => undefined);

    await page.evaluate(`
      document.dispatchEvent(new CustomEvent('bridge:voice-joined',
        { detail: { channelId: 'c1', channelName: 'sohbet-odası' } }));
    `);
    await page.waitForTimeout(500);
    await dock.screenshot({ path: path.join(SHOTS, 'd05-dock-voice.png') }).catch(() => undefined);

    await page.evaluate(`document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted: true } }))`);
    await page.waitForTimeout(400);
    await dock.screenshot({ path: path.join(SHOTS, 'd06-dock-muted.png') }).catch(() => undefined);
  });

  test('kenar çubuğu ve sunucu rayı', async ({ page }) => {
    await openShell(page);
    await enterChannel(page);
    const side = page.locator('.channel-sidebar').first();
    await side.screenshot({ path: path.join(SHOTS, 'd07-sidebar.png') }).catch(() => undefined);
    const rail = page.locator('.server-list').first();
    await rail.screenshot({ path: path.join(SHOTS, 'd08-server-rail.png') }).catch(() => undefined);
  });

  test('arama paneli', async ({ page }) => {
    await openShell(page);
    await enterChannel(page);
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(900);
    await shot(page, 'd09-search-open');
    await page.keyboard.type('migration');
    await page.waitForTimeout(1_800);
    await shot(page, 'd10-search-results');
  });

  test('TEMA KARŞILAŞTIRMASI — dark / light / amoled', async ({ page }) => {
    // ══════════════════════════════════════════════════════════════════════
    // HARNESS DÜZELTİLDİ
    // ══════════════════════════════════════════════════════════════════════
    // Önceki deneme `bridge-theme` anahtarını yazıyordu — BÖYLE BİR ANAHTAR
    // YOK. Kanonik depolama `theme-store.ts` içindedir:
    //     THEME_STORAGE_KEY = 'bridge:theme:v1'
    // Yanlış anahtar sessizce yok sayıldığı için "açık tema" ekran görüntüsü
    // varsayılanla AYNI çıkmıştı ve tema incelemesi aslında hiç yapılmamıştı.
    //
    // Ayrıca artık EKRAN GÖRÜNTÜSÜNDEN ÖNCE temanın gerçekten değiştiği
    // hesaplanmış stille DOĞRULANIYOR; aksi halde yine sessizce yanlış
    // sonuç üretebilirdik.
    const bg: Record<string, string> = {};

    for (const theme of ['dark', 'light', 'amoled'] as const) {
      await page.addInitScript((t: string) => {
        localStorage.setItem('bridge:theme:v1', t);
        localStorage.setItem('bridge_locale', 'tr');
        localStorage.setItem('bridge_onboarding_v3:anon', 'done');
      }, theme);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
      await page.waitForTimeout(600);

      const applied = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
      }));
      bg[theme] = applied.bg;
      console.log(`THEME ${theme} attr=${applied.attr} bg=${applied.bg} text=${applied.text}`);

      // Tema GERÇEKTEN uygulanmış olmalı — yoksa görüntü yanıltıcı olur.
      expect(applied.attr, `${theme} teması uygulanmadı`).toBe(theme);

      await enterChannel(page);
      await shot(page, `d11-theme-${theme}`);
    }

    // Dark ve light AYNI arka planı veremez; verirse tema hiç değişmemiştir.
    expect(bg.dark, 'dark ve light aynı arka plan').not.toBe(bg.light);
  });

  test('ayarlar ve komut paleti', async ({ page }) => {
    await openShell(page);
    await enterChannel(page);
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(800);
    await shot(page, 'd12-command-palette');
    await page.keyboard.press('Escape');

    await page.locator('#btn-settings').first().click().catch(() => undefined);
    await page.waitForTimeout(1_200);
    await shot(page, 'd13-settings-modal');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UX-12 / UX-13 / UX-14 — üye listesi, profil, ayarlar, örtü ailesi
// ════════════════════════════════════════════════════════════════════════════
// Ayrıca TANIMSIZ JETON düzeltmesinin REGRESYON taraması: `--border-subtle`,
// `--radius-sm/md`, `--elevation-modal`, `--surface-1/2` artık GERÇEKTEN
// çözülüyor. Önceki hâlde bu bildirimler sessizce GEÇERSİZDİ; geri gelmeleri
// gizli varsayımları açığa çıkarabilir (fazla güçlü kenarlık, aşırı gölge,
// beklenmedik arka plan). Bu yüzden etkilenen yüzeyler yeniden çizdirilir.
test.describe('görsel inceleme — üye/profil/ayarlar/örtüler', () => {
  test.use({ storageState: 'fixtures/auth-state.json', viewport: { width: 1440, height: 900 } });

  test('üye listesi ve profil', async ({ page }) => {
    await openShell(page);
    await enterChannel(page);

    const members = page.locator('.member-list').first();
    if (await members.count()) {
      await members.screenshot({ path: path.join(SHOTS, 'd30-member-list.png') }).catch(() => undefined);
    }

    // Profil KANONİK yoldan açılır: üye satırına tıkla.
    const member = page.locator('.member-list button, .member-item, [class*="member-row"]').first();
    if (await member.count()) {
      await member.click().catch(() => undefined);
      await page.waitForTimeout(1_200);
      await shot(page, 'd31-profile');
    }
  });

  test('ayarlar ve yönetim', async ({ page }) => {
    await openShell(page);
    await enterChannel(page);

    await page.locator('#btn-settings').first().click().catch(() => undefined);
    await page.waitForTimeout(1_500);
    await shot(page, 'd32-user-settings');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Sunucu ayarları: sunucu başlığındaki menüden.
    await page.locator('.server-header').first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    await shot(page, 'd33-server-menu');

    // Sunucu ayarları (yönetim) — UX-13'ün asıl konusu.
    const settingsItem = page.getByText('Sunucu ayarları').first();
    if (await settingsItem.count()) {
      await settingsItem.click().catch(() => undefined);
      await page.waitForTimeout(1_800);
      await shot(page, 'd37-server-settings');

      // Sekmeler arasında gez: Üyeler / Roller / Denetim.
      for (const [label, name] of [['Üyeler', 'd38-admin-members'], ['Roller', 'd39-admin-roles'],
                                   ['Denetim', 'd40-admin-audit'], ['Moderasyon', 'd41-admin-moderation']]) {
        const tab = page.getByRole('tab', { name: label }).or(page.getByText(label, { exact: true })).first();
        if (await tab.count() && await tab.isVisible().catch(() => false)) {
          await tab.click().catch(() => undefined);
          await page.waitForTimeout(1_200);
          await shot(page, name);
        }
      }
    }
  });

  test('örtü ailesi — palet, arama, tooltip', async ({ page }) => {
    await openShell(page);
    await enterChannel(page);

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(800);
    await shot(page, 'd34-command-palette');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await page.keyboard.press('Control+f');
    await page.waitForTimeout(900);
    await page.keyboard.type('migration');
    await page.waitForTimeout(1_600);
    await shot(page, 'd35-search-results');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Bağlam menüsü — mesaja sağ tık.
    const msg = page.locator('article.msg').first();
    if (await msg.count()) {
      await msg.click({ button: 'right' }).catch(() => undefined);
      await page.waitForTimeout(700);
      await shot(page, 'd36-context-menu');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UX-9 — DM / GDM
// ════════════════════════════════════════════════════════════════════════════
// Fikstürler KANONİK yollardan kurulur:
//   DM  → socket `dm:send` { toUserId, content }
//   GDM → POST /api/gdm { name, memberIds[] }, sonra socket `gdm:send`
// REST bir DM gönderim ucu YOKTUR; uydurulmaz.
test.describe('görsel inceleme — DM / GDM', () => {
  test.use({ storageState: 'fixtures/auth-state.json', viewport: { width: 1440, height: 900 } });

  test('DM ve GDM durumları', async ({ page, request }) => {
    const t = getTokens();

    const me = async (tok: string) => {
      const r = await request.get(`${BASE_URL}/api/me`, { headers: { Authorization: `Bearer ${tok}` } });
      const j = await r.json();
      return String(j?._id ?? j?.id ?? '');
    };
    const aliceId = await me(t.alice);
    const bobId = await me(t.bob);
    const carolId = await me(t.carol);

    // ── DM geçmişi: iki yönlü, gerçek konuşma ────────────────────────────
    const alice = await openSocket(t.alice);
    const bob = await openSocket(t.bob);
    const carol = await openSocket(t.carol);
    try {
      const dm = (sock: typeof alice, to: string, content: string) =>
        new Promise<void>((res) => { sock.emit('dm:send', { toUserId: to, content }); setTimeout(res, 260); });

      await dm(alice, bobId, 'Selam Bob, müsait misin?');
      await dm(bob, aliceId, 'Buradayım, ne oldu?');
      await dm(alice, bobId, 'Şu migration konusunu konuşalım dedim.');
      await dm(bob, aliceId, 'Tabii, dinliyorum.');

      // Carol'dan OKUNMAMIŞ bir DM — alice bu sohbeti açmayacak.
      await dm(carol, aliceId, 'Merhaba! Sana bir şey soracaktım.');
      await dm(carol, aliceId, 'Müsait olunca döner misin?');

      // ── GDM ─────────────────────────────────────────────────────────────
      const csrf = await request.get(`${BASE_URL}/api/csrf-token`, {
        headers: { Authorization: `Bearer ${t.alice}` },
      });
      const token = (await csrf.json())?.token;
      const gdmRes = await request.post(`${BASE_URL}/api/gdm`, {
        headers: {
          Authorization: `Bearer ${t.alice}`,
          'X-CSRF-Token': String(token),
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({ name: 'Dağıtım Ekibi', memberIds: [bobId, carolId] }),
      });
      const gdm = await gdmRes.json().catch(() => ({}));
      const groupId = String(gdm?.group?._id ?? gdm?._id ?? '');
      if (groupId) {
        alice.emit('gdm:send', { groupId, content: 'Bu akşam dağıtım var, herkes hazır mı?' });
        await new Promise(r => setTimeout(r, 300));
        bob.emit('gdm:send', { groupId, content: 'Bende sorun yok.' });
        await new Promise(r => setTimeout(r, 300));
        carol.emit('gdm:send', { groupId, content: 'Ben de hazırım 👍' });
        await new Promise(r => setTimeout(r, 500));
      }
      await new Promise(r => setTimeout(r, 900));
    } finally {
      alice.disconnect(); bob.disconnect(); carol.disconnect();
    }

    // ── Render ───────────────────────────────────────────────────────────
    await openShell(page);
    // DM yüzeyine git — kanonik giriş noktası kabuktaki DM/HUB düğmesidir.
    const dmEntry = page.locator('[data-bridge-action="openDmPanel"], #btn-dms, .hub-btn, [aria-label*="Direkt"]').first();
    if (await dmEntry.count()) {
      await dmEntry.click().catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
    await shot(page, 'd20-dm-list');

    // İlk DM sohbetini aç.
    const firstDm = page.locator('.dm-item, .dm-row, [class*="dm-list"] button').first();
    if (await firstDm.count()) {
      await firstDm.click().catch(() => undefined);
      await page.waitForTimeout(1_500);
      await shot(page, 'd21-dm-conversation');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
test.describe('görsel inceleme — mobil', () => {
  // Telefon viewport'u AÇIKÇA ayarlanır: bu paket `visual` projesinde
  // (Desktop Chrome) koşar ve mobil gezinme çubuğu geniş ekranda gizlidir.
  // `launchOptions` describe içinde yasaktır ama `viewport` serbesttir.
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test('mobil kabuk, sohbet, çekmece', async ({ page }) => {
    await openShell(page);
    await shot(page, 'm01-mobile-shell');

    await page.locator('#mnav-servers').click().catch(() => undefined);
    await page.waitForTimeout(700);
    await shot(page, 'm02-mobile-server-drawer');

    if (serverId) {
      await page.locator(`.server-list.open .server-icon[data-id="${serverId}"]`).first().click().catch(() => undefined);
      await page.waitForTimeout(900);
      await page.locator('#mnav-channels').click().catch(() => undefined);
      await page.waitForTimeout(700);
      await shot(page, 'm03-mobile-channel-drawer');

      await page.locator(`[aria-label="Kanal: ${textChannel}"]`).first().click().catch(() => undefined);
      await page.waitForTimeout(1_500);
      await shot(page, 'm04-mobile-conversation');
    }
  });
});
