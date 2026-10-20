'use strict';

/**
 * Android #209: keep FD00D a nonproduct diagnostic control.
 * Source contracts do not assert any live FontsProvider/Android outcome.
 * Actual evidence requires strict API34 emulator journeys.
 */
const fs = require('fs');
const path = require('path');
const source = path.join(__dirname, '../android/app/src');
const read = rel => fs.readFileSync(path.join(source, rel), 'utf8');

describe('FD00D WebView navigation differential is isolated and noninvasive', () => {
  test('inline HTML control never touches JS, accounts, network or packaged Bridge', () => {
    const code = read('debug/java/com/bridge/app/WebViewDataBaselineActivity.java');
    // Reject forbidden *executed source*, not documentation mentioning the
    // control comparisons (about:blank, Capacitor and Bridge by name).
    const implementation = code.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    expect(code).toContain('extends android.app.Activity');
    expect(code).toMatch(/loadDataWithBaseURL\s*\(/);
    expect(code).toContain('setJavaScriptEnabled(false)');
    expect(code).toContain('<!doctype html>');
    expect(implementation).not.toMatch(/\bloadUrl\s*\(/);
    expect(implementation).not.toMatch(/https?:\/\//);
    expect(implementation).not.toMatch(/BridgeActivity|Capacitor|registerPlugin/);
    expect(code).toMatch(/view\.destroy\(\)/);
  });

  test('component exists only in debug manifest, never release manifest', () => {
    const debug = read('debug/AndroidManifest.xml');
    const main = read('main/AndroidManifest.xml');
    expect(debug).toContain('android:name="com.bridge.app.WebViewDataBaselineActivity"');
    expect(debug).toMatch(/android:name="com\.bridge\.app\.WebViewDataBaselineActivity"[\s\S]*?android:excludeFromRecents="true"/);
    expect(main).not.toContain('WebViewDataBaselineActivity');
  });
});


describe('FD00S data-scheme control is an isolated counterfactual to about:blank', () => {
  test('runs a local base64 data: document with JavaScript disabled and no Bridge assets', () => {
    const code = read('debug/java/com/bridge/app/WebViewDataSchemeBaselineActivity.java');
    const impl = code.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    expect(code).toContain('extends android.app.Activity');
    expect(code).toContain('setJavaScriptEnabled(false)');
    expect(code).toMatch(/\bloadData\s*\(encoded,\s*"text\/html",\s*"base64"\)/);
    expect(code).toContain('Base64.NO_WRAP');
    expect(code).toContain('<!doctype html>');
    expect(impl).not.toMatch(/loadDataWithBaseURL|\bloadUrl\s*\(|https?:\/\/|BridgeActivity|Capacitor|registerPlugin/);
    expect(code).toContain('view.destroy()');
  });

  test('debug manifest only; measurement cannot substitute for strict FD01', () => {
    expect(read('debug/AndroidManifest.xml')).toContain(
      'android:name="com.bridge.app.WebViewDataSchemeBaselineActivity"');
    expect(read('main/AndroidManifest.xml')).not.toContain('WebViewDataSchemeBaselineActivity');
    const journeys = fs.readFileSync(path.join(__dirname, '../../e2e/android/android-journeys.mjs'), 'utf8');
    const measurement = journeys.indexOf("await measure('FD00S'");
    const strictFd01 = journeys.indexOf("await check('FD01'");
    expect(measurement).toBeGreaterThan(0);
    expect(strictFd01).toBeGreaterThan(measurement);
    expect(journeys.slice(measurement, measurement + 1900)).toContain('provider evidence incomplete');
    expect(journeys.slice(strictFd01)).toContain('assert(!evidence.fontProviderConnected');
  });
});
