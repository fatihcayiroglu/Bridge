#!/usr/bin/env node
'use strict';

const major = Number.parseInt((process.versions.node || '0').split('.')[0], 10);
const requiredMajor = 22;

// Node 22+ uyumlu (24.x de çalışır)
if (major < requiredMajor) {
  console.error(
    `[Bridge] Node ${requiredMajor}.x+ required. Detected ${process.versions.node}.`
  );
  console.error('[Bridge] Please upgrade Node version (nvm use 22).');
  process.exit(1);
}

console.log(`[Bridge] Node version OK: ${process.versions.node}`);
