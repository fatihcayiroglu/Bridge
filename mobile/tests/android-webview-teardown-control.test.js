'use strict';

// Android #209: retain a safe debug-only counterfactual. These SOURCE tests
// do not replace strict API34 emulator evidence or assert platform behavior.
const fs = require('fs');
const path = require('path');
const source = path.join(__dirname, '../android/app/src');
const read = name => fs.readFileSync(path.join(source, name), 'utf8');

describe('FD00T WebView destruction baseline cannot modify release behavior', () => {
  const code = read('debug/java/com/bridge/app/WebViewTeardownBaselineActivity.java');
  const manifest = read('debug/AndroidManifest.xml');

  test('debug-only control loads local inert HTML with no Bridge/network/JS', () => {
    const executed = code.split('\n').filter(x => !x.trim().startsWith('//')).join('\n');
    expect(code).toContain('extends android.app.Activity');
    expect(code).toContain('setJavaScriptEnabled(false)');
    expect(code).toMatch(/\bloadDataWithBaseURL\s*\(/);
    expect(code).toContain('<!doctype html>');
    expect(executed).not.toMatch(/\bloadUrl\s*\(/);
    expect(executed).not.toMatch(/https?:\/\//);
    expect(executed).not.toMatch(/BridgeActivity|Capacitor|registerPlugin/);
  });

  test('teardown happens on existing UI thread without killing app or GMS', () => {
    expect(code).toContain('android.os.Looper.getMainLooper()');
    expect(code).toMatch(/mainHandler\.postDelayed\(teardown,\s*3500L\)/);
    expect(code).toContain('root.removeView(view)');
    expect(code).toContain('view.destroy()');
    expect(code).toContain('stage=destroyed');
    expect(code).not.toMatch(/\b(?:killProcess|killBackgroundProcesses|forceStopPackage)\s*\(/);
  });

  test('Activity is only in debug manifest, not release', () => {
    expect(manifest).toContain('android:name="com.bridge.app.WebViewTeardownBaselineActivity"');
    expect(read('main/AndroidManifest.xml')).not.toContain('WebViewTeardownBaselineActivity');
  });

  test('harness keeps teardown measured and FD01 asserting', () => {
    const harness = fs.readFileSync(path.join(__dirname, '../../e2e/android/android-journeys.mjs'), 'utf8');
    expect(harness).toMatch(/await measure\('FD00T'/);
    expect(harness).toContain('FD00T same-process WebView destroy marker unavailable');
    expect(harness).toContain('currentPid === initialPid');
    expect(harness).toContain("await check('FD01'");
  });
});
