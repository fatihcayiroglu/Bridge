// e2e/tests/safe-area.spec.ts
//
// P4 — THE PHONE SHELL STAYS OUT OF THE SYSTEM BARS (real client, real server, Chromium with the
// safe-area insets emulated through CDP `Emulation.setSafeAreaInsetsOverride`).
//
// The packaged app declares `viewport-fit=cover`, so iOS (status bar, notch, home indicator) and
// Android 15+ edge-to-edge (Capacitor passes the system-bar insets through to WebView 140+) draw
// the page under the system bars. MEASURED before the fix, 390×844 with a 47 px top inset: the
// channel header's search and "more" buttons at y 7–39, the first server and member entries at
// y 34–38 — under the status bar. 844×390 landscape: composer and user panel in the 21 px
// home-indicator band, and Settings centred ABOVE the screen (close button at y −28) even with no
// insets at all.
//
// Evidence category: AUTOMATED / BROWSER with emulated insets — not device evidence.

import { test, expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test';
import { registerFreshUser, createTestServer } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.use({ storageState: { cookies: [], origins: [] } });

type Insets = { top: number; bottom: number; left: number; right: number };

function userIdOf(token: string): string {
  const body = token.split('.')[1] ?? '';
  return String(JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).id ?? '');
}

async function signedInPhone(
  browser: import('@playwright/test').Browser,
  request: APIRequestContext,
  viewport: { width: number; height: number },
  insets: Insets,
): Promise<{ context: BrowserContext; page: Page }> {
  const { token } = await registerFreshUser(request, 'p4safearea');
  const list = await request.get(`${BASE}/api/servers`, { headers: { Authorization: `Bearer ${token}` } });
  const servers = list.ok() ? await list.json() as unknown[] : [];
  if (!Array.isArray(servers) || servers.length === 0) await createTestServer(request, token, 'Safe area');
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await context.addInitScript(([tok, uid]: string[]) => {
    localStorage.setItem('token', tok);
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
    localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
    // The packaged shell's viewport (mobile/index.template.html) — the page served here lacks it.
    document.addEventListener('DOMContentLoaded', () => {
      const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
      if (meta && !/viewport-fit/.test(meta.content)) meta.content += ', viewport-fit=cover';
    });
  }, [token, userIdOf(token)]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets } as never);
  await page.goto(`${BASE}/`);
  await expect(page.locator('.ch-item').first()).toBeVisible({ timeout: 25_000 });
  // The emulation really reached CSS (otherwise every assertion below would pass vacuously).
  const envTop = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
    const v = { top: getComputedStyle(probe).paddingTop, bottom: getComputedStyle(probe).paddingBottom };
    probe.remove();
    return v;
  });
  expect(envTop).toEqual({ top: `${insets.top}px`, bottom: `${insets.bottom}px` });
  return { context, page };
}

/**
 * Visible, uncovered, interactive elements that overlap an unsafe band. Off-screen (closed
 * drawers), covered, and below-the-fold-of-a-scroller elements are reachable or not shown, so
 * they do not count; a horizontally scrolling strip is reachable by scrolling.
 */
async function unsafeControls(page: Page, insets: Insets): Promise<string[]> {
  return page.evaluate(({ top, bottom, left, right }) => {
    const H = window.innerHeight; const W = window.innerWidth;
    const out: string[] = [];
    const scrollerOf = (el: Element, axis: 'x' | 'y'): Element | null => {
      let s = el.parentElement;
      while (s) {
        const cs = getComputedStyle(s);
        const ov = axis === 'y' ? cs.overflowY : cs.overflowX;
        const more = axis === 'y' ? s.scrollHeight > s.clientHeight + 1 : s.scrollWidth > s.clientWidth + 1;
        if (/(auto|scroll)/.test(ov) && more) return s;
        s = s.parentElement;
      }
      return null;
    };
    for (const el of document.querySelectorAll('button, a, input, textarea, [role="button"], [role="tab"], .ch-item, .server-icon')) {
      const b = el.getBoundingClientRect(); const st = getComputedStyle(el);
      if (b.width < 2 || b.height < 2 || st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
      if (b.right <= 0 || b.left >= W || b.bottom <= 0 || b.top >= H) continue;
      const x = Math.min(W - 1, Math.max(0, b.left + b.width / 2)); const y = Math.min(H - 1, Math.max(0, b.top + b.height / 2));
      const at = document.elementFromPoint(x, y);
      if (!at || !(el === at || el.contains(at) || at.contains(el))) continue;
      const ys = scrollerOf(el, 'y');
      if (ys && b.bottom > ys.getBoundingClientRect().bottom - 1) continue;
      const xs = scrollerOf(el, 'x');
      if (xs && (b.right > xs.getBoundingClientRect().right - 1 || b.left < xs.getBoundingClientRect().left + 1)) continue;
      const band = b.top < top ? 'top' : b.bottom > H - bottom ? 'bottom' : b.left < left ? 'left' : b.right > W - right ? 'right' : null;
      if (band) out.push(`${band}:${el.id ? `#${el.id}` : (el.getAttribute('aria-label') ?? el.className.toString().split(' ')[0] ?? el.tagName)}@${Math.round(b.top)}`);
    }
    return out;
  }, insets);
}

async function clickAction(page: Page, selector: string): Promise<void> {
  await page.evaluate((s) => document.querySelector(s)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), selector);
  await page.waitForTimeout(600);
}

test.describe('P4 — safe areas on edge-to-edge phones', () => {
  test('portrait with a status-bar/notch inset: header, drawers and composer stay reachable', async ({ browser, request }) => {
    const insets = { top: 47, bottom: 34, left: 0, right: 0 };
    const { context, page } = await signedInPhone(browser, request, { width: 390, height: 844 }, insets);
    try {
      expect(await unsafeControls(page, insets), 'chat').toEqual([]);
      for (const drawer of ['#mnav-servers', '#mnav-channels', '#mnav-members']) {
        await clickAction(page, '#mnav-chat');
        await clickAction(page, drawer);
        expect(await unsafeControls(page, insets), drawer).toEqual([]);
      }
    } finally { await context.close(); }
  });

  test('landscape with a cutout and home indicator: composer, user panel and Settings stay reachable', async ({ browser, request }) => {
    const insets = { top: 0, bottom: 21, left: 47, right: 47 };
    const { context, page } = await signedInPhone(browser, request, { width: 844, height: 390 }, insets);
    try {
      expect(await unsafeControls(page, insets), 'chat').toEqual([]);
      await clickAction(page, '[data-bridge-action="openSettingsModal"]');
      await expect(page.locator('#settings-title')).toBeVisible();
      expect(await unsafeControls(page, insets), 'settings').toEqual([]);
    } finally { await context.close(); }
  });

  test('a landscape phone without insets can still close Settings (the dialog fits the screen)', async ({ browser, request }) => {
    const insets = { top: 0, bottom: 0, left: 0, right: 0 };
    const { context, page } = await signedInPhone(browser, request, { width: 844, height: 390 }, insets);
    try {
      await clickAction(page, '[data-bridge-action="openSettingsModal"]');
      const close = page.getByRole('button', { name: /close settings|ayarları kapat/i });
      await expect(close).toBeVisible();
      const box = await close.boundingBox();
      expect(box && box.y >= 0 && box.y + box.height <= 390).toBe(true);
      await close.click();
      await expect(page.locator('#settings-title')).toBeHidden();
    } finally { await context.close(); }
  });
});
