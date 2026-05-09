#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '../client/dist');
const jsBudget = Number(process.env.BRIDGE_BUNDLE_JS_BUDGET || 1100 * 1024);
const cssBudget = Number(process.env.BRIDGE_BUNDLE_CSS_BUDGET || 250 * 1024);

function scanSize(dir, extension) {
  let total = 0;
  if (!fs.existsSync(dir)) return total;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += scanSize(fullPath, extension);
      continue;
    }
    if (entry.name.endsWith(extension)) {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

if (!fs.existsSync(distDir)) {
  console.error('[Bridge] client/dist not found. Run build first.');
  process.exit(1);
}

const totalJs = scanSize(distDir, '.js');
const totalCss = scanSize(distDir, '.css');

function toKb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

console.log(`[Bridge] Bundle size report -> JS: ${toKb(totalJs)}, CSS: ${toKb(totalCss)}`);
console.log(`[Bridge] Budget limits      -> JS: ${toKb(jsBudget)}, CSS: ${toKb(cssBudget)}`);

if (totalJs > jsBudget || totalCss > cssBudget) {
  console.error('[Bridge] Bundle budget exceeded.');
  process.exit(1);
}

console.log('[Bridge] Bundle budget check passed.');
