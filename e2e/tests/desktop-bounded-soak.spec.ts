// A 2-minute active session smoke on the actual Svelte Bridge client.
// It detects visible interaction failure and browser crashes; it does NOT
// establish 24-hour stability, OS-wide RSS or absence of memory leaks.
import { test, expect } from '@playwright/test';

const DURATION_MS = 120_000;

test('real Bridge desktop command palette remains usable during bounded soak', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem('bridge_locale', 'tr');
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });

  let pageErrors = 0;
  let crashes = 0;
  page.on('pageerror', () => { pageErrors += 1; });
  page.on('crash', () => { crashes += 1; });
  const cdp = await page.context().newCDPSession(page);
  const samples: Array<{ rounds: number; elapsedMs: number; heapBytes: number; nodes: number }> = [];
  try {
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    const collect = async (rounds: number, start: number) => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics') as {
        metrics: Array<{ name: string; value: number }>;
      };
      const m = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
      expect(Number.isFinite(m.JSHeapUsedSize)).toBe(true);
      expect(Number.isFinite(m.Nodes)).toBe(true);
      expect(m.JSHeapUsedSize).toBeGreaterThan(0);
      samples.push({ rounds, elapsedMs: Date.now() - start, heapBytes: m.JSHeapUsedSize, nodes: m.Nodes });
    };

    const began = Date.now();
    await collect(0, began);
    const palette = page.locator('.cp-overlay');
    let rounds = 0;
    while (Date.now() - began < DURATION_MS) {
      await page.keyboard.press('Control+k');
      await expect(palette, `command palette failed to open in round ${rounds}`).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press('Escape');
      await expect(palette, `command palette failed to close in round ${rounds}`).toBeHidden({ timeout: 5_000 });
      rounds += 1;
      if (rounds % 25 === 0) await collect(rounds, began);
    }
    await collect(rounds, began);
    const elapsedMs = Date.now() - began;
    expect(elapsedMs).toBeGreaterThanOrEqual(DURATION_MS);
    expect(rounds, 'soak made too few verified interactions').toBeGreaterThanOrEqual(10);
    expect(pageErrors, 'uncaught page error during active session').toBe(0);
    expect(crashes, 'renderer crash during active session').toBe(0);
    console.log('BRIDGE_BOUNDED_SOAK_JSON ' + JSON.stringify({
      scope: 'actual Svelte Bridge web client, 2-minute active UI session',
      claim: 'bounded smoke only; not 24-hour leak, native Electron memory or hardware endurance certification',
      elapsedMs, rounds, pageErrors, crashes, samples,
    }));
  } finally {
    await cdp.detach();
  }
});
