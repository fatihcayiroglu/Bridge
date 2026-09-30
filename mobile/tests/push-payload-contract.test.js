// mobile/tests/push-payload-contract.test.js
//
// P4 — the server's FCM payload names resources the Android app really has.
//
// MEASURED: server/lib/pushSender.ts sent `android.notification.icon: 'ic_stat_bridge'` — no such
// drawable exists in the app (its notification icon is `ic_notification`) — and
// `channel_id: 'bridge_default'`, a channel the app never created. Android then falls back to the
// launcher-default icon and files every Bridge push under the generic "Miscellaneous" channel,
// which the user cannot tune or silence separately. Negative control: with the old payload the
// first test fails (`ic_stat_bridge` is not a drawable).
//
// Scope honesty: this proves the NAMES line up. Real FCM delivery to a device needs Firebase
// credentials and a physical/Play-services device — EXTERNAL / UNVERIFIED.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const sender = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'pushSender.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'mobile', 'capacitor-bridge.ts'), 'utf8');
const RES = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res');

const androidBlock = /android:\s*\{\s*notification:\s*\{([\s\S]*?)\}/.exec(sender)?.[1] ?? '';
const field = (name) => new RegExp(`${name}:\\s*'([^']+)'`).exec(androidBlock)?.[1];

describe('FCM android.notification payload ↔ the Android app', () => {
  it('icon names a drawable the app ships', () => {
    const icon = field('icon');
    expect(icon).toBeDefined();
    const drawables = fs.readdirSync(path.join(RES, 'drawable')).map((f) => f.replace(/\.(xml|png|webp)$/, ''));
    expect(drawables).toContain(icon);
  });

  it('channel_id is the channel the bridge creates at launch', () => {
    const channel = field('channel_id');
    const created = /NATIVE_PUSH_CHANNEL_ID\s*=\s*'([^']+)'/.exec(bridge)?.[1];
    expect(channel).toBeDefined();
    expect(created).toBe(channel);
    expect(bridge).toMatch(/createChannel\?\.\(\{\s*id: NATIVE_PUSH_CHANNEL_ID/);
  });

  it('color is the brand color the manifest default uses', () => {
    const colors = fs.readFileSync(path.join(RES, 'values', 'colors.xml'), 'utf8');
    const brand = /<color name="bridge_blue">([^<]+)<\/color>/.exec(colors)?.[1];
    expect(field('color')?.toLowerCase()).toBe(brand?.toLowerCase());
  });

  it('the manifest points FCM\'s default channel at the same id (background data-less pushes)', () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    expect(manifest).toMatch(/com\.google\.firebase\.messaging\.default_notification_channel_id"\s+android:value="bridge_default"/);
  });
});
