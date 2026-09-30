#!/usr/bin/env node
// mobile/scripts/apply-ios-overlay.js
//
// P4 — THE CURATED iOS LAYER WAS NEVER APPLIED
//
// `ios/` is generated on each machine by `npx cap add ios` (.gitignore). The product's native
// iOS layer lives in `mobile/ios/` — microphone/camera/photo usage descriptions, the `bridge://`
// URL scheme, background modes and the version — but no script applied it (BUILD.md called the
// files "reference only"). An app built the documented way therefore had NO
// NSMicrophoneUsageDescription: iOS terminates an app the moment it touches the microphone
// without one, i.e. the first voice join would crash. It also had no `bridge://` scheme (deep
// links could not open the app) and shipped as version 1.0 (1).
//
// This script MERGES (it does not overwrite) the curated keys into the generated Info.plist —
// the template's own keys (CAPACITOR_DEBUG, status-bar handling, …) are kept — and aligns the
// project's MARKETING_VERSION / CURRENT_PROJECT_VERSION with the curated project. It first checks
// that the generated bundle identifier is the Capacitor appId; on a mismatch nothing is written.
//
// `voip` is deliberately NOT carried over: that background mode requires PushKit + CallKit, which
// Bridge does not implement, and App Review rejects it otherwise. `audio` and
// `remote-notification` are.
//
// Usage:
//   node mobile/scripts/apply-ios-overlay.js              # ios/ missing → error (exit 1)
//   node mobile/scripts/apply-ios-overlay.js --if-present # ios/ missing → note and skip

'use strict';

const fs = require('fs');
const path = require('path');
const plist = require('plist');

class OverlayError extends Error {}

/** Keys copied verbatim from the curated Info.plist. */
const COPIED_KEYS = [
  'CFBundleDisplayName',
  'NSMicrophoneUsageDescription',
  'NSCameraUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'ITSAppUsesNonExemptEncryption',
];
/** Background modes the product actually implements. */
const ALLOWED_BACKGROUND_MODES = new Set(['audio', 'remote-notification']);

function capacitorAppId(root) {
  const configPath = path.join(root, 'capacitor.config.js');
  delete require.cache[require.resolve(configPath)];
  const appId = require(configPath).appId;
  if (typeof appId !== 'string' || !appId) throw new OverlayError(`${configPath}: appId is not defined`);
  return appId;
}

function curatedVersions(root) {
  const pbx = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
  const marketing = (/MARKETING_VERSION = "?([0-9.]+)"?;/.exec(pbx) || [])[1];
  const build = (/CURRENT_PROJECT_VERSION = (\d+);/.exec(pbx) || [])[1];
  if (!marketing || !build) throw new OverlayError('mobile/ios project.pbxproj carries no MARKETING_VERSION / CURRENT_PROJECT_VERSION');
  return { marketing, build };
}

function mergeUrlSchemes(target, curated) {
  const existing = Array.isArray(target.CFBundleURLTypes) ? target.CFBundleURLTypes : [];
  const schemes = new Set(existing.flatMap((t) => (Array.isArray(t?.CFBundleURLSchemes) ? t.CFBundleURLSchemes : [])));
  const merged = [...existing];
  for (const type of Array.isArray(curated.CFBundleURLTypes) ? curated.CFBundleURLTypes : []) {
    const missing = (type?.CFBundleURLSchemes ?? []).filter((scheme) => !schemes.has(scheme));
    if (missing.length) merged.push({ ...type, CFBundleURLSchemes: missing });
  }
  return merged;
}

function applyIosOverlay({ root = path.resolve(__dirname, '../..'), ifPresent = false, log = console.log } = {}) {
  const infoPath = path.join(root, 'ios', 'App', 'App', 'Info.plist');
  const pbxPath = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(infoPath) || !fs.existsSync(pbxPath)) {
    if (ifPresent) {
      log('ℹ ios/ not present — curated iOS layer skipped (first: npx cap add ios)');
      return { skipped: true };
    }
    throw new OverlayError('ios/ project missing. Run "npx cap add ios" first.');
  }

  const appId = capacitorAppId(root);
  const pbx = fs.readFileSync(pbxPath, 'utf8');
  const bundleIds = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map((m) => m[1]);
  if (!bundleIds.length || bundleIds.some((id) => id !== appId)) {
    throw new OverlayError(`Identity mismatch: capacitor.config.js appId="${appId}", ios project bundle ids=${JSON.stringify(bundleIds)}. Nothing written.`);
  }

  const curated = plist.parse(fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'App', 'Info.plist'), 'utf8'));
  const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
  const applied = [];
  for (const key of COPIED_KEYS) {
    if (curated[key] === undefined) throw new OverlayError(`curated Info.plist has no ${key}`);
    info[key] = curated[key];
    applied.push(key);
  }
  info.CFBundleURLTypes = mergeUrlSchemes(info, curated);
  applied.push('CFBundleURLTypes');
  const modes = new Set([...(Array.isArray(info.UIBackgroundModes) ? info.UIBackgroundModes : []),
    ...(Array.isArray(curated.UIBackgroundModes) ? curated.UIBackgroundModes : [])]);
  info.UIBackgroundModes = [...modes].filter((mode) => ALLOWED_BACKGROUND_MODES.has(mode)).sort();
  applied.push('UIBackgroundModes');
  fs.writeFileSync(infoPath, plist.build(info));

  const { marketing, build } = curatedVersions(root);
  const nextPbx = pbx
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${marketing};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
  fs.writeFileSync(pbxPath, nextPbx);

  log(`✅ Curated iOS layer applied (${applied.join(', ')}; version ${marketing} (${build}); identity ${appId})`);
  return { skipped: false, applied, version: { marketing, build } };
}

if (require.main === module) {
  try {
    applyIosOverlay({ ifPresent: process.argv.includes('--if-present') });
  } catch (err) {
    console.error(`❌ ${err instanceof OverlayError ? err.message : err.stack}`);
    process.exit(1);
  }
}

module.exports = { applyIosOverlay, OverlayError, COPIED_KEYS, ALLOWED_BACKGROUND_MODES };
