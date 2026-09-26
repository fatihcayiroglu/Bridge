#!/usr/bin/env node
// scripts/check-native-version-parity.mjs
//
// ════════════════════════════════════════════════════════════════════════════
// NATIVE SÜRÜM EŞLİĞİ — ANDROID + iOS, KÖK package.json İLE
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK KUSUR (Final21, Faz 3) ─────────────────────────────────
// Beş `package.json` (kök, server, electron, e2e, mobile) `1.125.0` derken
// NATIVE tarafın ikisi de **1.98.0 / build 114** diyordu:
//
//     mobile/android/app/build.gradle  → versionName "1.98.0", versionCode 114
//     mobile/ios/App/App/Info.plist    → CFBundleShortVersionString 1.98.0
//                                        CFBundleVersion 114
//
// Yani mağazaya yüklenen paket, ürünün YİRMİ YEDİ küçük sürüm GERİSİNDEKİ bir
// numarayı ilan ediyordu. Hiçbir geçit bunu ölçmüyordu: JS tarafındaki sürüm
// eşliğini denetleyen bir kontrol vardı, native taraf ise hiç bakılmayan bir
// kör noktaydı. Kullanıcıya görünen sonuç: "Sürüm 1.98.0" yazan bir hakkında
// ekranı, çöküş raporlarında yanlış sürüm etiketi ve mağazada reddedilen ya da
// yanlış sıralanan yükleme.
//
// ── versionCode / CFBundleVersion NASIL TÜRETİLİR ───────────────────────────
// Google Play ve App Store, sürüm ADINDAN bağımsız olarak MONOTON ARTAN bir
// tamsayı ister. Elle bakılan bir sayaç kaçınılmaz olarak unutulur — nitekim
// unutulmuş. Bu yüzden tamsayı sürümden TÜRETİLİR:
//
//     kod = major * 1_000_000 + minor * 1_000 + patch
//
// `1.125.0` → `1_125_000`. Formül monotondur (semver arttıkça kod artar),
// deterministiktir ve elle güncelleme gerektirmez. Eski `114` değerinden
// büyüktür, dolayısıyla mağaza yüklemesi kırılmaz.
//
// Bu betik hem DENETLER (varsayılan) hem de `--write` ile native dosyaları
// kaynaktan GÜNCELLER. Denetim modunda sapma varsa çıkış kodu 1'dir.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

const GRADLE = path.join(ROOT, 'mobile', 'android', 'app', 'build.gradle');
const PLIST = path.join(ROOT, 'mobile', 'ios', 'App', 'App', 'Info.plist');
// Xcode projesi sürümü İKİNCİ kez taşır (`MARKETING_VERSION`,
// `CURRENT_PROJECT_VERSION`) ve Xcode derlemede bunları `Info.plist`teki
// `$(MARKETING_VERSION)` yerine geçirebilir. İlk sürümde bu dosya
// GÖZDEN KAÇMIŞTI: `Info.plist` düzeltildikten sonra bile pbxproj hâlâ
// "1.98.0" diyordu. Geçit artık ikisini de görür.
const PBXPROJ = path.join(ROOT, 'mobile', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

/** Semver'den monoton mağaza tamsayısı üretir. */
export function versionCodeFor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Sürüm semver değil: ${version}`);
  const [, major, minor, patch] = match.map(Number);
  if (minor > 999 || patch > 999) {
    throw new Error(`versionCode formülü minor/patch < 1000 varsayar: ${version}`);
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string') throw new Error('kök package.json sürüm taşımıyor');
  return pkg.version;
}

const problems = [];
const fixes = [];

function check(label, actual, expected, fix) {
  if (String(actual) === String(expected)) return;
  problems.push(`${label}: "${actual}" ≠ "${expected}"`);
  if (fix) fixes.push(fix);
}

const version = readVersion();
const code = versionCodeFor(version);

// ── Android ────────────────────────────────────────────────────────────────
let gradle = fs.readFileSync(GRADLE, 'utf8');
const gradleName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1];
const gradleCode = /versionCode\s+(\d+)/.exec(gradle)?.[1];

check('android versionName', gradleName, version, () => {
  gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
});
check('android versionCode', gradleCode, code, () => {
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`);
});

// ── iOS ────────────────────────────────────────────────────────────────────
let plist = fs.readFileSync(PLIST, 'utf8');
const plistShort = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
const plistBuild = /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];

check('ios CFBundleShortVersionString', plistShort, version, () => {
  plist = plist.replace(
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${version}$2`,
  );
});
check('ios CFBundleVersion', plistBuild, code, () => {
  plist = plist.replace(
    /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${code}$2`,
  );
});

// ── Xcode projesi ──────────────────────────────────────────────────────────
let pbxproj = fs.existsSync(PBXPROJ) ? fs.readFileSync(PBXPROJ, 'utf8') : null;
if (pbxproj !== null) {
  const marketing = [...pbxproj.matchAll(/MARKETING_VERSION = "?([^";]+)"?;/g)].map((m) => m[1]);
  const current = [...pbxproj.matchAll(/CURRENT_PROJECT_VERSION = "?([^";]+)"?;/g)].map((m) => m[1]);

  const wrongMarketing = marketing.filter((v) => v !== version);
  if (wrongMarketing.length > 0) {
    problems.push(`ios MARKETING_VERSION: ${wrongMarketing.map((v) => `"${v}"`).join(', ')} ≠ "${version}"`);
    fixes.push(() => {
      pbxproj = pbxproj.replace(/MARKETING_VERSION = "?[^";]+"?;/g, `MARKETING_VERSION = "${version}";`);
    });
  }
  const wrongCurrent = current.filter((v) => v !== String(code));
  if (wrongCurrent.length > 0) {
    problems.push(`ios CURRENT_PROJECT_VERSION: ${wrongCurrent.join(', ')} ≠ ${code}`);
    fixes.push(() => {
      pbxproj = pbxproj.replace(/CURRENT_PROJECT_VERSION = "?[^";]+"?;/g, `CURRENT_PROJECT_VERSION = ${code};`);
    });
  }
}

if (problems.length === 0) {
  console.log(`✅ Native sürüm eşliği: ${version} (versionCode/CFBundleVersion ${code}) — Android ve iOS aynı.`);
  process.exit(0);
}

if (!WRITE) {
  console.error('❌ Native sürüm sapması — mağaza paketleri yanlış sürüm ilan eder:');
  for (const problem of problems) console.error(`   · ${problem}`);
  console.error('');
  console.error(`   Beklenen: versionName/CFBundleShortVersionString = ${version}`);
  console.error(`             versionCode/CFBundleVersion           = ${code}`);
  console.error('   Düzeltmek için: node scripts/check-native-version-parity.mjs --write');
  process.exit(1);
}

for (const fix of fixes) fix();
fs.writeFileSync(GRADLE, gradle);
fs.writeFileSync(PLIST, plist);
if (pbxproj !== null) fs.writeFileSync(PBXPROJ, pbxproj);
console.log(`✅ Native sürümler ${version} (kod ${code}) olarak güncellendi:`);
for (const problem of problems) console.log(`   · ${problem}`);
