#!/usr/bin/env node
// mobile/scripts/apply-android-overlay.js
//
// KÜRATÖRLÜ ANDROID KATMANI — BELGELENEN YOLDA HİÇ UYGULANMIYORDU (Final21 Faz 19)
//
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `android/` her makinede `npx cap add android` ile ÜRETİLİR (.gitignore). Ürünün
// yerel katmanı ise `mobile/android/` altında elle tutulur: izinler (mikrofon, kamera,
// bildirim), derin bağlantı ve App Link süzgeçleri, `allowBackup="false"`, debug ağ
// güvenliği yapılandırması, bildirim ikonu/renkleri ve sürüm eşliği (versionCode 1125000).
// Hiçbir betik ya da belge bu katmanı üretilen projeye uygulamıyordu. `npm run mobile:init`
// ile üretilen APK: kimlik `app.bridge.chat`, sürüm "1.0"/1, `allowBackup="true"`, yalnızca
// INTERNET izni, derin bağlantı YOK — sesli görüşme mikrofonu isteyemezdi. Faz 3'ün emülatör
// kanıtı elle birleştirilmiş bir proje üzerindeydi.
//
// Bu betik `cap add android` SONRASI küratörlü dosyaları üretilen projenin üzerine yazar ve
// önce kimliği doğrular: Capacitor `appId` ile küratörlü `applicationId`/`namespace` farklıysa
// HİÇBİR dosya kopyalanmaz (üretilen `MainActivity` paketi ile küratörlü sınıf ayrışırdı).
//
// Kullanım:
//   node mobile/scripts/apply-android-overlay.js              # android/ yoksa HATA (çıkış 1)
//   node mobile/scripts/apply-android-overlay.js --if-present # android/ yoksa bildirip geçer
//
// Gradle sarmalayıcısı ve AGP sürümü BİLEREK küratörlü değildir: Capacitor iskelesi kendi
// AGP'siyle uyumlu sarmalayıcıyı üretir; elle tutulan bir sabitleme eskir (8.6 < AGP 8.13).

'use strict';

const fs = require('fs');
const path = require('path');

class OverlayError extends Error {}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

function capacitorAppId(root) {
  const configPath = path.join(root, 'capacitor.config.js');
  delete require.cache[require.resolve(configPath)];
  const appId = require(configPath).appId;
  if (typeof appId !== 'string' || !appId) throw new OverlayError(`${configPath}: appId tanımlı değil`);
  return appId;
}

function applyAndroidOverlay({ root = path.resolve(__dirname, '../..'), ifPresent = false, log = console.log } = {}) {
  const overlay = path.join(root, 'mobile', 'android');
  const target = path.join(root, 'android');
  if (!fs.existsSync(path.join(target, 'app'))) {
    if (ifPresent) {
      log('ℹ android/ yok — küratörlü Android katmanı atlandı (önce: npx cap add android)');
      return { copied: [], skipped: true };
    }
    throw new OverlayError('android/ iskelesi yok. Önce "npx cap add android" çalıştırın.');
  }

  const appId = capacitorAppId(root);
  const gradle = fs.readFileSync(path.join(overlay, 'app', 'build.gradle'), 'utf8');
  const applicationId = (/applicationId\s+"([^"]+)"/.exec(gradle) || [])[1];
  const namespace = (/namespace\s+"([^"]+)"/.exec(gradle) || [])[1];
  if (applicationId !== appId || namespace !== appId) {
    throw new OverlayError(
      `Kimlik uyuşmazlığı: capacitor.config.js appId="${appId}", mobile/android/app/build.gradle ` +
      `applicationId="${applicationId}" namespace="${namespace}". Hiçbir dosya kopyalanmadı.`);
  }

  const copied = [];
  for (const rel of listFiles(overlay)) {
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(overlay, rel), dest);
    copied.push(rel.split(path.sep).join('/'));
  }
  log(`✅ Küratörlü Android katmanı uygulandı (${copied.length} dosya, kimlik ${appId})`);
  return { copied, skipped: false };
}

if (require.main === module) {
  try {
    applyAndroidOverlay({ ifPresent: process.argv.includes('--if-present') });
  } catch (err) {
    console.error(`❌ ${err instanceof OverlayError ? err.message : err.stack}`);
    process.exit(1);
  }
}

module.exports = { applyAndroidOverlay, OverlayError };
