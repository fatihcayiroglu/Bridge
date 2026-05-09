#!/usr/bin/env node
// mobile/scripts/setup.js
// Capacitor www/ build hazırlık scripti
// v50: DEST path düzeltildi (mobile/www/), index.html korunuyor
const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '../..');
const SRC     = path.join(ROOT, 'client');
const MOBILE  = path.join(ROOT, 'mobile');
const DEST    = path.join(MOBILE, 'www');          // ← DÜZELTİLDİ: mobile/www/
const API_URL = process.env.BRIDGE_API_URL || '';

console.log('🌉 Bridge — Capacitor www/ builder v50');
console.log(`📁 src:  ${SRC}`);
console.log(`📁 dest: ${DEST}`);
if (API_URL) console.log(`🌐 API:  ${API_URL}`);

// Sadece js/ ve css/ alt klasörlerini temizle — index.html'e dokunma
const jsDir  = path.join(DEST, 'js');
const cssDir = path.join(DEST, 'css');
fs.rmSync(jsDir,  { recursive: true, force: true });
fs.rmSync(cssDir, { recursive: true, force: true });
fs.mkdirSync(jsDir,  { recursive: true });
fs.mkdirSync(cssDir, { recursive: true });

// Recursive copy (sadece js/ ve css/ dizinlerini kopyala)
function copyDir(src, dest, opts = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // index.html, sw.js, manifest.json — kök seviyede atla (mobile/www'deki sürüm geçerli)
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

// client/js → www/js
copyDir(path.join(SRC, 'js'), jsDir, { deep: true });
console.log('✅ js/ kopyalandı');

// client/css → www/css
copyDir(path.join(SRC, 'css'), cssDir, { deep: true });
console.log('✅ css/ kopyalandı');

// client/dist/css varsa onu da kopyala (minified)
const distCss = path.join(SRC, 'dist', 'css');
if (fs.existsSync(distCss)) {
  copyDir(distCss, cssDir, { deep: true });
  console.log('✅ dist/css/ kopyalandı');
}

// capacitor-bridge.js → www/js/
const capBridgeSrc = path.join(MOBILE, 'capacitor-bridge.js');
if (fs.existsSync(capBridgeSrc)) {
  fs.copyFileSync(capBridgeSrc, path.join(jsDir, 'capacitor-bridge.js'));
  console.log('✅ capacitor-bridge.js → www/js/ kopyalandı');
}

// sw.js — yoksa client'tan kopyala
const swDest = path.join(DEST, 'sw.js');
if (!fs.existsSync(swDest)) {
  const swSrc = path.join(SRC, 'sw.js');
  if (fs.existsSync(swSrc)) {
    fs.copyFileSync(swSrc, swDest);
    console.log('✅ sw.js kopyalandı');
  }
}

// manifest.json — yoksa client'tan kopyala
const manifestDest = path.join(DEST, 'manifest.json');
if (!fs.existsSync(manifestDest)) {
  const manifestSrc = path.join(SRC, 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, manifestDest);
    console.log('✅ manifest.json kopyalandı');
  }
}

// API URL patch: www/index.html içindeki referansları güncelle
if (API_URL) {
  const indexPath = path.join(DEST, 'index.html');
  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(/http:\/\/localhost:\d+/g, API_URL);
    fs.writeFileSync(indexPath, html);
    console.log(`✅ index.html → API URL güncellendi: ${API_URL}`);
  }
}

console.log(`\n✅ www/ build tamamlandı (${countFiles(DEST)} dosya)`);
console.log('👉 Sonraki adım: npx cap sync');

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}
