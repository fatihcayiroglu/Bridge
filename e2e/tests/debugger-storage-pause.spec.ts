import { test, expect } from '@playwright/test';
import { createDebuggerStoragePause } from '../android/debugger-storage-pause.mjs';
import { readPausedPreference } from '../android/paused-preference-control.mjs';

test('EX02 observes a real debugger pause, reads browser storage and resumes cleanly', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const origin = 'https://bridge-control.invalid';
  const key = 'bridge:last-navigation:v1:channel:control-user:control-server';
  await page.route(`${origin}/**`, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Storage control</title>',
  }));
  let session;
  let control;
  const bounded = { step: async (_name, fn) => fn() };
  try {
    await page.goto(origin);
    await page.evaluate(key => localStorage.setItem(key, 'expected'), key);
    session = await context.newCDPSession(page);
    await session.send('DOMStorage.enable');
    control = createDebuggerStoragePause(session);
    const result = await control.pause(bounded);
    expect(result).toEqual({ method: 'debugger-pause', eventObserved: true });
    expect(control.isPaused()).toBe(true);
    const storage = await readPausedPreference(control, async () => {
      const response = await session.send('DOMStorage.getDOMStorageItems', {
        storageId: { securityOrigin: origin, isLocalStorage: true },
      });
      return response.entries;
    }, key, 'expected');
    expect(control.isPaused()).toBe(true);
    expect(storage).toEqual({ available: true, preferencePresent: true, preferenceMatches: true });
    await control.release(bounded);
    expect(control.isPaused()).toBe(false);
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('expected');
    expect(await page.evaluate(() => 2 + 2)).toBe(4);
  } finally {
    try {
      if (control) await control.release(bounded);
    } finally {
      try {
        if (session) await session.detach();
      } finally {
        await context.close();
      }
    }
  }
});
