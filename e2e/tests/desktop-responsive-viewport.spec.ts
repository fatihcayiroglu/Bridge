// Real Bridge web-client baseline for the desktop window sizes supported by
// Electron (main.ts specifies 900x600 as the minimum). This does not establish
// React parity or native Electron compositor/OS-scale support.
import { test, expect } from '@playwright/test';

const viewports = [
  { width: 900, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;

test('authenticated Bridge desktop shell reflows without horizontal clipping', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });

  const evidence = [];
  for (const size of viewports) {
    await page.setViewportSize(size);
    await expect(page.locator('#app')).toBeVisible();
    const dimensions = await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (!app) throw new Error('REAL_PRODUCT_APP_MISSING');
      const rect = app.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const documentWidth = document.documentElement.scrollWidth;
      const bodyWidth = document.body.scrollWidth;
      return {
        viewportWidth,
        viewportHeight: window.innerHeight,
        appWidth: rect.width,
        appHeight: rect.height,
        documentWidth,
        bodyWidth,
      };
    });
    evidence.push({ requested: size, observed: dimensions });
    expect(dimensions.viewportWidth).toBe(size.width);
    expect(dimensions.viewportHeight).toBe(size.height);
    expect(dimensions.appWidth).toBeGreaterThan(0);
    expect(dimensions.appHeight).toBeGreaterThan(0);
    expect(dimensions.documentWidth, `desktop document overflow at ${size.width}x${size.height}`)
      .toBeLessThanOrEqual(size.width + 1);
    expect(dimensions.bodyWidth, `desktop body overflow at ${size.width}x${size.height}`)
      .toBeLessThanOrEqual(size.width + 1);
  }
  // The report is a pass only if all six real layouts were asserted above.
  console.log('BRIDGE_DESKTOP_VIEWPORT_JSON ' + JSON.stringify(evidence));
  expect(evidence).toHaveLength(viewports.length);
});
