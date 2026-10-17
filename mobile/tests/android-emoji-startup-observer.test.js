/**
 * Android #209 A/B: a measurement must not initialize the class it observes.
 *
 * This is a SOURCE contract, not emulator proof. Strict FD01 and ANR01 must
 * still run on real Android. Compare paired exact-head runs with and without
 * static reflection; never treat test green as causal proof.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mainActivity = fs.readFileSync(
  path.join(__dirname, '../android/app/src/main/java/com/bridge/app/MainActivity.java'), 'utf8');
const manifest = fs.readFileSync(
  path.join(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8');

describe('debug-only EmojiCompat observer-effect ablation (Android #209)', () => {
  test('probe cannot invoke or initialize EmojiCompat while sampling', () => {
    const code = mainActivity.slice(mainActivity.indexOf('private void logEmojiStartup('));
    expect(code).toMatch(/Class\.forName\(\s*"androidx\.emoji2\.text\.EmojiCompat"\s*,\s*false\s*,\s*getClassLoader\(\)\s*\)/);
    expect(code).not.toMatch(/getMethod\s*\(/);
    expect(code).not.toMatch(/getDeclaredMethod\s*\(/);
    expect(code).not.toMatch(/\.invoke\s*\(/);
    expect(code).not.toMatch(/Class\.forName\([^;]*,\s*true\s*,/);
    expect(code).toContain('" configured=unknown"');
  });

  test('records lifecycle stages but reports configuration UNKNOWN, not false', () => {
    expect(mainActivity).toContain('logEmojiStartup("before-super")');
    expect(mainActivity).toContain('logEmojiStartup("after-super")');
    expect(mainActivity).toContain('logEmojiStartup("resumed")');
    expect(mainActivity).toMatch(/FLAG_DEBUGGABLE/);
    expect(mainActivity).toContain('"BridgeEmojiStartupProbe"');
    expect(mainActivity).not.toContain('getMethod("isConfigured")');
  });

  test('AndroidX Startup EmojiCompat initializer remains disabled in main manifest', () => {
    expect(manifest).toContain('android:name="androidx.emoji2.text.EmojiCompatInitializer"');
    expect(manifest).toMatch(/android:name="androidx\.emoji2\.text\.EmojiCompatInitializer"\s+tools:node="remove"/);
    expect(manifest).not.toMatch(/android:usesCleartextTraffic="true"/);
  });
});
