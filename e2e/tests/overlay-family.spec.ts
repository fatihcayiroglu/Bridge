import { test } from '@playwright/test';
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('overlay family computed inventory', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem('bridge_locale','tr');
    localStorage.setItem('bridge:theme:v1','dark');
    localStorage.setItem('bridge_onboarding_v3:anon','done');
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25000 });
  await page.waitForTimeout(1500);
  for (const sel of ['.ess-close', 'button[aria-label="Kapat"]']) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(()=>false)) { await el.click().catch(()=>undefined); await page.waitForTimeout(300); }
  }

  const probe = async (label: string, open: () => Promise<void>, sel: string) => {
    await open();
    await page.waitForTimeout(700);
    const v = await page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { radius: cs.borderRadius, border: cs.borderWidth + ' ' + cs.borderStyle,
               bg: cs.backgroundColor, shadow: (cs.boxShadow||'none').slice(0,42),
               pad: cs.padding, font: cs.fontSize };
    }, sel);
    console.log(`OVL ${label} :: ${JSON.stringify(v)}`);
    await page.keyboard.press('Escape').catch(()=>undefined);
    await page.waitForTimeout(400);
  };

  await probe('command-palette', async () => { await page.keyboard.press('Control+k'); }, '.cp-panel, [class*="cp-"][role="dialog"], [role="dialog"]');
  await probe('global-search',   async () => { await page.keyboard.press('Control+f'); }, '.gs-panel, .gs-overlay > *');
  await probe('settings-modal',  async () => { await page.locator('#btn-settings').first().click().catch(()=>undefined); }, '.settings-modal, [class*="settings"][role="dialog"], [role="dialog"]');
  await probe('server-menu',     async () => { await page.locator('.server-header').first().click().catch(()=>undefined); }, '.sm-menu');
});
