// #209: with a stored session the sign-in screen is not painted while the
// session is being checked. Its three animated glow layers cost about five
// viewports of software compositing per frame on Android cold start (CDP
// LayerTree: 7.2 viewports of layers with the animation, 2.1 without), and a
// signed-in user only saw it flash. client/index.html marks the document
// before the first paint; auth-compat clears the mark however the check ends.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: { call: vi.fn(), get: vi.fn(), register: vi.fn(), has: vi.fn(() => false) },
}));

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const css = readFileSync(resolve(__dirname, '../css/modules/auth.css'), 'utf8');

/** The real first inline head script (theme + session mark), run as the browser would. */
function runHeadScript(): void {
  // Comments first, as mobile/scripts/setup.js does: one mentions `<script>` in prose.
  const head = html.replace(/<!--[\s\S]*?-->/g, '').split('</head>')[0];
  const script = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('data-session'));
  expect(script).toBeTruthy();
  new Function(script!)();
}

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function token(id: string): string {
  const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ id })}.sig`;
}

const marked = () => document.documentElement.getAttribute('data-session');

beforeEach(() => {
  vi.resetModules();
  apiFetchMock.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute('data-session');
  document.body.innerHTML = `
    <div id="auth-msg"></div><div id="auth-screen" class="auth-screen"></div><div id="app" style="display:none"></div>
    <div id="my-avatar"></div><div id="my-username"></div><div id="my-status-dot"></div><div id="my-tag"></div>
    <div class="auth-tab"></div><div class="auth-tab"></div>`;
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {})));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-session');
});

describe('first paint with and without a stored session', () => {
  it('a stored session marks the document before the first paint', () => {
    localStorage.setItem('token', token('u-1'));
    runHeadScript();
    expect(marked()).toBe('restoring');
  });

  it('no stored session: the sign-in screen paints as before', () => {
    runHeadScript();
    expect(marked()).toBeNull();
  });

  it('the mark takes the sign-in screen out of layout (no paint, no composited glow layers)', () => {
    expect(css).toMatch(/html\[data-session="restoring"\]\s+\.auth-screen\s*\{\s*display:\s*none;\s*\}/);
  });

  it('a bounded fallback reveals the sign-in screen if the app never resolves the session', () => {
    vi.useFakeTimers();
    localStorage.setItem('token', token('u-1'));
    runHeadScript();
    vi.advanceTimersByTime(14_999);
    expect(marked()).toBe('restoring');
    vi.advanceTimersByTime(1);
    expect(marked()).toBeNull();
  });
});

describe('auth-compat clears the mark however the session check ends', () => {
  async function boot(): Promise<void> {
    localStorage.setItem('token', token('u-1'));
    runHeadScript();
    expect(marked()).toBe('restoring');
    await import('../js/core/auth-compat.ts');
    await settle();
  }

  it('valid session: the app starts and the mark is gone', async () => {
    apiFetchMock.mockResolvedValue(response(200, { user: { _id: 'u-1', username: 'ada' } }));
    await boot();
    expect(marked()).toBeNull();
    expect(document.getElementById('app')!.style.display).toBe('flex');
    expect(document.getElementById('auth-screen')!.style.display).toBe('none');
  });

  it('refused session (401): the mark is gone and the sign-in screen is shown', async () => {
    apiFetchMock.mockResolvedValue(response(401, { error: 'no' }));
    await boot();
    expect(marked()).toBeNull();
    expect(document.getElementById('app')!.style.display).toBe('none');
  });

  it('unreachable server: the mark is gone (the sign-in screen is not hidden forever)', async () => {
    apiFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await boot();
    expect(marked()).toBeNull();
  });
});
