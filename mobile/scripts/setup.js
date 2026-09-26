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

// ── API KÖKENİ (Final21 Faz 19, 19-28) ──────────────────────────────────────
// Paketlenmiş uygulamanın kökeni `https://localhost`tur (Capacitor). İstemci API tabanını
// `globalThis.BRIDGE_API`den alır (client/js/core/globals.ts getAPI); bu derleme onu HİÇ
// atamıyordu ve uygulama her isteği KENDİNE yapıp açılış ekranında kalıyordu (ölçüldü).
// Artık `www/js/bridge-config.js` üretilir ve uygulama paketinden ÖNCE yüklenir (satır içi
// betik yok — CSP `script-src 'self'` korunur).
let API_BASE = '';
if (API_URL) {
  let parsed = null;
  try { parsed = new URL(API_URL); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.search || parsed.hash || parsed.username || parsed.password) {
    console.error(`❌ HATA: BRIDGE_API_URL geçerli bir http(s) sunucu kökü değil: ${API_URL}`);
    process.exit(1);
  }
  // Düz `http` YALNIZCA geri döngü (loopback) adresinde kabul edilir. Uygulamanın kökeni
  // `https://localhost` olduğundan WebView `ws://` bağlantısını KARIŞIK İÇERİK diye engeller
  // (emülatörde ölçüldü: "attempted to connect to the insecure WebSocket endpoint 'ws://10.0.2.2…'");
  // gerçek zamanlı her şey sessizce ölür ve oturum jetonları açık metinle taşınır. Chromium geri
  // döngü adreslerini karışık içerikten muaf tutar: geliştirmede `adb reverse tcp:PORT tcp:PORT` +
  // `http://localhost:PORT` kullanın.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && !loopback) {
    console.error(`❌ HATA: BRIDGE_API_URL https olmalı (düz http yalnızca localhost için): ${API_URL}`);
    console.error('   Emülatör/cihazda geliştirme: adb reverse tcp:3000 tcp:3000 ve BRIDGE_API_URL=http://localhost:3000');
    process.exit(1);
  }
  API_BASE = parsed.origin + parsed.pathname.replace(/\/+$/, '');
} else {
  console.warn('⚠️  BRIDGE_API_URL verilmedi: paketlenmiş uygulama HİÇBİR sunucuya ulaşamaz');
  console.warn('   (istekler uygulamanın kendi kökenine gider). Yalnızca varlık doğrulaması için uygundur.');
}

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
// www/ is a generated Capacitor web root. Recreate it from source every time so
// stale hashed bundles can never be shipped from the repository.
const jsDir  = path.join(DEST, 'js');
const cssDir = path.join(DEST, 'css');
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(jsDir,  { recursive: true });
fs.mkdirSync(cssDir, { recursive: true });

const mobileIndexTemplate = path.join(MOBILE, 'index.template.html');
if (!fs.existsSync(mobileIndexTemplate)) {
  console.error(`❌ HATA: Mobile index template bulunamadı: ${mobileIndexTemplate}`);
  process.exit(1);
}
fs.copyFileSync(mobileIndexTemplate, path.join(DEST, 'index.html'));
console.log('✅ index.template.html → www/index.html');
// NOT: kabuk BURADA henüz eksiktir. Uygulama paketi referansları ve CSP
// `connect-src` değeri, js/ kopyalandıktan SONRA aşağıda enjekte edilir
// (injectApplicationBundle) ve ardından her yerel referans DOĞRULANIR
// (verifyLocalReferences). Doğrulama başarısızsa build DÜŞER.

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

