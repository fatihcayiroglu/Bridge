// e2e/tests/dm-daily-use.spec.ts
//
// BİRE BİR DM — GERÇEK TARAYICIDA GÜNLÜK KULLANIM (P3)
//
// `dm.spec.ts` sunucu sözleşmesini (gönderim, kalıcılık, yetki) sürer; bu
// dosya aynı konuşmayı KULLANICININ gördüğü yüzeyden sürer. P3 incelemesinde
// bulunan ve bu yolculuğun eski kodda düşürdüğü davranışlar:
//   · konuşma en eski yüklü mesajda (en üstte) açılıyordu;
//   · 50 mesajdan eski geçmişe arayüzden ulaşılamıyordu;
//   · Enter göndermiyordu (kanal ve grup DM'de gönderir);
//   · açık olmayan konuşmaya gelen mesaj yan listedeki okunmamış rozetini
//     panel yeniden açılana kadar güncellemiyordu;
//   · DÜZEN: DM paneli uzun bir konuşmada ekrandan uzuyordu (1280×720'de
//     yazma alanı y=3845, liste hiç kaymıyordu); grup DM paneli örtü değildi,
//     kabuğun altına belge akışına düşüyordu; genel `.btn-primary{width:100%}`
//     iki yazma alanını da ezip 22px / 205px'e indiriyordu.
import { test, expect, type Page, type APIRequestContext } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';
import type { Socket } from 'socket.io-client';
import { openSocket, closeSockets, paceSends, attachSendDiagnostics } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

type Me = { _id?: string; id?: string; displayName?: string; username?: string };
type DmMsg = { _id: string; content: string; dmId?: string; userId?: string; clientNonce?: string };

/**
 * Ürünün DM hız sınırları (kullanıcı başına): `dm:send` 10 / 10 sn ve
 * `RL_DM_SOCKET_MAX` 20 / dakika. Gönderen başına 3,2 sn aralık ikisinin de
 * altında kalır (en fazla 19 / dakika).
 */
const DM_GAP_MS = 3_200;
const DM_REJECTIONS = ['error:message', 'error:dm_rate', 'error:dm_privacy'] as const;

/**
 * `dm:send` + teslim onayı. `clientNonce` taşır: sunucu hem kanonik yankıyı
 * hem reddi bu nonce ile döner (`error:message`, hız sınırı için
 * `error:dm_rate`, gizlilik için `error:dm_privacy` — istemcinin dinlediği
 * olaylar). Ret sessiz bir zaman aşımına dönüşmez, kodu ve mesajıyla hata olur.
 */
async function sendDm(sender: Socket, label: string, toUserId: string, content: string): Promise<DmMsg> {
  await paceSends(`dm-${label}`, DM_GAP_MS);
  const clientNonce = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<DmMsg>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      sender.off('dm:message', onMessage);
      for (const event of DM_REJECTIONS) sender.off(event, onError);
    };
    const onMessage = (m: DmMsg): void => { if (m?.clientNonce === clientNonce) { done(); resolve(m); } };
    const onError = (e: { clientNonce?: string; code?: string; message?: string; error?: string }): void => {
      if (e?.clientNonce !== clientNonce) return;
      done();
      reject(new Error(`${label} dm:send reddedildi: ${e.code} — ${e.message ?? e.error} (${content})`));
    };
    const timer = setTimeout(() => { done(); reject(new Error(`${label} dm:send onayı 15 sn içinde gelmedi (${content})`)); }, 15_000);
    sender.on('dm:message', onMessage);
    for (const event of DM_REJECTIONS) sender.on(event, onError);
    sender.emit('dm:send', { toUserId, content, clientNonce });
  });
}

let tokens: ReturnType<typeof getTokens>;
const ids: Record<'alice' | 'bob' | 'carol', string> = { alice: '', bob: '', carol: '' };
const names: Record<'bob' | 'carol', string> = { bob: '', carol: '' };
const dmIds: Record<'bob' | 'carol', string> = { bob: '', carol: '' };

