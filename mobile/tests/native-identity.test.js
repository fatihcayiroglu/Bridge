// mobile/tests/native-identity.test.js
//
// ════════════════════════════════════════════════════════════════════════════
// KÜRATÖRLÜ YEREL KATMAN BELGELENEN YOLDA GERÇEKTEN UYGULANIYOR MU? (Final21 Faz 19)
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK KUSUR ─────────────────────────────────────────────────
// `npm run mobile:init` (BUILD.md) `npx cap add android` ile STANDART bir iskele üretiyor ve
// `mobile/android/` katmanını HİÇBİR adımda uygulamıyordu. Temiz bir kopyada ölçüldü: üretilen
// proje `applicationId "app.bridge.chat"`, `versionCode 1`/`"1.0"`, `allowBackup="true"`, yalnızca
// INTERNET izni, derin bağlantı süzgeci YOK. Faz 3'ün emülatör kanıtı ELLE birleştirilmiş bir
// proje üzerindeydi. Ayrıca kimlik ikiye bölünmüştü: Capacitor yapılandırması ve FCM/APNs/App Links
// belgeleri `app.bridge.chat`, yerel projeler (Android + iOS) `com.bridge.app` diyordu — belgeyi
// izleyen bir operatör Firebase/APNs'i kurulmayan bir uygulama için kaydederdi.
//
// Küratörlü `app/build.gradle` Capacitor iskelesinin zorunlu parçalarını da taşımıyordu
// (`capacitor.build.gradle` → eklenti modülleri APK'ya girmezdi; google-services koşulsuzdu →
// `google-services.json` olmadan derleme durur) ve Gradle sarmalayıcısını AGP 8.13'ün altında
// bir sürüme (8.6) sabitliyordu.
//
// ── KAPSAM DÜRÜSTLÜĞÜ ───────────────────────────────────────────────────────
// Bu dosya Gradle'ın YERİNE GEÇMEZ. Gerçek kanıt: belgelenen yolla temiz kopyada üretilen APK
// (`tools/p19-android-docpath.sh`, Faz 19 B5).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OVERLAY_SCRIPT = path.join(ROOT, 'mobile/scripts/apply-android-overlay.js');
const { applyAndroidOverlay, OverlayError } = require(OVERLAY_SCRIPT);

const gradle = read('mobile/android/app/build.gradle');
const CANONICAL = /applicationId\s+"([^"]+)"/.exec(gradle)[1];

describe('tek uygulama kimliği', () => {
  it('Capacitor yapılandırmaları, Android ve iOS yerel projeleri aynı kimliği söyler', () => {
    // eslint-disable-next-line global-require
    expect(require(path.join(ROOT, 'capacitor.config.js')).appId).toBe(CANONICAL);
    expect(read('mobile/capacitor.config.ts')).toMatch(new RegExp(`appId:\\s*'${CANONICAL.replace(/\./g, '\\.')}'`));
    expect(/namespace\s+"([^"]+)"/.exec(gradle)[1]).toBe(CANONICAL);
    expect(read('mobile/android/app/src/main/res/values/strings.xml')).toContain(`<string name="package_name">${CANONICAL}</string>`);
    const bundleIds = [...read('mobile/ios/App/App.xcodeproj/project.pbxproj').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "([^"]+)"/g)].map((m) => m[1]);
    expect(bundleIds.length).toBeGreaterThan(0);
    expect(new Set(bundleIds)).toEqual(new Set([CANONICAL]));
  });

  it('operatör belgeleri (FCM, APNs, App Links) başka bir kimlik söylemez', () => {
    for (const doc of ['mobile/NATIVE_PUSH_SETUP.md', 'mobile/README.md', 'mobile/BUILD.md']) {
      const text = read(doc);
      expect({ doc, stale: text.includes('app.bridge.chat') }).toEqual({ doc, stale: false });
    }
    expect(read('mobile/BUILD.md')).toContain(`"TEAMID.${CANONICAL}"`);
    expect(read('mobile/NATIVE_PUSH_SETUP.md')).toContain(`APNS_BUNDLE_ID=${CANONICAL}`);
  });
});

