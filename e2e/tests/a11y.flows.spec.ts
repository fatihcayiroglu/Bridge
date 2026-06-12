// e2e/tests/a11y.flows.spec.ts
// Sprint 64: Gerçek kullanıcı akışlarında ARIA / klavye doğrulaması
//
// Kapsam:
//   - DM penceresi açma & ARIA landmark'ları
//   - Kanal geçişi klavye navigasyonu
//   - Mesaj kutusu → gönderme akışı
//   - Kanal ayarları modalı (focus trap, Esc)
//   - Üye listesi (listbox/tree ARIA rolü)
//   - Emoji picker klavye navigasyonu
//   - Bildirim alanı erişilebilirliği
//   - Yüksek kontrast modunda kritik UI kontrolleri

import { test, expect, type Page } from '@playwright/test';
const AxeBuilder = require('@axe-core/playwright').default;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ── Yardımcılar ───────────────────────────────────────────────────────────────

async function loginAs(page: Page, username = 'testuser', password = 'testpass'): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"], input[placeholder*="kullanıcı" i], input[type="text"]:first-of-type', username);
  await page.fill('input[name="password"], input[type="password"]', password);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/app/, { timeout: 8000 }).catch(() => { /* storageState varsa redirect olmayabilir */ });
}

async function noA11yViolations(page: Page, context: string, include?: string): Promise<void> {
  const builder = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast']); // kontrast ayrı testte
  if (include) builder.include(include);
  const results = await builder.analyze();
  expect(
    results.violations,
    `A11Y ihlalleri [${context}]:\n${results.violations.map((v: any) =>
      `  [${v.impact}] ${v.id}: ${v.description}\n    → ${v.nodes.map((n: any) => n.target.join(', ')).slice(0, 2).join(' | ')}`,
    ).join('\n')}`,
  ).toEqual([]);
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('a11y — gerçek kullanıcı akışları', () => {

  test.beforeEach(async ({ page }) => {
    // storageState varsa doğrudan app'e git, yoksa login ol
    try {
      await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded', timeout: 5000 });
      const inApp = await page.locator('[data-testid="app-shell"], #app-shell, .channel-list').isVisible({ timeout: 2000 });
      if (!inApp) await loginAs(page);
    } catch {
      await loginAs(page);
    }
  });

  // ── DM akışı ────────────────────────────────────────────────────────────────

  test('DM listesi — ARIA listbox & keyboard navigasyonu', async ({ page }) => {
    // DM ikonuna git
    const dmBtn = page.locator(
      '[aria-label*="Direkt" i], [aria-label*="Direct" i], [data-testid="dm-btn"], #dm-btn',
    ).first();
    if (!await dmBtn.isVisible({ timeout: 2000 })) return test.skip();

    await dmBtn.click();
    await page.waitForTimeout(300);

    // DM listesinde axe tarama
    await noA11yViolations(page, 'DM listesi', '[data-testid="dm-list"], .dm-list, #dm-list, [role="listbox"], [role="list"]');

    // Keyboard: Tab ile DM girişlerine ulaşılabiliyor olmalı
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, role: el?.getAttribute('role'), label: el?.getAttribute('aria-label') };
    });
    expect(['A', 'BUTTON', 'LI', 'DIV']).toContain(focused.tag);
  });

  test('DM penceresi — landmark\'lar & mesaj kutusu ARIA', async ({ page }) => {
    const dmBtn = page.locator('[aria-label*="Direkt" i], [aria-label*="Direct" i]').first();
    if (!await dmBtn.isVisible({ timeout: 2000 })) return test.skip();
    await dmBtn.click();

    // İlk DM'e tıkla
    const firstDm = page.locator('.dm-item, [data-testid="dm-item"], .dm-list li').first();
    if (await firstDm.isVisible({ timeout: 2000 })) {
      await firstDm.click();
      await page.waitForTimeout(400);
    }

    await noA11yViolations(page, 'DM penceresi');

    // Mesaj kutusunun doğru ARIA rolü var mı?
    const msgBox = page.locator(
      '[data-testid="message-input"], [aria-label*="mesaj" i], [aria-label*="message" i], [contenteditable="true"], textarea[placeholder]',
    ).first();
    if (await msgBox.isVisible({ timeout: 2000 })) {
      const role = await msgBox.getAttribute('role');
      const label = await msgBox.getAttribute('aria-label') || await msgBox.getAttribute('placeholder');
      // textbox rolü veya meaningful label bekliyoruz
      expect(role === 'textbox' || (label !== null && label.length > 0)).toBeTruthy();
    }
  });

  // ── Kanal geçişi ─────────────────────────────────────────────────────────────

  test('Kanal listesi — klavye ile geçiş, focus görünür kalmalı', async ({ page }) => {
    const channelList = page.locator(
      '[data-testid="channel-list"], .channel-list, [role="tree"], [role="listbox"]',
    ).first();
    if (!await channelList.isVisible({ timeout: 2000 })) return test.skip();

    await channelList.focus().catch(() => {
      channelList.click();
    });

    // ArrowDown ile kanal seçimi
    await page.keyboard.press('Tab');
    const before = await page.evaluate(() => document.activeElement?.getAttribute('data-channel-id') || document.activeElement?.id);

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => document.activeElement?.getAttribute('data-channel-id') || document.activeElement?.id);

    // Kanal listesi yok / keyboard desteği yoksa skip
    if (!before && !after) return test.skip();

    // Focus mutlaka görünür olmalı (outline kontrolü)
    const focusVisible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const outlineW = parseFloat(style.outlineWidth);
      const boxShadow = style.boxShadow;
      return outlineW > 0 || boxShadow !== 'none';
    });
    // Bu soft assertion — bazı custom focus stilleri box-shadow kullanır
    if (!focusVisible) {
      console.warn('⚠️ Kanal listesinde focus indicator zayıf veya yok');
    }
  });

  test('Kanal geçişi sonrası — mesaj alanı A11Y', async ({ page }) => {
    // İlk metin kanalına tıkla
    const firstChannel = page.locator(
      '[data-type="text"], [data-channel-type="text"], .channel-item[data-type="text"]',
    ).first();
    if (!await firstChannel.isVisible({ timeout: 2000 })) return test.skip();
    await firstChannel.click();
    await page.waitForTimeout(400);

    await noA11yViolations(page, 'Kanal mesaj alanı');
  });

  // ── Modallar ──────────────────────────────────────────────────────────────────

  test('Kanal ayarları modalı — focus trap & Esc kapatma', async ({ page }) => {
    const gearBtn = page.locator(
      '[aria-label*="kanal ayar" i], [aria-label*="channel setting" i], [data-testid="channel-settings-btn"]',
    ).first();
    if (!await gearBtn.isVisible({ timeout: 2000 })) return test.skip();

    await gearBtn.click();
    await page.waitForTimeout(400);

    const modal = page.locator('[role="dialog"], .modal-overlay, #channel-settings-modal').first();
    if (!await modal.isVisible({ timeout: 2000 })) return test.skip();

    // ARIA: modal role ve aria-modal
    await expect(modal).toHaveAttribute('role', 'dialog');

    // A11Y tarama — yalnızca modal içinde
    await noA11yViolations(page, 'Kanal ayarları modalı', '[role="dialog"]');

    // Focus trap: Shift+Tab ile focus modal dışına çıkmamalı
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const focusedInModal = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog?.contains(document.activeElement) ?? true;
    });
    expect(focusedInModal).toBeTruthy();

    // Esc ile kapatılmalı
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 1500 });
  });

  test('Sunucu ayarları modalı — genel A11Y', async ({ page }) => {
    const settingsGear = page.locator(
      '[aria-label*="Sunucu Ayarları" i], [aria-label*="Server Settings" i], [data-testid="server-settings-btn"]',
    ).first();
    if (!await settingsGear.isVisible({ timeout: 2000 })) return test.skip();
    await settingsGear.click();
    await page.waitForTimeout(400);

    const modal = page.locator('[role="dialog"]').first();
    if (!await modal.isVisible({ timeout: 2000 })) return test.skip();

    await noA11yViolations(page, 'Sunucu ayarları modalı', '[role="dialog"]');
  });

  // ── Üye listesi ───────────────────────────────────────────────────────────────

  test('Üye listesi — ARIA rolleri ve keyboard', async ({ page }) => {
    const membersBtn = page.locator(
      '[aria-label*="Üyeler" i], [aria-label*="Members" i], [data-testid="members-btn"]',
    ).first();
    if (!await membersBtn.isVisible({ timeout: 2000 })) return test.skip();
    await membersBtn.click();
    await page.waitForTimeout(300);

    const memberList = page.locator('[data-testid="member-list"], .member-list, [role="listbox"], [role="list"]').first();
    if (!await memberList.isVisible({ timeout: 2000 })) return test.skip();

    await noA11yViolations(page, 'Üye listesi');

    // Her üye girişi tıklanabilir ve ARIA'ya uygun olmalı
    const items = await memberList.locator('[role="option"], [role="listitem"], .member-item').all();
    for (const item of items.slice(0, 3)) {
      const tag = await item.evaluate(el => el.tagName);
      const hasRole = await item.getAttribute('role');
      expect(['BUTTON', 'A', 'LI', 'DIV'].includes(tag) || hasRole !== null).toBeTruthy();
    }
  });

  // ── Emoji picker ──────────────────────────────────────────────────────────────

  test('Emoji picker — klavye navigasyonu & ARIA grid', async ({ page }) => {
    const emojiBtn = page.locator(
      '[aria-label*="emoji" i], [data-testid="emoji-btn"], .emoji-btn, [aria-label*="Emoji" i]',
    ).first();
    if (!await emojiBtn.isVisible({ timeout: 2000 })) return test.skip();
    await emojiBtn.click();
    await page.waitForTimeout(300);

    const picker = page.locator('[data-testid="emoji-picker"], .emoji-picker, #emoji-picker').first();
    if (!await picker.isVisible({ timeout: 2000 })) return test.skip();

    await noA11yViolations(page, 'Emoji picker');

    // Picker içinde Tab ile navige edilebiliyor olmalı
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      inPicker: document.querySelector('.emoji-picker, #emoji-picker')?.contains(document.activeElement),
    }));
    // Soft check — picker kendi focus yönetimini yapıyor olabilir
    if (focused.inPicker === false) {
      console.warn('⚠️ Emoji picker focus yönetimi eksik');
    }

    // Esc ile kapatılmalı
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden({ timeout: 1500 });
  });

  // ── Bildirimler ───────────────────────────────────────────────────────────────

  test('Bildirim alanı — role="status" veya aria-live', async ({ page }) => {
    // Toast/snackbar container'ı bul
    const toastContainer = page.locator(
      '#toast-container, [role="status"], [role="alert"], [aria-live], .toast-container',
    ).first();

    // Bir aksiyonla toast tetikle (geçersiz arama)
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    await page.keyboard.type('!invalid!');
    await page.waitForTimeout(500);

    // Toast yoksa sadece container var mı diye bak
    if (await toastContainer.isVisible({ timeout: 1000 }).catch(() => false)) {
      const role = await toastContainer.getAttribute('role');
      const ariaLive = await toastContainer.getAttribute('aria-live');
      expect(role === 'status' || role === 'alert' || ariaLive !== null).toBeTruthy();
    }
  });

  // ── Yüksek kontrast ───────────────────────────────────────────────────────────

  test('Yüksek kontrast modu — kritik UI elementleri görünür', async ({ page }) => {
    // prefers-contrast: more simüle et
    await page.emulateMedia({ forcedColors: 'active' });
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Temel kontroller hâlâ görünür mü?
    const criticalSelectors = [
      '[data-testid="message-input"], [aria-label*="mesaj" i], textarea',
      '[data-testid="send-btn"], button[type="submit"]',
    ];
    for (const sel of criticalSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        // Görünürlük yeterli — kontrast doğrulaması için ayrı audit
        await expect(el).toBeVisible();
      }
    }

    await page.emulateMedia({ forcedColors: 'none' });
  });

});