test.beforeAll(async ({ request }) => {
  tokens = getTokens();
  for (const who of ['alice', 'bob', 'carol'] as const) {
    const res = await request.get(`${BASE_URL}/api/me`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
    expect(res.status(), `${who} /api/me`).toBe(200);
    const me = await res.json() as Me;
    ids[who] = String(me._id || me.id || '');
    if (who !== 'alice') names[who] = String(me.displayName || me.username || '');
    expect(ids[who]).toBeTruthy();
  }
});

/** alice'in `other` ile konuşmasını açar (yoksa oluşturur) ve kimliğini döner. */
async function openDmAsAlice(request: APIRequestContext, other: 'bob' | 'carol'): Promise<string> {
  // `apiTest` fikstürü CSRF başlığını ekler (ve bayatsa bir kez yeniler).
  const res = await request.post(`${BASE_URL}/api/dm/${ids[other]}`, {
    headers: { Authorization: `Bearer ${tokens.alice}` },
  });
  expect(res.status(), `DM açılamadı: ${await res.text()}`).toBeLessThan(300);
  const conv = await res.json() as { _id?: string; id?: string; dmId?: string };
  const id = String(conv.dmId || conv._id || conv.id || '');
  expect(id).toBeTruthy();
  return id;
}

/** Konuşmayı alice için okundu yapar: geçmişi okumak kanonik "açıldı" eylemidir. */
async function markReadAsAlice(request: APIRequestContext, dmId: string): Promise<void> {
  const res = await request.get(`${BASE_URL}/api/dm/${dmId}/messages?limit=1`, { headers: { Authorization: `Bearer ${tokens.alice}` } });
  expect(res.status()).toBe(200);
}

const GDM_GAP_MS = 1_100;
type GdmMsg = { _id: string; content: string; clientNonce?: string };

/** `gdm:send` + teslim onayı — `sendDm` ile aynı sözleşme (`error:gdm_rate` dahil). */
async function sendGdm(sender: Socket, label: string, groupId: string, content: string): Promise<GdmMsg> {
  await paceSends(`gdm-${label}`, GDM_GAP_MS);
  const clientNonce = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rejections = ['error:message', 'error:gdm_rate'] as const;
  return new Promise<GdmMsg>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      sender.off('gdm:message', onMessage);
      for (const event of rejections) sender.off(event, onError);
    };
    const onMessage = (m: GdmMsg): void => { if (m?.clientNonce === clientNonce) { done(); resolve(m); } };
    const onError = (e: { clientNonce?: string; code?: string; message?: string; error?: string }): void => {
      if (e?.clientNonce !== clientNonce) return;
      done();
      reject(new Error(`${label} gdm:send reddedildi: ${e.code} — ${e.message ?? e.error} (${content})`));
    };
    const timer = setTimeout(() => { done(); reject(new Error(`${label} gdm:send onayı 15 sn içinde gelmedi (${content})`)); }, 15_000);
    sender.on('gdm:message', onMessage);
    for (const event of rejections) sender.on(event, onError);
    sender.emit('gdm:send', { groupId, content, clientNonce });
  });
}

async function shell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('bridge_locale', 'tr');
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  for (const sel of ['.ess-close', 'button[aria-label="Kapat"]']) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click().catch(() => undefined);
    }
  }
}

/**
 * Panel görünür alanı kaplar ama AŞMAZ; yazma alanı ekranın içindedir ve
 * gönder düğmesinden geniştir (genel `.btn-primary{width:100%}` sızıntısı).
 */
async function expectComposerUsable(page: Page, panelSel: string, inputSel: string, buttonSel: string): Promise<void> {
  const viewport = page.viewportSize()!;
  const panel = await page.locator(panelSel).boundingBox();
  expect(panel, `${panelSel} çizilmedi`).not.toBeNull();
  expect(Math.round(panel!.y), `${panelSel} üstü`).toBe(0);
  expect(Math.round(panel!.height), `${panelSel} yüksekliği görünür alanı aşıyor`).toBeLessThanOrEqual(viewport.height);
  await expect(page.locator(inputSel)).toBeInViewport({ ratio: 1 });
  const input = (await page.locator(inputSel).boundingBox())!;
  const button = (await page.locator(buttonSel).boundingBox())!;
  expect(input.width, 'yazma alanı gönder düğmesinden dar').toBeGreaterThan(button.width);
}

