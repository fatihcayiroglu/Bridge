// Real browser layout measurements across representative desktop CSS sizes.
// No screenshot-only 'pass': every profile asserts shell, scroll bounds and
// actionable controls. Playwright WebKit != physical macOS Safari.
import { test, expect } from '../helpers/apiTest';
import type { Page, TestInfo } from '@playwright/test';

const { desktopProfiles, inspectMeasurements } = require('../desktop-resolutions.cjs') as {
  desktopProfiles: ReadonlyArray<{ id: string; width: number; height: number }>;
  inspectMeasurements: (value: unknown) => string[];
};
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function measure(page: Page, width: number, height: number, testInfo: TestInfo, name: string) {
  await expect(page.locator('#app'), 'actual Bridge shell never rendered').toBeVisible({ timeout: 30_000 });
  await expect(page.locator('button:visible').first(), 'rendered shell has no usable actions')
    .toBeVisible({ timeout: 15_000 });
  const result = await page.evaluate(({ width, height }) => {
    const root = document.getElementById('app');
    const rootRect = root?.getBoundingClientRect();
    const appStyle = root ? getComputedStyle(root) : null;
    const controls = ['btn-search', 'btn-settings'].map(id => {
      const el = document.getElementById(id);
      const r = el?.getBoundingClientRect();
      const style = el ? getComputedStyle(el) : null;
      return { id, visible: !!r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' &&
        style?.display !== 'none' && style?.opacity !== '0',
        bounds: r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null };
    });
    return { viewport: { width, height }, innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth, docClientWidth: document.documentElement.clientWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      appVisible: !!rootRect && rootRect.width > 0 && rootRect.height > 0 && appStyle?.display !== 'none',
      appRect: rootRect ? { width: rootRect.width, height: rootRect.height } : null,
      activeControls: Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect(); const s = getComputedStyle(b);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !b.disabled;
      }).length, controls };
  }, { width, height });
  await testInfo.attach(`${name}-metrics.json`, { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' });
  await testInfo.attach(`${name}-screen.png`, { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
  expect(inspectMeasurements(result), `${name}: document overflow or clipped controls`).toEqual([]);
}

test.describe('desktop viewport and windowed layout contract', () => {
  for (const profile of desktopProfiles) {
    test(`${profile.id} real browser layout`, async ({ page }, testInfo) => {
      const fatal: string[] = [];
      page.on('pageerror', error => fatal.push(error.message.slice(0, 240)));
      await page.setViewportSize({ width: profile.width, height: profile.height });
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await measure(page, profile.width, profile.height, testInfo, profile.id);
      expect(fatal, `${profile.id}: client threw a runtime error`).toEqual([]);
    });
  }

  test('resizing the same signed-in desktop session preserves the shell and visible actions', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await measure(page, 1920, 1080, testInfo, 'resize-before');
    const url = page.url();
    await page.setViewportSize({ width: 1024, height: 768 });
    await measure(page, 1024, 768, testInfo, 'resize-compact');
    await page.setViewportSize({ width: 2560, height: 1440 });
    await measure(page, 2560, 1440, testInfo, 'resize-after');
    expect(page.url(), 'window resize unexpectedly navigated away').toBe(url);
  });
});
