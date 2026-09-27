#!/usr/bin/env node
'use strict';

const detected = process.versions.node || '0.0.0';
const [major = 0, minor = 0, patch = 0] = detected.split('.').map(part => Number.parseInt(part, 10) || 0);
const required = [22, 19, 0];
const tooOld = major < required[0]
  || (major === required[0] && minor < required[1])
  || (major === required[0] && minor === required[1] && patch < required[2]);

// server/package-lock.json currently locks undici 8.10.x, whose published
// engine floor is Node >=22.19.0. Keep the project-level guard aligned with
// the lockfile so installs fail early and deterministically instead of later
// with EBADENGINE/runtime drift.
if (tooOld) {
  console.error(`[Bridge] Node >=22.19.0 required. Detected ${detected}.`);
  console.error('[Bridge] Please upgrade Node (for example: nvm use 22.19.0).');
  process.exit(1);
}

console.log(`[Bridge] Node version OK: ${detected}`);
