// e2e/tests/ux-final21.spec.ts
//
// Final21 UX turu — gerçek tarayıcıda, gerçek sunucuda kullanıcı deneyimi regresyonları.
// Her test, turda ölçülen bir kusurun geri gelmediğini kullanıcının gördüğü yerden doğrular.
//   U-10 kabuk belge düzeyinde kaydırılamaz (yanıta gidince tüm uygulama yukarı kayıyordu)
//   U-13 tablette her mesajın yanında kalıcı 8 simgelik çubuk yok
//   U-14 telefonda kanal adı okunur; "⋯" menüsü sabitlenmişlere götürür
//   sağ tık → imleçte eylem menüsü ("Metni kopyala" dahil)
//   U-01 girişte "Şifremi unuttum"; e-postadaki /reset-password bağlantısı uygulamayı açar
//   U-02 açık temada ilk açılış kartının başlığı okunur

import { test, expect, type Page, type Browser } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens } from '../helpers/bridge';
import { openSocket, closeSockets, joinChannelConfirmed, paceSends } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
let serverId = '';
let channelId = '';
let channelName = '';

test.beforeAll(async ({ request }) => {
  const token = getTokens().alice;
  const srv = await createTestServer(request, token, `UX21 ${Date.now()}`);
  serverId = String((srv as { _id?: string })?._id ?? '');
  channelName = `ux21-${Date.now().toString(36)}`;
  const ch = await createTestChannel(request, token, serverId, channelName, 'text');
  channelId = String((ch as { _id?: string })?._id ?? '');
  expect(serverId && channelId, 'fixture sunucu/kanal kurulamadı').toBeTruthy();
  // REST ile mesaj gönderme ucu YOK; kanonik yol sokettir. Anti-spam kullanıcı bazlıdır: tempo korunur.
  const sock = await openSocket(token);
  try {
    await joinChannelConfirmed(sock, channelId, serverId);
    for (let i = 1; i <= 3; i += 1) {
      await paceSends('alice');
      const ackId = `ux21-${Date.now()}-${i}`;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8_000);
        sock.on('message:ack', (d: { ackId?: string }) => { if (d?.ackId === ackId) { clearTimeout(timer); resolve(); } });
        sock.emit('message:send', { channelId, serverId, content: `ux21 mesaj ${i}`, ackId });
      });
    }
  } finally { closeSockets(sock); }
});

async function openChannel(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
  // Telefonda sunucu çubuğu ve kanal listesi alt gezinmedeki çekmecelerdir (mobile.spec.ts ile aynı yol).
  const phone = (page.viewportSize()?.width ?? 1280) <= 600;
  if (phone) {
    await page.locator('#mnav-servers').click();
    await page.locator('.server-list.open').waitFor({ state: 'visible', timeout: 15_000 });
  }
  await page.locator(`.server-icon[data-id="${serverId}"]`).first().click();
  if (phone) {
    await page.waitForTimeout(1_200);
    await page.locator('#mnav-channels').click();
    await page.locator('.channel-sidebar.open').waitFor({ state: 'visible', timeout: 15_000 });
  }
  await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click();
  // Tam metin: yanıt satırı özgün metni alıntıladığı için alt dize eşleşmesi iki öğe bulur.
  await expect(page.locator('.msg-content', { hasText: /^ux21 mesaj 3$/ }).first()).toBeVisible({ timeout: 15_000 });
}

async function contextPage(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<Page> {
  const context = await browser.newContext({ locale: 'tr-TR', storageState: 'fixtures/auth-state.json', ...options });
  return context.newPage();
}

const documentState = (page: Page) => page.evaluate(() => ({
  scrollY: Math.round(scrollY), scrollH: document.scrollingElement!.scrollHeight, innerH: innerHeight,
}));

test('U-10 — uygulama kabuğu belge düzeyinde kaydırılamaz (yanıt önizlemesine atlamada da)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openChannel(page);
  let s = await documentState(page);
  expect(s.scrollH, 'belge görünüm penceresinden uzun — kabuğun altında boş alan var').toBeLessThanOrEqual(s.innerH + 1);
  const target = page.locator('.msg').filter({ has: page.locator('.msg-content', { hasText: /^ux21 mesaj 3$/ }) }).first();
  await target.hover();
  await target.locator('.msg-actions button[aria-label="Yanıtla"]').click();
  await paceSends('alice');
  await page.keyboard.type(`ux21 yanıt ${Date.now()}`);
  await page.keyboard.press('Enter');
  await expect(page.locator('button.msg-reply-jump').last()).toBeVisible({ timeout: 15_000 });
  await page.locator('button.msg-reply-jump').last().click();
  await page.waitForTimeout(900);
  s = await documentState(page);
  expect(s).toEqual({ scrollY: 0, scrollH: s.innerH, innerH: s.innerH });
  await expect(page.locator('.channel-header')).toBeInViewport();
});