async function openConversation(page: Page, displayName: string): Promise<void> {
  await page.locator('[data-bridge-action="showDmPanel"]').first().click({ timeout: 15_000 });
  const row = page.locator('.dm-conversation').filter({ hasText: displayName }).first();
  await row.click({ timeout: 15_000 });
  await expect(page.locator('.dm-composer textarea')).toBeVisible({ timeout: 15_000 });
}

test.describe('DM — gerçek tarayıcıda günlük kullanım', () => {
  test('uzun konuşma en yenide açılır, eski geçmiş yüklenir, Enter gönderir, yeniden yüklemede kalır', async ({ page, request }) => {
    test.setTimeout(240_000);
    dmIds.carol = await openDmAsAlice(request, 'carol');

    // 54 mesaj: bir sayfadan (50) fazlası. İki gönderen dönüşümlü yazar ve
    // ürünün hız sınırlarına uyar (bkz. DM_GAP_MS) — ~90 sn sürer.
    const tag = `p3dm-${Date.now().toString(36)}`;
    const alice = await openSocket(tokens.alice);
    const carol = await openSocket(tokens.carol);
    attachSendDiagnostics(alice, 'alice');
    attachSendDiagnostics(carol, 'carol');
    const TOTAL = 54;
    try {
      for (let i = 0; i < TOTAL; i += 1) {
        const fromAlice = i % 2 === 0;
        const content = `${tag} #${String(i).padStart(2, '0')}`;
        await (fromAlice
          ? sendDm(alice, 'alice', ids.carol, content)
          : sendDm(carol, 'carol', ids.alice, content));
      }
    } finally {
      closeSockets(alice, carol);
    }

    await shell(page);
    await openConversation(page, names.carol);

    const rows = page.locator('.dm-message');
    const newest = rows.filter({ hasText: `${tag} #${TOTAL - 1}` });
    const oldest = rows.filter({ hasText: `${tag} #00` });
    const composer = page.locator('.dm-composer textarea');
    // 1) En yeni mesaj görünür alanda; ilk sayfa 50 satır.
    await expect(newest).toBeInViewport({ timeout: 15_000 });
    await expect(rows).toHaveCount(50);
    await expect(oldest).toHaveCount(0);
    // Düzen: panel görünür alanı aşmaz, yazma alanı ekranda ve kullanılabilir genişlikte.
    await expectComposerUsable(page, '.dm-panel', '.dm-composer textarea', '.dm-composer button[type="submit"]');

    // 2) Klavyeyle "daha eski mesajları yükle".
    const older = page.locator('.dm-load-older');
    await expect(older).toBeVisible();
    await older.focus();
    await page.keyboard.press('Enter');
    await expect(oldest).toHaveCount(1, { timeout: 15_000 });
    // Sıra korunur: bu koşunun mesajları artan sırada.
    const seen = (await page.locator('.dm-message p').allTextContents()).filter(text => text.startsWith(tag));
    expect(seen).toEqual(Array.from({ length: TOTAL }, (_, i) => `${tag} #${String(i).padStart(2, '0')}`));

    // 3) Enter gönderir; satır teslim edilir ve görünür alana kaydırılır.
    const mine = `${tag} enter`;
    await composer.fill(mine);
    await paceSends('dm-alice', DM_GAP_MS); // UI gönderimi de alice'in DM bütçesini kullanır
    await composer.press('Enter');
    const sent = rows.filter({ hasText: mine });
    await expect(sent).toHaveCount(1, { timeout: 15_000 });
    await expect(sent).not.toHaveClass(/pending|failed/, { timeout: 15_000 });
    await expect(sent).toBeInViewport();
    await expect(composer).toHaveValue('');

    // 4) Yeniden yükleme: mesaj kalıcıdır ve konuşmanın en sonundadır.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
    await openConversation(page, names.carol);
    await expect(rows.last()).toContainText(mine, { timeout: 15_000 });
    await expect(rows.last()).toBeInViewport();
  });

  test('açık olmayan konuşmaya gelen mesaj okunmamış rozetini canlı gösterir; açınca temizlenir', async ({ page, request }) => {
    dmIds.carol = dmIds.carol || await openDmAsAlice(request, 'carol');
    dmIds.bob = await openDmAsAlice(request, 'bob');
    await markReadAsAlice(request, dmIds.bob);

    await shell(page);
    await openConversation(page, names.carol);
    const bobRow = page.locator('.dm-conversation').filter({ hasText: names.bob }).first();
    await expect(bobRow).toBeVisible();
    await expect(bobRow.locator('.dm-unread')).toHaveCount(0);

    const content = `p3dm-canli-${Date.now().toString(36)}`;
    const bob = await openSocket(tokens.bob);
    attachSendDiagnostics(bob, 'bob');
    try {
      await sendDm(bob, 'bob', ids.alice, content);
    } finally {
      closeSockets(bob);
    }

    // Panel yeniden açılmadan rozet sunucudan tazelenir; açık konuşma değişmez.
    await expect(bobRow.locator('.dm-unread')).toHaveText('1', { timeout: 15_000 });
    await expect(page.locator('.dm-message').filter({ hasText: content })).toHaveCount(0);

    await bobRow.click();
    await expect(page.locator('.dm-message').filter({ hasText: content })).toBeInViewport({ timeout: 15_000 });
    await expect(bobRow.locator('.dm-unread')).toHaveCount(0);
  });
});

