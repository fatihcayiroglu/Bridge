// mobile/tests/ios-overlay.test.js
//
// P4 — the curated iOS layer reaches the generated project.
//
// MEASURED: the Info.plist that `npx cap add ios` generates (Capacitor 8 SPM template) carries no
// NSMicrophoneUsageDescription / NSCameraUsageDescription and no `bridge://` URL scheme, and no
// script applied `mobile/ios/`. iOS terminates an app that touches the microphone without a usage
// description, so the first voice join of an app built the documented way would crash; deep links
// could not open it. The first test is the negative control on the untouched template.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const plist = require('plist');
const { applyIosOverlay, OverlayError } = require('../scripts/apply-ios-overlay.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'assets', 'ios-spm-template.tar.gz');

/** A throwaway repo root: the real curated layer + config, and a freshly extracted Capacitor template. */
function sandbox(appId = 'com.bridge.app') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ios-overlay-'));
  fs.mkdirSync(path.join(dir, 'ios'), { recursive: true });
  execFileSync('tar', ['-xzf', TEMPLATE, '-C', path.join(dir, 'ios')]);
  const pbx = path.join(dir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  // `cap add` writes the appId into the project; do the same for the sandbox.
  fs.writeFileSync(pbx, fs.readFileSync(pbx, 'utf8').replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`));
  fs.cpSync(path.join(ROOT, 'mobile', 'ios'), path.join(dir, 'mobile', 'ios'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'capacitor.config.js'), path.join(dir, 'capacitor.config.js'));
  return dir;
}
const readInfo = (dir) => plist.parse(fs.readFileSync(path.join(dir, 'ios', 'App', 'App', 'Info.plist'), 'utf8'));

const available = fs.existsSync(TEMPLATE);
const describeIfTemplate = available ? describe : describe.skip;
if (!available) console.warn('[ios-overlay] Capacitor iOS template not installed — skipped (not counted as passing)');

describeIfTemplate('apply-ios-overlay', () => {
  it('NEGATIVE CONTROL: the untouched template has no microphone/camera usage text and no bridge:// scheme', () => {
    const info = readInfo(sandbox());
    expect(info.NSMicrophoneUsageDescription).toBeUndefined();
    expect(info.NSCameraUsageDescription).toBeUndefined();
    expect(JSON.stringify(info.CFBundleURLTypes ?? [])).not.toContain('bridge');
  });

  it('merges the privacy strings, URL scheme and version; keeps the template\'s own keys', () => {
    const dir = sandbox();
    applyIosOverlay({ root: dir, log: () => {} });
    const info = readInfo(dir);
    expect(info.NSMicrophoneUsageDescription).toMatch(/\S/);
    expect(info.NSCameraUsageDescription).toMatch(/\S/);
    expect(info.NSPhotoLibraryUsageDescription).toMatch(/\S/);
    expect(info.CFBundleURLTypes.flatMap((t) => t.CFBundleURLSchemes)).toEqual(['com.bridge.app', 'bridge']);
    expect(info.CFBundleDisplayName).toBe('Bridge');
    expect(info.CAPACITOR_DEBUG).toBe('$(CAPACITOR_DEBUG)');
    expect(info.UIViewControllerBasedStatusBarAppearance).toBe(true);
    const pbx = fs.readFileSync(path.join(dir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx).toMatch(/MARKETING_VERSION = 1\.125\.0;/);
    expect(pbx).toMatch(/CURRENT_PROJECT_VERSION = 1125000;/);
    expect(pbx).not.toMatch(/MARKETING_VERSION = 1\.0;/);
  });

  it('carries only background modes the product implements (no voip without PushKit/CallKit)', () => {
    const dir = sandbox();
    applyIosOverlay({ root: dir, log: () => {} });
    expect(readInfo(dir).UIBackgroundModes).toEqual(['audio', 'remote-notification']);
  });

  it('is idempotent (a second sync does not duplicate the scheme)', () => {
    const dir = sandbox();
    applyIosOverlay({ root: dir, log: () => {} });
    applyIosOverlay({ root: dir, log: () => {} });
    const schemes = readInfo(dir).CFBundleURLTypes.flatMap((t) => t.CFBundleURLSchemes);
    expect(schemes.filter((s) => s === 'bridge')).toHaveLength(1);
  });

  it('refuses a project whose bundle id is not the Capacitor appId (nothing written)', () => {
    const dir = sandbox('app.other.id');
    const before = fs.readFileSync(path.join(dir, 'ios', 'App', 'App', 'Info.plist'), 'utf8');
    expect(() => applyIosOverlay({ root: dir, log: () => {} })).toThrow(OverlayError);
    expect(fs.readFileSync(path.join(dir, 'ios', 'App', 'App', 'Info.plist'), 'utf8')).toBe(before);
  });

  it('--if-present semantics: no ios/ → skipped, not an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ios-none-'));
    expect(applyIosOverlay({ root: dir, ifPresent: true, log: () => {} })).toEqual({ skipped: true });
    expect(() => applyIosOverlay({ root: dir, log: () => {} })).toThrow(OverlayError);
  });
});