// ══════════════════════════════════════════════════════════════════════════
// PAKET YERLEŞİMİ — esbuild'in GÖMDÜĞÜ yol korunmalıdır
// ══════════════════════════════════════════════════════════════════════════
//
// ÖLÇÜLEN KUSUR (Final20, tarayıcıda çalıştırılarak bulundu): derlenmiş paket
// `client/dist/js` → `www/js` olarak DÜZLEŞTİRİLİYORDU. Ama `scripts/build.js`
// esbuild'e `publicPath = '/dist/js/'` veriyor; yani TEMBEL YÜKLENEN chunk
// adresleri paketin İÇİNE `dist/js/chunk-<hash>.js` olarak gömülü.
//
// Sonuç: kabuk açılıyor ve giriş ekranı çiziliyordu, ama dinamik `import()`
// ile gelen HER parça 404 veriyordu (ölçüldü: 12 chunk). Bu, statik olarak
// görünmeyen bir kusurdur — yalnızca uygulamayı gerçekten çalıştırınca ortaya
// çıkar. Etkilenen yollar arasında SFU sesli görüşme (mediasoup talebe göre
// yüklenir) ve diğer tembel modüller vardı.
//
// Çözüm: düzleştirme YOK. Derleme çıktısı `www/dist/js` altına, gömülü yolla
// AYNI yerleşimle kopyalanır.
const usingDistBundle = srcJsDir === distJsDir;
const bundleDir = usingDistBundle ? path.join(DEST, 'dist', 'js') : jsDir;
const bundleHrefBase = usingDistBundle ? 'dist/js' : 'js';

fs.mkdirSync(bundleDir, { recursive: true });
copyDir(srcJsDir, bundleDir, { deep: true });
console.log(`✅ ${bundleHrefBase}/ kopyalandı (esbuild publicPath ile hizalı)`);

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
    // Seçenekler tazelik testiyle PAYLAŞILIR (scripts/bridge-build-options.js).
    const { esbuildOptions } = require('./bridge-build-options.js');
    require('esbuild').buildSync({ ...esbuildOptions, entryPoints: [capBridgeTs], outfile: capBridgeSrc });
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

// ── SOCKET.IO İSTEMCİSİ (Final21 Faz 19, 19-28) ─────────────────────────────
// Web'de `/socket.io/socket.io.js`i Socket.IO sunucusu verir; paketlenmiş uygulamada o yol uygulamanın
// kendi kökenine çözülür ve YOKTUR. İstemci `mobile/package.json`da sunucunun `socket.io` sürümüne
// SABİTLENMİŞ olarak bildirilir (mobile/tests/shell-composition.test.js eşliği kilitler).
{
  let socketClient = '';
  // Paketin `exports` haritası dist/socket.io.min.js'i dışa açmaz; kök, dışa açık package.json ile bulunur.
  try {
    const pkgDir = path.dirname(require.resolve('socket.io-client/package.json', { paths: [MOBILE, ROOT] }));
    socketClient = path.join(pkgDir, 'dist', 'socket.io.min.js');
    if (!fs.existsSync(socketClient)) socketClient = '';
  } catch { socketClient = ''; }
  if (!socketClient) {
    console.error('❌ HATA: socket.io-client dağıtımı bulunamadı. Kökte `npm install` çalıştırın.');
    process.exit(1);
  }
  fs.copyFileSync(socketClient, path.join(jsDir, 'socket.io.min.js'));
  console.log('✅ socket.io-client → www/js/socket.io.min.js');
}

if (fs.existsSync(capBridgeSrc)) {
  fs.copyFileSync(capBridgeSrc, path.join(jsDir, 'capacitor-bridge.js'));
  console.log('✅ capacitor-bridge.js → www/js/ kopyalandı');
} else {
  console.warn('⚠️  capacitor-bridge.js bulunamadı — native özellikler devre dışı olacak');
}

