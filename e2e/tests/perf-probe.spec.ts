import { test } from '@playwright/test';
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('daily path timings', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem('bridge_locale','tr');
    localStorage.setItem('bridge_onboarding_v3:anon','done');
  });

  const t0 = Date.now();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25000 });
  console.log(`PERF app-ready ${Date.now() - t0}ms`);

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const js = res.filter(r => r.name.endsWith('.js'));
    const css = res.filter(r => r.name.endsWith('.css'));
    const total = (arr: PerformanceResourceTiming[]) =>
      Math.round(arr.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024);
    return {
      domContentLoaded: Math.round(n.domContentLoadedEventEnd),
      loadEvent: Math.round(n.loadEventEnd),
      jsCount: js.length, jsKB: total(js),
      cssCount: css.length, cssKB: total(css),
      resourceCount: res.length,
    };
  });
  console.log('PERF nav ' + JSON.stringify(nav));

  for (const sel of ['.ess-close', 'button[aria-label="Kapat"]']) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(()=>false)) { await el.click().catch(()=>undefined); await page.waitForTimeout(300); }
  }

  const time = async (label: string, fn: () => Promise<void>) => {
    const s = Date.now();
    await fn();
    console.log(`PERF ${label} ${Date.now() - s}ms`);
  };

  const srv = page.locator('.server-icon:not(.discover-btn)').last();
  if (await srv.count()) {
    await time('server-switch', async () => {
      await srv.click().catch(()=>undefined);
      await page.locator('.channel-sidebar').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>undefined);
      await page.waitForTimeout(200);
    });
    const ch = page.locator('[aria-label^="Kanal:"]').first();
    if (await ch.count()) {
      await time('channel-switch', async () => {
        await ch.click().catch(()=>undefined);
        await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 10000 }).catch(()=>undefined);
      });
    }
  }
  await time('search-open', async () => {
    await page.keyboard.press('Control+f');
    await page.locator('.gs-overlay, [role="dialog"]').first().waitFor({ state: 'visible', timeout: 10000 }).catch(()=>undefined);
  });
  await time('search-query', async () => {
    await page.keyboard.type('migration');
    await page.waitForTimeout(1200);
  });
  await page.keyboard.press('Escape');
  await time('palette-open', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
  });
});