test('U-13 — dokunmatik tablette mesajların yanında kalıcı eylem çubuğu yok', async ({ browser }) => {
  const page = await contextPage(browser, { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });
  try {
    await openChannel(page);
    const m = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('.msg-actions')].filter((b) => {
        const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0;
      }).length;
      const list = document.querySelector('.msg-list')!.getBoundingClientRect().width;
      const text = Math.min(...[...document.querySelectorAll('.msg .msg-content')].map((c) => c.getBoundingClientRect().width));
      return { bars, ratio: text / list };
    });
    expect(m.bars).toBe(0);
    expect(m.ratio).toBeGreaterThanOrEqual(0.6);
  } finally { await page.context().close(); }
});

test('U-14 — telefonda kanal adı okunur; "⋯" menüsü sabitlenmişlere götürür, Esc odağı geri verir', async ({ browser }) => {
  const page = await contextPage(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await openChannel(page);
    const name = page.locator('#ch-h-name');
    expect(await name.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await page.locator('#btn-header-more').click();
    const menu = page.getByRole('menu', { name: 'Diğer kanal araçları' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#btn-header-more')).toBeFocused();
    await page.locator('#btn-header-more').click();
    await menu.getByRole('menuitem', { name: 'Sabitlenmiş mesajları göster' }).click();
    await expect(page.getByRole('dialog', { name: /Sabitlenmiş/ })).toBeVisible();
  } finally { await page.context().close(); }
});

test('sağ tık — mesaj eylemleri imleçte açılır; "Metni kopyala" var; Esc kapatır', async ({ page }) => {
  await openChannel(page);
  const content = page.locator('.msg-content', { hasText: /^ux21 mesaj 2$/ }).first();
  const box = (await content.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' });
  const menu = page.locator('.mas-sheet.anchored');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Metni kopyala' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Yanıtla' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('U-01 — girişte "Şifremi unuttum"; e-postadaki sıfırlama bağlantısı uygulamayı açar (404 değil)', async ({ browser }) => {
  // Proje varsayılanı oturum durumunu buraya da uygular; giriş ekranı için açıkça BOŞ durum.
  const context = await browser.newContext({ locale: 'tr-TR', storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto(BASE_URL);
    await page.getByRole('button', { name: 'Şifremi unuttum' }).click();
    await expect(page.locator('#f-email')).toBeFocused();
    await page.locator('#f-email').fill('kimse@example.test');
    await page.locator('#f-email').press('Enter');
    await expect(page.locator('#auth-msg')).toContainText('doğrulanmış bir hesaba aitse');
    const res = await page.goto(`${BASE_URL}/reset-password?token=r.gecersiz`);
    expect(res?.status()).toBe(200);
    expect(res?.headers()['content-type']).toContain('text/html');
    await expect(page.locator('#reset-form')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
    await page.locator('#rp-password').fill('yeterince-uzun-1');
    await page.locator('#rp-password').press('Enter');
    await expect(page.locator('#auth-msg')).toContainText('geçersiz ya da süresi dolmuş');
  } finally { await context.close(); }
});

test('U-02 — açık temada ilk açılış kartının başlığı okunur (sabit koyu gradyan yok)', async ({ browser }) => {
  const page = await contextPage(browser, { colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(BASE_URL);
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Sunucu oluştur veya davetle katıl' }).click();
    const card = page.locator('.empty-server-card');
    await expect(card).toBeVisible();
    const m = await card.evaluate((c) => {
      const parse = (v: string) => { const n = v.match(/[\d.]+/g)!.map(Number); const k = v.startsWith('color(srgb') ? 255 : 1; return [n[0]! * k, n[1]! * k, n[2]! * k]; };
      const lum = ([r, g, b]: number[]) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!); };
      const cs = getComputedStyle(c);
      const h1 = c.querySelector('h1')!;
      const fg = lum(parse(getComputedStyle(h1).color)); const bg = lum(parse(cs.backgroundColor));
      return { gradient: cs.backgroundImage, ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
    });
    expect(m.gradient).toBe('none');
    expect(m.ratio).toBeGreaterThanOrEqual(4.5);
  } finally { await page.context().close(); }
});
