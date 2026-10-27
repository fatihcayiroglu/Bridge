// mobile/tests/ios-overlay.test.js
//
// P4 — the curated iOS layer reaches the generated project.
//
// MEASURED: the Info.plist that `npx cap add ios` generates carries no
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
const TEMPLATE = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'assets', 'ios-pods-template.tar.gz');
const SPM_TEMPLATE = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'assets', 'ios-spm-template.tar.gz');

/** A throwaway repo root: the real curated layer + config, and a freshly extracted Capacitor template. */
function sandbox(appId = 'com.bridge.app', template = TEMPLATE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ios-overlay-'));
  fs.mkdirSync(path.join(dir, 'ios'), { recursive: true });
  execFileSync('tar', ['-xzf', template, '-C', path.join(dir, 'ios')]);
  const pbx = path.join(dir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  // `cap add` writes the appId into the project; do the same for the sandbox.
  fs.writeFileSync(pbx, fs.readFileSync(pbx, 'utf8').replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`));
  fs.cpSync(path.join(ROOT, 'mobile', 'ios'), path.join(dir, 'mobile', 'ios'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'capacitor.config.js'), path.join(dir, 'capacitor.config.js'));
  const sdk = path.join('node_modules', '@capacitor', 'ios');
  for (const file of ['package.json', 'Capacitor/Capacitor/CapacitorBridge.swift']) {
    const dest = path.join(dir, sdk, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, sdk, file), dest);
  }
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
    // CocoaPods' template omits this SPM/custom-project key. Keep a concrete
    // existing override as a positive control for non-destructive merging.
    const infoPath = path.join(dir, 'ios', 'App', 'App', 'Info.plist');
    fs.writeFileSync(infoPath, plist.build({ ...readInfo(dir), CAPACITOR_DEBUG: '$(CAPACITOR_DEBUG)' }));
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

  it('uses the local SDK source template and workspace in every new iOS build entry point', () => {
    const dir = sandbox();
    const podfile = fs.readFileSync(path.join(dir, 'ios', 'App', 'Podfile'), 'utf8');
    expect(podfile).toContain("pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'");
    expect(podfile).toContain("pod 'CapacitorCordova', :path => '../../node_modules/@capacitor/ios'");
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    for (const name of ['mobile:init', 'mobile:add']) expect(scripts[name]).toContain('npx cap add ios --packagemanager CocoaPods');
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/mobile-ios.yml'), 'utf8');
    expect(workflow).toContain('npx cap add ios --packagemanager CocoaPods');
    expect(workflow).toContain('xcodebuild -workspace ios/App/App.xcworkspace');
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

  it('refuses prebuilt SwiftPM linkage without changing the project or SDK', () => {
    const dir = sandbox('com.bridge.app', SPM_TEMPLATE);
    const info = path.join(dir, 'ios', 'App', 'App', 'Info.plist');
    const sdk = path.join(dir, 'node_modules', '@capacitor', 'ios', 'Capacitor', 'Capacitor', 'CapacitorBridge.swift');
    const before = [info, sdk].map(file => fs.readFileSync(file, 'utf8'));
    expect(() => applyIosOverlay({ root: dir, log: () => {} })).toThrow('IOS_SOURCE_BUILD_REQUIRED');
    expect([info, sdk].map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('--if-present semantics: no ios/ → skipped, not an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ios-none-'));
    expect(applyIosOverlay({ root: dir, ifPresent: true, log: () => {} })).toEqual({ skipped: true });
    expect(() => applyIosOverlay({ root: dir, log: () => {} })).toThrow(OverlayError);
  });
});
