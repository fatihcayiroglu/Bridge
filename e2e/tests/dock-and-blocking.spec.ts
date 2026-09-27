// e2e/tests/dock-and-blocking.spec.ts
//
// SON DEĞİŞİKLİKLER İÇİN ODAKLI TARAYICI KAPSAMI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// Şu değişiklikler birim testlerle doğrulandı ama GERÇEK kabukta hiç
// çalıştırılmamıştı (Docker kesintisi sırasında eklendiler):
//
//   · kullanıcı dock'undaki "ses bağlı" şeridi
//   · kanonik ayrılma (disconnect) eylemi
//   · sustur/kulaklık durumunun şeride yansıması
//   · engelleme API'si (GET/POST/DELETE)
//   · arkadaşlık isteğinde engel denetimi
//   · composer yer tutucusunun Türkçeleştirilmesi
//
// Birim testleri SENTETİK bir DOM kullanır. Buradaki değer, `index.html`
// içindeki GERÇEK işaretleme ile `shell-voice-controls.ts` bağlamasının
// birlikte çalıştığını kanıtlamaktır — kimlikler, sınıflar ve olay adları
// dahil. Sentetik DOM bu eşleşmeyi ispatlayamaz.
//
// ── SESE GERÇEKTEN KATILMADAN NASIL? ─────────────────────────────────────
// Bu ortamda RTC yığını başlatılamıyor (bkz. voice-media.spec.ts; `rtc`
// kaydı oluşmuyor). Şerit ise KANONİK BELGE OLAYLARINI dinler:
// `bridge:voice-joined` / `bridge:voice-left` / `bridge:voice-mute-changed`.
// Testler bu olayları yayar — üretimde ChannelStagePanel ve VoicePanel'in
// yaydığı OLAYLARIN AYNISI. Yani sınanan şey gerçek sözleşmedir, taklit
// değil.
//
// Bunun KANITLAMADIĞI şey: sesin gerçekten aktığı. O, insan geçidindedir.

import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

function tokens(): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tokens.json'), 'utf8'),
  );
}

async function openShell(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
}

const joined = (name: string) => `
  document.dispatchEvent(new CustomEvent('bridge:voice-joined',
    { detail: { channelId: 'c-test', channelName: ${JSON.stringify(name)} } }));
`;

test.describe('kullanıcı dock — ses bağlı şeridi', () => {
  test.use({ storageState: 'fixtures/auth-state.json' });

  test('seste DEĞİLKEN şerit gizlidir', async ({ page }) => {
    await openShell(page);
    await expect(page.locator('#ud-voice-status')).toBeHidden();
  });

  test('sese katılınca şerit GÖRÜNÜR ve kanal adını gösterir', async ({ page }) => {
    await openShell(page);
    await page.evaluate(joined('genel-sohbet'));

    await expect(page.locator('#ud-voice-status')).toBeVisible();
    await expect(page.locator('#ud-vs-channel')).toHaveText('genel-sohbet');
  });

  test('AYRIL düğmesi kabukta gerçekten tıklanabilir', async ({ page }) => {
    // Asıl kusur buydu: metin kanalına geçilince `#voice-panel` gizleniyor ve
    // ayrılma düğmesi onunla birlikte kayboluyordu. Şerit kabukta kalır.
    await openShell(page);
    await page.evaluate(joined('genel'));

    const leave = page.locator('#ud-vs-leave');
    await expect(leave).toBeVisible();
    await expect(leave).toBeEnabled();
    await leave.click({ timeout: 5_000 });     // engellenmemeli
  });

  test('sustur/kulaklık durumu şeride YANSIR', async ({ page }) => {
    await openShell(page);
    await page.evaluate(joined('genel'));
    await expect(page.locator('#ud-voice-status')).toHaveAttribute('data-state', 'live');

    await page.evaluate(`document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted: true } }))`);
    await expect(page.locator('#ud-voice-status')).toHaveAttribute('data-state', 'muted');

    await page.evaluate(`document.dispatchEvent(new CustomEvent('bridge:voice-deafen-changed', { detail: { deafened: true } }))`);
    await expect(page.locator('#ud-voice-status')).toHaveAttribute('data-state', 'deafened');
  });

  test('ayrılınca şerit gizlenir', async ({ page }) => {
    await openShell(page);
    await page.evaluate(joined('genel'));
    await expect(page.locator('#ud-voice-status')).toBeVisible();

    await page.evaluate(`document.dispatchEvent(new CustomEvent('bridge:voice-left'))`);
    await expect(page.locator('#ud-voice-status')).toBeHidden();
  });

  test('mikrofon/kulaklık düğmeleri sesteyken ETKİNLEŞİR', async ({ page }) => {
    await openShell(page);
    await expect(page.locator('#btn-mute')).toBeDisabled();

    await page.evaluate(joined('genel'));
    await expect(page.locator('#btn-mute')).toBeEnabled();
    await expect(page.locator('#btn-deafen')).toBeEnabled();
  });
});

