#!/usr/bin/env node
// mobile/scripts/setup.js
// Capacitor www/ build hazırlık scripti
// v52: capacitor-bridge.ts otomatik derlenir
// v51 (Sprint 90): CI sağlamlığı — kaynak dizin yoksa açık hata, exit 1
//   - client/js/ bulunamazsa hata ver (CI'da artifact indirilmemiş demektir)
//   - dist/js/ varsa client/js/'e tercih et (minified build)
//   - Dosya sayısı ve kapBridge varlığı loglanır
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '../..');
const SRC     = path.join(ROOT, 'client');
const MOBILE  = path.join(ROOT, 'mobile');
const DEST    = path.join(MOBILE, 'www');
const API_URL = process.env.BRIDGE_API_URL || '';

console.log('🌉 Bridge — Capacitor www/ builder v52');
console.log(`📁 src:  ${SRC}`);
console.log(`📁 dest: ${DEST}`);
if (API_URL) console.log(`🌐 API:  ${API_URL}`);

// ── Kaynak doğrulama ─────────────────────────────────────────────────────
// CI'da build artifact indirilmeden bu script çalışırsa açık hata vermeli.
// dist/js/ varsa onu (minified), yoksa client/js/'i kullan.
const distJsDir = path.join(SRC, 'dist', 'js');
const srcJsDir  = fs.existsSync(distJsDir) ? distJsDir : path.join(SRC, 'js');

if (!fs.existsSync(srcJsDir)) {
  console.error('');
  console.error('❌ HATA: JS kaynak dizini bulunamadı:');
  console.error(`   ${srcJsDir}`);
  console.error('');
  console.error('CI\'da: build job\'unun artifact\'ını önce indirmeniz gerekiyor.');
  console.error('Local\'de: önce `npm run build` çalıştırın.');
  process.exit(1);
}

const srcCssDir = path.join(SRC, 'css');
if (!fs.existsSync(srcCssDir)) {
  console.error(`❌ HATA: CSS kaynak dizini bulunamadı: ${srcCssDir}`);
  process.exit(1);
}

console.log(`📦 JS kaynak: ${srcJsDir}`);

// ── Temizle & hazırla ────────────────────────────────────────────────────
const jsDir  = path.join(DEST, 'js');
const cssDir = path.join(DEST, 'css');
fs.rmSync(jsDir,  { recursive: true, force: true });
fs.rmSync(cssDir, { recursive: true, force: true });
fs.mkdirSync(jsDir,  { recursive: true });
fs.mkdirSync(cssDir, { recursive: true });

// ── Kopyalama ────────────────────────────────────────────────────────────
function copyDir(src, dest, opts = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!opts.deep && ['index.html', 'sw.js', 'manifest.json'].includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, { deep: true });
    } else {
      let content = fs.readFileSync(s);
      if (API_URL && (entry.name.endsWith('.js') || entry.name.endsWith('.html'))) {
        let text = content.toString('utf8');
        text = text.replace(/http:\/\/localhost:\d+/g, API_URL);
        text = text.replace(/const API\s*=\s*['"][^'"]*['"]/g, `const API = '${API_URL}'`);
        content = Buffer.from(text, 'utf8');
      }
      fs.writeFileSync(d, content);
    }
  }
}

copyDir(srcJsDir, jsDir, { deep: true });
console.log('✅ js/ kopyalandı');

copyDir(srcCssDir, cssDir, { deep: true });
console.log('✅ css/ kopyalandı');

// dist/css varsa üzerine yaz (minified — srcJsDir dist ise zaten oradan geldi)
const distCssDir = path.join(SRC, 'dist', 'css');
if (fs.existsSync(distCssDir) && distCssDir !== srcCssDir) {
  copyDir(distCssDir, cssDir, { deep: true });
  console.log('✅ dist/css/ kopyalandı');
}

// capacitor-bridge.ts → capacitor-bridge.js → www/js/
const capBridgeSrc = path.join(MOBILE, 'capacitor-bridge.js');
const capBridgeTs  = path.join(MOBILE, 'capacitor-bridge.ts');
function buildCapacitorBridge() {
  if (!fs.existsSync(capBridgeTs)) return false;
  try {
    require('esbuild').buildSync({
      entryPoints: [capBridgeTs],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      outfile: capBridgeSrc,
      logLevel: 'silent',
      legalComments: 'none',
    });
    console.log('✅ capacitor-bridge.ts derlendi');
    return true;
  } catch (err) {
    console.warn(`⚠️  capacitor-bridge.ts derlenemedi: ${err && err.message ? err.message : err}`);
    return false;
  }
}

const shouldBuildBridge = fs.existsSync(capBridgeTs) && (
  !fs.existsSync(capBridgeSrc) ||
  fs.statSync(capBridgeTs).mtimeMs > fs.statSync(capBridgeSrc).mtimeMs
);
if (shouldBuildBridge) buildCapacitorBridge();

if (fs.existsSync(capBridgeSrc)) {
  fs.copyFileSync(capBridgeSrc, path.join(jsDir, 'capacitor-bridge.js'));
  console.log('✅ capacitor-bridge.js → www/js/ kopyalandı');
} else {
  console.warn('⚠️  capacitor-bridge.js bulunamadı — native özellikler devre dışı olacak');
}

// sw.js
const swDest = path.join(DEST, 'sw.js');
if (!fs.existsSync(swDest)) {
  const swSrc = path.join(SRC, 'sw.js');
  if (fs.existsSync(swSrc)) { fs.copyFileSync(swSrc, swDest); console.log('✅ sw.js kopyalandı'); }
}

// manifest.json
const manifestDest = path.join(DEST, 'manifest.json');
if (!fs.existsSync(manifestDest)) {
  const manifestSrc = path.join(SRC, 'manifest.json');
  if (fs.existsSync(manifestSrc)) { fs.copyFileSync(manifestSrc, manifestDest); console.log('✅ manifest.json kopyalandı'); }
}

// API URL patch in index.html
if (API_URL) {
  const indexPath = path.join(DEST, 'index.html');
  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(/http:\/\/localhost:\d+/g, API_URL);
    fs.writeFileSync(indexPath, html);
    console.log(`✅ index.html → API URL güncellendi: ${API_URL}`);
  }
}

// ── Sonuç ────────────────────────────────────────────────────────────────
const total = countFiles(DEST);
const capOk = fs.existsSync(path.join(jsDir, 'capacitor-bridge.js'));

console.log('');
console.log(`✅ www/ build tamamlandı`);
console.log(`   📂 Toplam dosya: ${total}`);
console.log(`   📱 capacitor-bridge.js: ${capOk ? '✅' : '❌'}`);
console.log('👉 Sonraki adım: npx cap sync');

// CI'da minimum dosya sayısı garantisi
if (total < 3) {
  console.error('❌ HATA: www/ içinde çok az dosya var. Build başarısız sayılıyor.');
  process.exit(1);
}

function countFiles(dir) {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
    }
  } catch { /* dizin okunamadıysa 0 döner */ }
  return count;
}