// Canonical PWA runtime assets are always copied from client source/build.
// Conditional copies allowed stale checked-in files to survive indefinitely.
for (const name of ['sw.js', 'manifest.json']) {
  const src = path.join(SRC, name);
  const dest = path.join(DEST, name);
  if (!fs.existsSync(src)) {
    console.error(`❌ HATA: ${name} bulunamadı: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.log(`✅ ${name} kopyalandı`);
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

// ══════════════════════════════════════════════════════════════════════════
// UYGULAMA PAKETİ ENJEKSİYONU
// ══════════════════════════════════════════════════════════════════════════
//
// ÖLÇÜLEN KUSUR (Final20): `mobile/index.template.html` elle bakılan 62 adet
// `<script src="js/core/*.js">` etiketi taşıyordu. İstemci çoktan tek bir ESM
// paketine geçmişti (`client/index.dist.html` → `dist/js/app-<hash>.js`), ve
// `www/js/` altında yalnızca hash'li esbuild çıktıları bulunuyordu. Yani
// üretilen mobil kabuk VAR OLMAYAN 62 dosyayı yüklemeye çalışıyordu; uygulama
// splash ekranından sonra hiç açılmıyordu. `setup.js` bunu fark edemiyordu,
// çünkü tek sağlık ölçüsü "www/ içinde en az 3 dosya var mı" idi.
//
// Artık kabuk, GERÇEK derleme çıktısından üretilir ve her yerel referans
// doğrulanır.

/** `www/js` içindeki derlenmiş giriş paketini ve CSS chunk'larını bulur. */
function discoverBundleAssets() {
  const entries = fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir) : [];
  // esbuild girişi: `app-<HASH>.js`; chunk'lar `chunk-<HASH>.js` olarak
  // giriş tarafından import edilir, ayrıca etiketlenmezler.
  const scripts = entries.filter((n) => /^app-[A-Z0-9]+\.js$/i.test(n)).sort();
  const styles = entries.filter((n) => /\.css$/i.test(n)).sort();
  return { scripts, styles };
}

/**
 * Derlenmiş web kabuğunu (`client/index.dist.html`) okur ve mobil kabuğa
 * yerleştirilecek parçalarını çıkarır.
 *
 * TEK DOĞRULUK KAYNAĞI. Mobil kabuk artık uygulama işaretlemesinin kendi
 * kopyasını TUTMAZ; yalnızca mobil-özgü kabuk parçalarını (splash, push
 * banner, ses rozeti, bootstrap) katar.
 */
function readWebShell() {
  const built = path.join(SRC, 'index.dist.html');
  const source = path.join(SRC, 'index.html');
  const shellPath = fs.existsSync(built) ? built : source;
  if (!fs.existsSync(shellPath)) {
    console.error(`❌ HATA: Web kabuğu bulunamadı: ${shellPath}`);
    console.error('   Önce `npm run build` çalıştırın.');
    process.exit(1);
  }
  // Final21 Faz 19 (19-28): kabuk düzenli ifadelerle ayrıştırılır; METİN içindeki etiket benzerleri
  // onları iki kez yanılttı (ikisi de emülatörde ölçüldü):
  //   1. Bir HTML yorumu "CSP: sunucu her <script> etiketine nonce enjekte ediyor" diyordu; satır içi
  //      betik ifadesi yorumun İÇİNDEKİ `<script>` ile eşleşti → "Unexpected identifier 'nonce'" ve
  //      tema önyüklemesi HİÇ çalışmadı. → Yorumlar önce atılır (çalışma zamanında etkisizdirler).
  //   2. Tema betiğinin JS yorumu "// <body> henüz yok" diyordu; gövde ifadesi O `<body>` ile eşleşti,
  //      betiğin kuyruğu mobil ekranın tepesinde DÜZ METİN olarak göründü. → Gövde yalnızca `</head>`den
  //      SONRA aranır; `<head>`/`<body>` etiket adı tam eşleşir (`<header>` yanlışlıkla eşleşmez).
  const html = fs.readFileSync(shellPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const headMatch = html.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i);
  const headEnd = headMatch ? (headMatch.index || 0) + headMatch[0].length : -1;
  const bodyMatch = headEnd === -1 ? null : html.slice(headEnd).match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i);
  if (!headMatch || !bodyMatch) {
    console.error(`❌ HATA: Web kabuğu ayrıştırılamadı: ${shellPath}`);
    process.exit(1);
  }
  const head = headMatch[1];
  // Gövdeden betik etiketleri ÇIKARILIR: paket girişini mobil kabuk kendi
  // sırasıyla (Capacitor runtime'dan sonra) enjekte eder.
  const body = bodyMatch[1].replace(/<script\b[\s\S]*?<\/script>/gi, '');
  // Head'deki SATIR İÇİ bootstrap'ler (tema seçimi + erken hata kuyruğu)
  // korunur; bunlar ilk boyamadan önce çalışmak zorundadır.
  const inlineHeadScripts = (head.match(/<script(?![^>]*\bsrc=)[\s\S]*?<\/script>/gi) || []).join('\n');
  const featureStyles = (head.match(/<link[^>]+rel="stylesheet"[^>]+href="css\/[^"]+"[^>]*>/gi) || []);
  return { inlineHeadScripts, featureStyles, body, shellPath };
}

function injectWebShell(html) {
  const shell = readWebShell();
  const replaceBetween = (source, startMark, endMark, body) => {
    const start = source.indexOf(startMark);
    const end = source.indexOf(endMark);
    if (start === -1 || end === -1 || end < start) {
      console.error(`❌ HATA: index.template.html içinde ${startMark} / ${endMark} işaretleyicileri bulunamadı.`);
      process.exit(1);
    }
    return source.slice(0, start + startMark.length) + '\n' + body + '\n' + source.slice(end);
  };

  let out = replaceBetween(html, '<!-- BRIDGE:APP-MARKUP:START -->', '<!-- BRIDGE:APP-MARKUP:END -->', shell.body);

  // Web kabuğunun stil bağlantılarından mobilde EKSİK olanları ekle.
  const missingStyles = shell.featureStyles.filter((tag) => {
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    return href && !out.includes(`href="${href}"`);
  });
  const headInjection = [shell.inlineHeadScripts, missingStyles.join('\n')].filter(Boolean).join('\n');
  if (headInjection) out = out.replace('</head>', `${headInjection}\n</head>`);

  console.log(`✅ Web kabuğu devralındı: ${path.basename(shell.shellPath)} (${missingStyles.length} ek stil)`);
  return out;
}

function injectApplicationBundle() {
  const indexPath = path.join(DEST, 'index.html');
  let html = injectWebShell(fs.readFileSync(indexPath, 'utf8'));
  const { scripts, styles } = discoverBundleAssets();

  if (scripts.length === 0) {
    console.error('');
    console.error(`❌ HATA: Derlenmiş uygulama girişi bulunamadı (www/${bundleHrefBase}/app-<hash>.js).`);
    console.error('   Önce `npm run build` çalıştırın; mobil kabuk derleme çıktısına bağlıdır.');
    process.exit(1);
  }

  // API yapılandırması, modül betiklerinden (ertelenmiş) ÖNCE çalışan klasik bir betiktir.
  const configTag = API_BASE ? '<script src="js/bridge-config.js"></script>\n' : '';
  if (API_BASE) {
    fs.writeFileSync(path.join(jsDir, 'bridge-config.js'),
      `// Üretildi: mobile/scripts/setup.js (BRIDGE_API_URL)\nglobalThis.BRIDGE_API = ${JSON.stringify(API_BASE)};\n`);
  }
  const scriptTags = configTag + scripts
    .map((name) => `<script type="module" src="${bundleHrefBase}/${name}"></script>`)
    .join('\n');
  const styleTags = styles
    .map((name) => `  <link rel="stylesheet" href="${bundleHrefBase}/${name}">`)
    .join('\n');

  const replaceBetween = (source, startMark, endMark, body) => {
    const start = source.indexOf(startMark);
    const end = source.indexOf(endMark);
    if (start === -1 || end === -1 || end < start) {
      console.error(`❌ HATA: index.template.html içinde ${startMark} / ${endMark} işaretleyicileri bulunamadı.`);
      process.exit(1);
    }
    return source.slice(0, start + startMark.length) + '\n' + body + '\n' + source.slice(end);
  };

  html = replaceBetween(html, '<!-- BRIDGE:APP-SCRIPTS:START -->', '<!-- BRIDGE:APP-SCRIPTS:END -->', scriptTags);
  html = replaceBetween(html, '<!-- BRIDGE:APP-STYLES:START -->', '<!-- BRIDGE:APP-STYLES:END -->', styleTags);

  // CSP `connect-src`: API kaynağı biliniyorsa YALNIZCA o kaynak izinlenir.
  let connectSrc = "'self' https: wss: ws:";
  if (API_URL) {
    try {
      const origin = new URL(API_URL).origin;
      const wsOrigin = origin.replace(/^http/, 'ws');
      connectSrc = `'self' ${origin} ${wsOrigin}`;
    } catch {
      console.warn(`⚠️  BRIDGE_API_URL ayrıştırılamadı (${API_URL}); connect-src geniş bırakıldı.`);
    }
  }
  html = html.replace('__BRIDGE_CONNECT_SRC__', connectSrc);
  // Sunucudaki görseller/sesler de API kökeninden gelir; `https:` genel izni http geliştirme
  // sunucusunu (ör. emülatörde 10.0.2.2) kapsamaz.
  if (API_BASE) {
    const apiOrigin = new URL(API_BASE).origin;
    html = html.replace(/(img-src[^;]*);/, `$1 ${apiOrigin};`).replace(/(media-src[^;]*);/, `$1 ${apiOrigin};`);
  }

  fs.writeFileSync(indexPath, html);
  console.log(`✅ Uygulama paketi enjekte edildi: ${scripts.length} giriş, ${styles.length} stil`);
  console.log(`✅ CSP connect-src: ${connectSrc}`);
}

/**
 * Üretilen kabuktaki HER yerel referansın gerçekten var olduğunu doğrular.
 *
 * Bu, bu dosyadaki en önemli kontroldür: mobil kabuğun sessizce bozulmasına
 * izin veren şey tam olarak böyle bir doğrulamanın YOKLUĞUYDU.
 */
function verifyLocalReferences() {
  const indexPath = path.join(DEST, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const refs = [];
  const patterns = [/<script[^>]+src="([^"]+)"/g, /<link[^>]+href="([^"]+)"/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) refs.push(match[1]);
  }

  const missing = [];
  const external = [];
  for (const ref of refs) {
    if (/^(?:https?:)?\/\//.test(ref) || ref.startsWith('data:')) { external.push(ref); continue; }
    // `capacitor.js` `npx cap sync`
    // tarafından yerleştirilir. Ikisi de www/ icinde beklenmez.
    // Final21 Faz 19 (19-28): `/socket.io/socket.io.js` muafiyeti KALDIRILDI — paketlenmiş uygulamada
    // sunucudan gelen betik YOKTUR; öyle bir atıf derlemeyi düşürmelidir.
    if (ref === 'capacitor.js') continue;
    const clean = ref.split('?')[0].split('#')[0].replace(/^\.?\//, '');
    if (!fs.existsSync(path.join(DEST, clean))) missing.push(ref);
  }

  if (external.length) {
    console.error('');
    console.error('❌ HATA: Mobil kabuk ÜÇÜNCÜ TARAF bir kaynaktan varlık yüklüyor:');
    for (const ref of external) console.error(`   ${ref}`);
    console.error('');
    console.error('   Mobil uygulama çalışma zamanında uzak betik ÇALIŞTIRMAMALIDIR:');
    console.error('   çevrimdışı kırılır, tedarik zinciri riski taşır ve CSP\'yi zayıflatır.');
    process.exit(1);
  }

  if (missing.length) {
    console.error('');
    console.error('❌ HATA: Mobil kabuk VAR OLMAYAN dosyalara referans veriyor:');
    for (const ref of missing) console.error(`   ${ref}`);
    console.error('');
    console.error('   Uygulama bu haliyle açılmaz. `npm run build` çalıştırıp tekrar deneyin.');
    process.exit(1);
  }

  console.log(`✅ Kabuk referansları doğrulandı: ${refs.length} referans, eksik yok`);
}

injectApplicationBundle();
verifyLocalReferences();

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