test.describe('Grup DM — gerçek tarayıcıda günlük kullanım', () => {
  test('uzun grup konuşması örtü olarak en yenide açılır; yazma alanı ekranda; Enter gönderir', async ({ page, request }) => {
    test.setTimeout(120_000);
    const name = `P3 Grup ${Date.now().toString(36)}`;
    const created = await request.post(`${BASE_URL}/api/gdm`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name, memberIds: [ids.bob] }),
    });
    expect(created.status(), `grup oluşturulamadı: ${await created.text()}`).toBeLessThan(300);
    const group = await created.json() as { _id?: string; id?: string };
    const groupId = String(group._id || group.id || '');
    expect(groupId).toBeTruthy();

    // 16 mesaj (kişi başına 8): 1280×720'de listeyi taşırır; `gdm:send`
    // sınırları (10 / 10 sn, 20 / dk) içinde kalır.
    const tag = `p3gdm-${Date.now().toString(36)}`;
    const alice = await openSocket(tokens.alice);
    const bob = await openSocket(tokens.bob);
    const TOTAL = 16;
    try {
      for (let i = 0; i < TOTAL; i += 1) {
        const [sender, label] = i % 2 === 0 ? [alice, 'alice'] as const : [bob, 'bob'] as const;
        await sendGdm(sender, label, groupId, `${tag} #${String(i).padStart(2, '0')}`);
      }
    } finally {
      closeSockets(alice, bob);
    }

    await shell(page);
    await page.locator('[data-bridge-action="showFriendsPanel"]').first().click({ timeout: 15_000 });
    await page.locator('.gdm-entry').first().click({ timeout: 15_000 });
    await page.locator('.gdm-item').filter({ hasText: name }).first().click({ timeout: 15_000 });

    const rows = page.locator('#gdm-messages .dm-msg');
    await expect(rows.filter({ hasText: `${tag} #${TOTAL - 1}` })).toBeInViewport({ timeout: 15_000 });
    await expectComposerUsable(page, '#gdm-panel', '.gdm-input', '.gdm-input-area .btn');
    // 50'den az mesaj → daha eski sayfa sunulmaz.
    await expect(page.locator('.gdm-load-older')).toHaveCount(0);

    const mine = `${tag} enter`;
    await page.locator('.gdm-input').fill(mine);
    await paceSends('gdm-alice', GDM_GAP_MS);
    await page.locator('.gdm-input').press('Enter');
    const sent = rows.filter({ hasText: mine });
    await expect(sent).not.toHaveClass(/pending|failed/, { timeout: 15_000 });
    await expect(sent).toBeInViewport();
  });
});
