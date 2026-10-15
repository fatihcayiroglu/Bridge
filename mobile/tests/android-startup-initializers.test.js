// mobile/tests/android-startup-initializers.test.js
//
// #209: the curated Android manifest removes AndroidX EmojiCompat's automatic
// start-up initializer. That initializer (androidx.emoji2, pulled in by AppCompat)
// loads an emoji font from Google Play services' font provider while the app
// starts, through a stable content-provider connection; when Play services'
// persistent process died inside that window the emulator killed Bridge with it
// (exit reason DEPENDENCY DIED). Bridge's UI is a WebView, which draws emoji itself.
//
// This is a static lock on the opt-out. Whether the connection is really gone is
// measured on a device by CS01's provider samples (e2e/android/android-journeys.mjs).

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const code = fs.readFileSync(MANIFEST, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');

/** Every <provider …>…</provider> (or self-closing) element, as raw text. */
const providers = [...code.matchAll(/<provider\b[\s\S]*?(?:\/>|<\/provider>)/g)].map((m) => m[0]);
const attr = (element, name) => (new RegExp(`${name}="([^"]*)"`).exec(element) || [])[1] ?? null;

describe('Android start-up initializers (#209)', () => {
  const startup = providers.filter((p) => attr(p, 'android:name') === 'androidx.startup.InitializationProvider');

  it('declares the tools namespace the merge rules need', () => {
    expect(/<manifest\b[^>]*xmlns:tools="http:\/\/schemas\.android\.com\/tools"/.test(code)).toBe(true);
  });

  it('merges into the AndroidX start-up provider instead of replacing it, and keeps it private', () => {
    expect(startup).toHaveLength(1);
    expect({
      merge: attr(startup[0], 'tools:node'),
      authorities: attr(startup[0], 'android:authorities'),
      exported: attr(startup[0], 'android:exported'),
    }).toEqual({ merge: 'merge', authorities: '${applicationId}.androidx-startup', exported: 'false' });
  });

  it('removes only the EmojiCompat initializer; other initializers are left to the libraries', () => {
    const metas = [...startup[0].matchAll(/<meta-data\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(metas.map((m) => [attr(m, 'android:name'), attr(m, 'tools:node')]))
      .toEqual([['androidx.emoji2.text.EmojiCompatInitializer', 'remove']]);
  });
});