describe('küratörlü app/build.gradle Capacitor iskelesiyle uyumludur', () => {
  it('eklenti modüllerini ve cordova eklenti projesini içerir', () => {
    expect(gradle).toMatch(/^apply from: 'capacitor\.build\.gradle'$/m);
    expect(gradle).toContain("implementation project(':capacitor-cordova-android-plugins')");
    expect(gradle).toContain("dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'");
  });

  it('Firebase sürümü push eklentisinden gelir; ayrı, ayrışan bir sabitleme yoktur', () => {
    expect(gradle).not.toMatch(/^\s*implementation[^\n]*firebase/m);
  });

  it('google-services yalnızca google-services.json varsa uygulanır', () => {
    const lines = gradle.split('\n');
    const applyAt = lines.findIndex((l) => /apply plugin: 'com\.google\.gms\.google-services'/.test(l));
    expect(applyAt).toBeGreaterThan(0);
    expect(lines[applyAt].startsWith('apply')).toBe(false);          // girintili = koşul içinde
    expect(lines.slice(0, applyAt).join('\n')).toMatch(/if \(servicesJSON\.text\) \{\s*$/);
  });

  it('Gradle sarmalayıcısı küratörlü DEĞİLDİR (iskelenin AGP ile uyumlu sürümü kullanılır)', () => {
    expect(fs.existsSync(path.join(ROOT, 'mobile/android/gradle/wrapper/gradle-wrapper.properties'))).toBe(false);
  });
});

describe('apply-android-overlay.js', () => {
  let tmp;
  const scaffold = (root, { appId = CANONICAL } = {}) => {
    fs.mkdirSync(path.join(root, 'mobile'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'mobile/android'), path.join(root, 'mobile/android'), { recursive: true });
    fs.writeFileSync(path.join(root, 'capacitor.config.js'), `module.exports = { appId: '${appId}' };\n`);
    fs.mkdirSync(path.join(root, 'android/app/src/main'), { recursive: true });
    fs.writeFileSync(path.join(root, 'android/app/build.gradle'), 'template\n');
    fs.writeFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), '<manifest allowBackup="true"/>\n');
    fs.writeFileSync(path.join(root, 'android/app/capacitor.build.gradle'), 'generated\n');
    fs.mkdirSync(path.join(root, 'android/gradle/wrapper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'android/gradle/wrapper/gradle-wrapper.properties'), 'distributionUrl=gradle-8.14.3-all.zip\n');
  };
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-overlay-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('her küratörlü dosyayı bayt-bayt yazar, iskelenin ürettiklerine dokunmaz', () => {
    scaffold(tmp);
    const { copied } = applyAndroidOverlay({ root: tmp, log: () => {} });
    expect(copied).toContain('app/build.gradle');
    expect(copied).toContain('app/src/main/AndroidManifest.xml');
    expect(copied).toContain('app/src/debug/AndroidManifest.xml');
    for (const rel of copied) {
      expect(fs.readFileSync(path.join(tmp, 'android', rel))).toEqual(fs.readFileSync(path.join(tmp, 'mobile/android', rel)));
    }
    expect(fs.readFileSync(path.join(tmp, 'android/app/capacitor.build.gradle'), 'utf8')).toBe('generated\n');
    expect(fs.readFileSync(path.join(tmp, 'android/gradle/wrapper/gradle-wrapper.properties'), 'utf8')).toContain('8.14.3');
    expect(fs.readFileSync(path.join(tmp, 'android/app/src/main/AndroidManifest.xml'), 'utf8')).toContain('android:allowBackup="false"');
  });

  it('kimlik uyuşmazlığında HİÇBİR dosya kopyalanmaz', () => {
    scaffold(tmp, { appId: 'app.bridge.chat' });
    expect(() => applyAndroidOverlay({ root: tmp, log: () => {} })).toThrow(OverlayError);
    expect(fs.readFileSync(path.join(tmp, 'android/app/build.gradle'), 'utf8')).toBe('template\n');
  });

  it('android/ yoksa: katı modda hata, --if-present ile bildirip geçer', () => {
    fs.mkdirSync(path.join(tmp, 'mobile'), { recursive: true });
    expect(() => applyAndroidOverlay({ root: tmp, log: () => {} })).toThrow(/npx cap add android/);
    expect(applyAndroidOverlay({ root: tmp, ifPresent: true, log: () => {} })).toEqual({ copied: [], skipped: true });
  });

  it('komut satırı: gerçek depoda android/ yokken katı mod çıkış 1 verir', () => {
    if (fs.existsSync(path.join(ROOT, 'android'))) return;   // geliştirici makinesi: iskele zaten var
    const strict = spawnSync(process.execPath, [OVERLAY_SCRIPT], { encoding: 'utf8' });
    expect(strict.status).toBe(1);
    expect(strict.stderr).toMatch(/npx cap add android/);
    expect(spawnSync(process.execPath, [OVERLAY_SCRIPT, '--if-present'], { encoding: 'utf8' }).status).toBe(0);
  });
});

describe('belgelenen npm komutları katmanı uygular', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const OV = 'node mobile/scripts/apply-android-overlay.js';
  it.each([
    ['mobile:init', `npx cap add android && ${OV} && npx cap sync`],
    ['mobile:add', `npx cap add android && ${OV}`],
    ['mobile:android', `${OV} && npx cap sync android && npx cap open android`],
    ['mobile:sync', `${OV} --if-present && npx cap sync`],
  ])('%s', (name, fragment) => {
    expect(scripts[name]).toContain(fragment);
  });
});
