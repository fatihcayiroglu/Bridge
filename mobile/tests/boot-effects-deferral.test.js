// mobile/tests/boot-effects-deferral.test.js
//
// #209: the Android shell draws its first frame without shadows, filters,
// backdrop filters and animations, restores them after that frame, and
// re-enables transitions one frame later. Other platforms are untouched.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TEMPLATE = path.resolve(__dirname, '..', 'index.template.html');
const html = fs.readFileSync(TEMPLATE, 'utf8');

function bootScript() {
  // Real tags only: comments in the template also mention `<script>` in prose.
  const scripts = [...html.matchAll(/^[ \t]*<script>([\s\S]*?)<\/script>/gm)].map((m) => m[1]);
  const found = scripts.filter((s) => s.includes('__bridgeBootEffects'));
  expect(found).toHaveLength(1);
  return found[0];
}

function run({ userAgent, readyState = 'loading' }) {
  const attrs = new Map();
  const frames = [];
  const listeners = {};
  const window = {
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
  };
  const context = {
    window,
    navigator: { userAgent },
    performance: { timeOrigin: 1_000, now: () => 250 },
    document: {
      readyState,
      documentElement: {
        setAttribute: (k, v) => attrs.set(k, v),
        removeAttribute: (k) => attrs.delete(k),
      },
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
  };
  vm.runInNewContext(bootScript(), context);
  const frame = () => { const pending = frames.splice(0); pending.forEach((fn) => fn()); };
  return { attrs, frame, listeners, window, pending: () => frames.length };
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UE1A; wv) AppleWebKit/537.36';

test('Android: effects are off from the first parse and come back after the first frame', () => {
  const r = run({ userAgent: ANDROID });
  expect(r.attrs.get('data-boot-effects')).toBe('deferred');
  expect(r.window.__bridgeBootEffects).toEqual({ deferred: true, restoredEpochMs: null });
  expect(r.pending()).toBe(0);

  r.listeners.DOMContentLoaded();
  r.frame(); // the frame that paints the parsed document
  expect(r.attrs.get('data-boot-effects')).toBe('deferred');
  r.frame();
  expect(r.attrs.get('data-boot-effects')).toBe('restoring'); // effects back, transitions still off
  r.frame();
  expect(r.attrs.has('data-boot-effects')).toBe(true);
  r.frame();
  expect(r.attrs.has('data-boot-effects')).toBe(false);
  expect(r.window.__bridgeBootEffects.restoredEpochMs).toBe(1_250);
});

test('Android after DOMContentLoaded already fired: the restore starts at once', () => {
  const r = run({ userAgent: ANDROID, readyState: 'interactive' });
  expect(r.listeners.DOMContentLoaded).toBeUndefined();
  for (let i = 0; i < 4; i++) r.frame();
  expect(r.attrs.has('data-boot-effects')).toBe(false);
});

test.each([
  ['iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'],
  ['desktop', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'],
])('%s: nothing is deferred', (_name, userAgent) => {
  const r = run({ userAgent });
  expect(r.attrs.size).toBe(0);
  expect(r.window.__bridgeBootEffects).toBeUndefined();
  expect(r.pending()).toBe(0);
});

test('the deferred state disables exactly the measured effect classes; restoring keeps only transitions off', () => {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const deferred = /html\[data-boot-effects="deferred"\][^{]*\{([^}]*)\}/.exec(css);
  const any = /html\[data-boot-effects\] \*[^{]*\{([^}]*)\}/.exec(css);
  expect(deferred && any).toBeTruthy();
  const props = (body) => body.split(';').map((d) => d.trim()).filter(Boolean).sort();
  expect(props(deferred[1])).toEqual([
    '-webkit-backdrop-filter: none !important', 'animation: none !important',
    'backdrop-filter: none !important', 'box-shadow: none !important',
    'filter: none !important', 'text-shadow: none !important',
  ]);
  expect(props(any[1])).toEqual(['transition: none !important']);
});
