// mobile/tests/deep-link-scheme.test.js
//
// P4 — the app owns the deep-link scheme it advertises, on both platforms.
//
// MEASURED (iOS simulator, CI `Mobile iOS` I06): Apple's Watch app (com.apple.Bridge) declares the
// `bridge` URL scheme. `xcrun simctl openurl … bridge://channel/<id>` failed with OSStatus -10814
// while a unique control scheme on the same build opened: iOS gives the system app the scheme, so
// `bridge://` links can never reach Bridge on an iPhone. `com.bridge.app://` (reverse-DNS, the
// convention Apple recommends against collisions) is declared on iOS and Android and understood by
// the bridge; `bridge://` stays for existing links. Negative control: on the previous files the
// declarations and the parser test fail.

'use strict';

const fs = require('fs');
const path = require('path');
const plist = require('plist');

const ROOT = path.join(__dirname, '..', '..');
const APP_SCHEME = 'com.bridge.app';

describe('app-owned deep-link scheme', () => {
  it('Android declares com.bridge.app:// next to bridge:// in the VIEW / BROWSABLE filter', () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    const filters = manifest.match(/<intent-filter[\s\S]*?<\/intent-filter>/g) ?? [];
    const browsable = filters.filter((f) => f.includes('android.intent.action.VIEW') && f.includes('android.intent.category.BROWSABLE'));
    expect(browsable.some((f) => f.includes(`android:scheme="${APP_SCHEME}"`))).toBe(true);
    expect(browsable.some((f) => f.includes('android:scheme="bridge"'))).toBe(true);
  });

  it('iOS declares com.bridge.app first (bridge:// is owned by com.apple.Bridge on iPhones)', () => {
    const info = plist.parse(fs.readFileSync(path.join(ROOT, 'mobile', 'ios', 'App', 'App', 'Info.plist'), 'utf8'));
    const schemes = (info.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
    expect(schemes[0]).toBe(APP_SCHEME);
    expect(schemes).toContain('bridge');
  });

  it('the bridge routes com.bridge.app:// links exactly like bridge:// links', () => {
    global.Capacitor = { Plugins: {}, getPlatform: () => 'ios' };
    window.Capacitor = global.Capacitor;
    jest.isolateModules(() => { require('../capacitor-bridge.js'); });
    const seen = [];
    const onLink = (e) => seen.push(e.detail);
    window.addEventListener('bridge:deeplink', onLink);
    try {
      window.bridgeDeepLink.handle(`${APP_SCHEME}://channel/ch-1`);
      window.bridgeDeepLink.handle(`${APP_SCHEME}://server/srv-1/channel/ch-2`);
      window.bridgeDeepLink.handle('bridge://channel/ch-3');
    } finally { window.removeEventListener('bridge:deeplink', onLink); }
    expect(seen).toEqual([
      { type: 'navigate:channel', channelId: 'ch-1' },
      { type: 'navigate:channel', serverId: 'srv-1', channelId: 'ch-2' },
      { type: 'navigate:channel', channelId: 'ch-3' },
    ]);
  });
});
