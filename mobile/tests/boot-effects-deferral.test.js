// mobile/tests/boot-effects-deferral.test.js
//
// #209: the Android shell keeps shadows, filters, backdrop filters and
// animations off until the page has window focus (so the cold-start focus
// event has already been handled), or until the first user input, or a
// bounded fallback. Transitions return one frame after the effects. Other
// platforms are untouched.

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

function run({ userAgent, readyState = 'loading', hasFocus = false, now = 250 }) {
  const attrs = new Map();
  const frames = [];
  const docListeners = {};
  const winListeners = {};
  const timers = [];
  const window = {
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    addEventListener: (type, fn) => { (winListeners[type] ||= new Set()).add(fn); },
    removeEventListener: (type, fn) => { winListeners[type]?.delete(fn); },
  };
  const context = {
    window,
    navigator: { userAgent },
    performance: { timeOrigin: 1_000, now: () => now },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; },
    document: {
      readyState,
      hasFocus: () => hasFocus,
      documentElement: {
        setAttribute: (k, v) => attrs.set(k, v),
        removeAttribute: (k) => attrs.delete(k),
      },
      addEventListener: (type, fn) => { docListeners[type] = fn; },
    },
  };
  vm.runInNewContext(bootScript(), context);
  const frame = () => { const pending = frames.splice(0); pending.forEach((fn) => fn()); };
  const fire = (type) => [...(winListeners[type] ?? [])].forEach((fn) => fn());
  const restoredAfterFrames = () => { for (let i = 0; i < 4; i++) frame(); return !attrs.has('data-boot-effects'); };
  return { attrs, frame, fire, docListeners, winListeners, timers, window, restoredAfterFrames, pending: () => frames.length };
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UE1A; wv) AppleWebKit/537.36';

test('Android: effects stay off through load and paint while window focus is still pending', () => {
  const r = run({ userAgent: ANDROID });
  expect(r.attrs.get('data-boot-effects')).toBe('deferred');
  expect(r.window.__bridgeBootEffects).toEqual({ deferred: true, restoredEpochMs: null, trigger: null });

  r.docListeners.DOMContentLoaded(); // no focus yet: the focus event is still queued
  for (let i = 0; i < 6; i++) r.frame();
  expect(r.attrs.get('data-boot-effects')).toBe('deferred');
  expect(r.window.__bridgeBootEffects.trigger).toBeNull();
});

test('Android: window focus restores effects, then transitions one frame later', () => {
  const r = run({ userAgent: ANDROID });
  r.docListeners.DOMContentLoaded();
  r.fire('focus');
  expect(r.window.__bridgeBootEffects.trigger).toBe('focus');
  r.frame();
  expect(r.attrs.get('data-boot-effects')).toBe('deferred');
  r.frame();
  expect(r.attrs.get('data-boot-effects')).toBe('restoring'); // effects back, transitions still off
  r.frame(); r.frame();
  expect(r.attrs.has('data-boot-effects')).toBe(false);
  expect(r.window.__bridgeBootEffects.restoredEpochMs).toBe(1_250);
  // One restore only: listeners and the fallback are released.
  expect(r.winListeners.focus.size).toBe(0);
  expect(r.timers.every((t) => t.cleared)).toBe(true);
});

test('Android: a page that loads after the window already has focus restores at once', () => {
  const r = run({ userAgent: ANDROID, readyState: 'interactive', hasFocus: true });
  expect(r.docListeners.DOMContentLoaded).toBeUndefined();
  expect(r.window.__bridgeBootEffects.trigger).toBe('focused-at-load');
  expect(r.restoredAfterFrames()).toBe(true);
});

test.each(['pointerdown', 'keydown'])('Android: first user input (%s) restores effects', (type) => {
  const r = run({ userAgent: ANDROID });
  r.docListeners.DOMContentLoaded();
  r.fire(type);
  expect(r.window.__bridgeBootEffects.trigger).toBe('input');
  expect(r.restoredAfterFrames()).toBe(true);
});

test('Android: a bounded fallback restores effects when focus and input never come', () => {
  const r = run({ userAgent: ANDROID, now: 2_500 });
  expect(r.timers).toHaveLength(1);
  expect(r.timers[0].ms).toBe(7_500); // 10 s from navigation start
  r.timers[0].fn();
  expect(r.window.__bridgeBootEffects.trigger).toBe('fallback');
  expect(r.restoredAfterFrames()).toBe(true);
  r.fire('focus'); // a later focus does not restart anything
  expect(r.window.__bridgeBootEffects.trigger).toBe('fallback');
});

test.each([
  ['iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'],
  ['desktop', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'],
])('%s: nothing is deferred', (_name, userAgent) => {
  const r = run({ userAgent });
  expect(r.attrs.size).toBe(0);
  expect(r.window.__bridgeBootEffects).toBeUndefined();
  expect(r.pending()).toBe(0);
  expect(r.timers).toHaveLength(0);
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
