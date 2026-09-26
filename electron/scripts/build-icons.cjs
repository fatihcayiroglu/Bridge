#!/usr/bin/env node
'use strict';

// Renders electron/assets/icon.svg into the raster icons the Windows build needs:
//   assets/icon.ico  — 16/24/32/48/64/128/256 px, PNG-compressed entries (Vista+)
//   assets/icon.png  — 512 px, BrowserWindow / Linux icon
//   assets/tray.png  — 32 px, notification-area icon (Windows scales it per DPI)
//
// Rendering uses the Chromium that Playwright already installed for the e2e
// suite, so no image dependency is added. Run: node electron/scripts/build-icons.cjs

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const SVG = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function loadChromium() {
  const e2eRequire = require('module').createRequire(path.join(__dirname, '..', '..', 'e2e', 'package.json'));
  return e2eRequire('@playwright/test').chromium;
}

async function render(page, size) {
  await page.setViewportSize({ width: size, height: size });
  const svg = SVG.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  return page.locator('svg').screenshot({ omitBackground: true, type: 'png' });
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

(async () => {
  const browser = await loadChromium().launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const ico = [];
    for (const size of ICO_SIZES) ico.push({ size, png: await render(page, size) });
    fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(ico));
    fs.writeFileSync(path.join(ASSETS, 'icon.png'), await render(page, 512));
    fs.writeFileSync(path.join(ASSETS, 'tray.png'), await render(page, 32));
    console.log(`icons written: icon.ico (${ICO_SIZES.join('/')}), icon.png (512), tray.png (32)`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