test.describe('composer yer tutucusu TÜRKÇE', () => {
  test.use({ storageState: 'fixtures/auth-state.json' });

  test('yer tutucu SABIT KODLU değil, i18n katmanından gelir', async ({ page }) => {
    // ÖNEMLİ: tarayıcı dili İngilizce olduğunda İngilizce yer tutucu
    // DOĞRUDUR. Kusur "İngilizce görünmesi" değil, metnin i18n'i atlayarak
    // SABIT KODLANMIŞ olmasıydı ("Message #general"). Bu yüzden test dili
    // AÇIKÇA Türkçeye sabitler ve çıktının gerçekten değiştiğini ölçer.
    await page.addInitScript(() => localStorage.setItem('bridge_locale', 'tr'));
    await openShell(page);

    const ph = await page.locator('#msg-input').getAttribute('placeholder');
    expect(ph, 'yer tutucu okunamadı').toBeTruthy();
    expect(ph!, 'Türkçe seçiliyken İngilizce yer tutucu').toContain('Mesaj');
    expect(ph!).not.toContain('Message');
  });

  test('dil DEĞİŞİNCE yer tutucu da değişir', async ({ page }) => {
    // Sabit kodlu bir metin dil değişiminde AYNI kalırdı; asıl kanıt budur.
    await page.addInitScript(() => localStorage.setItem('bridge_locale', 'en'));
    await openShell(page);

    const ph = await page.locator('#msg-input').getAttribute('placeholder');
    expect(ph!).toContain('Message');
  });
});

test.describe('engelleme API — gerçek sunucuya karşı', () => {
  test('engelle → listele → kaldır akışı çalışır', async ({ request }) => {
    const t = tokens();
    const auth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

    // Bob'un kimliğini `/api/me` ile al — sabit kodlanmış kimlik kullanılmaz.
    const meBob = await request.get(`${BASE_URL}/api/me`, { headers: auth(t.bob) });
    expect(meBob.ok()).toBe(true);
    const bobId = (await meBob.json())?._id ?? (await meBob.json())?.id;

    const csrfRes = await request.get(`${BASE_URL}/api/csrf-token`, { headers: auth(t.alice) });
    const csrf = (await csrfRes.json())?.token;
    const withCsrf = { ...auth(t.alice), 'X-CSRF-Token': String(csrf), 'Content-Type': 'application/json' };

    const blocked = await request.post(`${BASE_URL}/api/friends/blocks`, {
      headers: withCsrf, data: JSON.stringify({ userId: bobId }),
    });
    expect(blocked.status(), await blocked.text()).toBe(200);

    const list = await request.get(`${BASE_URL}/api/friends/blocks`, { headers: auth(t.alice) });
    expect(list.ok()).toBe(true);
    expect((await list.json()).blocks.map((b: { userId: string }) => b.userId)).toContain(bobId);

    const removed = await request.delete(`${BASE_URL}/api/friends/blocks/${bobId}`, { headers: withCsrf });
    expect(removed.status()).toBe(200);

    const after = await request.get(`${BASE_URL}/api/friends/blocks`, { headers: auth(t.alice) });
    expect((await after.json()).blocks.map((b: { userId: string }) => b.userId)).not.toContain(bobId);
  });

  test('KENDİNİ engellemek reddedilir', async ({ request }) => {
    const t = tokens();
    const me = await request.get(`${BASE_URL}/api/me`, { headers: { Authorization: `Bearer ${t.alice}` } });
    const myId = (await me.json())?._id;

    const csrfRes = await request.get(`${BASE_URL}/api/csrf-token`, {
      headers: { Authorization: `Bearer ${t.alice}` },
    });
    const csrf = (await csrfRes.json())?.token;

    const res = await request.post(`${BASE_URL}/api/friends/blocks`, {
      headers: { Authorization: `Bearer ${t.alice}`, 'X-CSRF-Token': String(csrf), 'Content-Type': 'application/json' },
      data: JSON.stringify({ userId: myId }),
    });
    expect(res.status()).toBe(400);
  });

  test('kimliksiz istek reddedilir', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/friends/blocks`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ userId: 'x' }),
    });
    expect(res.status()).toBe(401);
  });
});
