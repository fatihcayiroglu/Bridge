// A real Bridge/Chromium resource *diagnostic*, never whole Electron RAM/CPU.
// Performance.getMetrics measures this renderer's JS heap and task time. The
// isolated synthetic React fixture has no product parity with these values.
import { test, expect } from '@playwright/test';

type Metric = { name: string; value: number };
const metricsToRead = ['JSHeapUsedSize', 'TaskDuration', 'Nodes', 'LayoutCount'];

test('actual authenticated desktop client exposes bounded renderer resource evidence', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Performance.enable');
    const readMetrics = async () => {
      const result = await cdp.send('Performance.getMetrics') as { metrics: Metric[] };
      const map = Object.fromEntries(result.metrics.map(item => [item.name, item.value]));
      for (const name of metricsToRead) {
        expect(Number.isFinite(map[name]), `CDP metric ${name} unavailable`).toBe(true);
      }
      expect(map.JSHeapUsedSize).toBeGreaterThan(0);
      return Object.fromEntries(metricsToRead.map(name => [name, map[name]!])) as Record<string, number>;
    };
    const before = await readMetrics();

    // A bounded real layout workload; no fake waits, no server rate changes.
    for (let i = 0; i < 30; i++) {
      const width = i % 2 === 0 ? 900 : 1920;
      const height = i % 2 === 0 ? 600 : 1080;
      await page.setViewportSize({ width, height });
      await expect(page.locator('#app')).toBeVisible();
    }
    const after = await readMetrics();
    const taskDeltaSeconds = after.TaskDuration - before.TaskDuration;
    expect(taskDeltaSeconds, 'CDP task time must not decrease on same renderer').toBeGreaterThanOrEqual(0);
    console.log('BRIDGE_REAL_CDP_METRICS_JSON ' + JSON.stringify({
      scope: 'real Svelte Bridge renderer under headless Chromium, 30 viewport changes',
      claim: 'diagnostic-only; not total app RAM, OS CPU percentage, peak memory or leak verdict',
      before,
      after,
      taskDeltaSeconds,
      heapDeltaBytes: after.JSHeapUsedSize - before.JSHeapUsedSize,
    }));
  } finally {
    await cdp.detach();
  }
});
