// mobile/tests/android-manifest-security.test.js
//
// ANDROID MANIFEST — KİMLİK BİLGİSİ SIZDIRAN YEDEK YOLLARI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK
// ════════════════════════════════════════════════════════════════════════════
// Bridge oturum JWT'si WebView localStorage'ında (`bridge_token`) DİSKTE
// ŞİFRESİZ durur:
//     /data/data/<paket>/app_webview/Local Storage/leveldb/
//
// Manifest'te `android:allowBackup="true"` idi. Bu, taşıyıcı kimlik bilgisinin
// yedek akışlarına girmesi demekti — en önemlisi `adb backup` ile ROOT
// GEREKMEDEN çıkarılabilir olmasıydı (USB hata ayıklama açık bir cihazda).
//
// DÜZELTME:
//   android:allowBackup="false"                        → bulut + adb yedeği
//   android:dataExtractionRules="@xml/..."             → API 31+ cihaz aktarımı
//
// İkisi birlikte gerekir: `allowBackup="false"` API 31+ üzerinde CİHAZDAN
// CİHAZA AKTARIMI tek başına kapatmaz.
//
// ── KAPSAM DÜRÜSTLÜĞÜ ───────────────────────────────────────────────────────
// Bu, token-at-rest ŞİFRELEMESİ DEĞİLDİR. Jeton hâlâ uygulama kum havuzunda
// şifresiz durur ve root'lu cihazda okunabilir. Keychain /
// EncryptedSharedPreferences taşıması GERÇEK CİHAZ DOĞRULAMASI ister; bu
// ortamda cihaz/emülatör yok (`adb` mevcut değil), bu yüzden o iş
// UNSAFE_TO_CHANGE_WITHOUT_RUNTIME_VERIFICATION olarak sınıflandırıldı.
// Burada yalnızca YEDEK YOLUYLA sızıntı kapatılır ve kilitlenir.

'use strict';

const fs = require('fs');
const path = require('path');

const ANDROID = path.join(__dirname, '..', 'android', 'app', 'src', 'main');
const MANIFEST = path.join(ANDROID, 'AndroidManifest.xml');

const manifest = fs.readFileSync(MANIFEST, 'utf8');
/** Yorumları soyar: açıklamada anılan değer GERÇEK öznitelik sayılmamalı. */
const kod = manifest.replace(/<!--[\s\S]*?-->/g, ' ');

const oznitelik = (ad) => {
  const m = new RegExp('android:' + ad + '="([^"]*)"').exec(kod);
  return m ? m[1] : null;
};

describe('AndroidManifest — yedek yoluyla jeton sızıntısı', () => {
  it('allowBackup KAPALI', () => {
    // true olsaydi: adb backup -f out.ab <paket> ile localStorage cikarilir,
    // icinde bridge_token bulunurdu.
    expect({ allowBackup: oznitelik('allowBackup') }).toEqual({ allowBackup: 'false' });
  });

  it('dataExtractionRules TANIMLI (API 31+ cihaz aktarımı)', () => {
    expect({ kural: oznitelik('dataExtractionRules') })
      .toEqual({ kural: '@xml/data_extraction_rules' });
  });

  it('dataExtractionRules dosyası GERÇEKTEN var', () => {
    // Manifest var olmayan bir kaynaga isaret ederse derleme kirilir; ama
    // testin kendisi de bunu yakalamali.
    const p = path.join(ANDROID, 'res', 'xml', 'data_extraction_rules.xml');
    expect({ mevcut: fs.existsSync(p) }).toEqual({ mevcut: true });
  });

  it('HEM bulut yedeği HEM cihaz aktarımı dışlanmış', () => {
    // Yalnizca birini dislamak jetonu diger yoldan sizdirmaya devam ederdi.
    const p = path.join(ANDROID, 'res', 'xml', 'data_extraction_rules.xml');
    const xml = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
    const bolum = (ad) => {
      const m = new RegExp('<' + ad + '>([\\s\\S]*?)</' + ad + '>').exec(xml);
      return m ? m[1] : '';
    };
    expect({
      bulut:  /<exclude\s+domain="root"/.test(bolum('cloud-backup')),
      cihaz:  /<exclude\s+domain="root"/.test(bolum('device-transfer')),
    }).toEqual({ bulut: true, cihaz: true });
  });

  it('uygulama HATA AYIKLANABİLİR olarak işaretlenmemiş', () => {
    // debuggable="true" yayinlanirsa jeton dogrudan okunabilir hale gelir.
    expect({ debuggable: oznitelik('debuggable') }).toEqual({ debuggable: null });
  });

  it('genel açık metin trafiği AÇIK DEĞİL', () => {
    // Acik olsaydi jeton agda duz metin gidebilirdi.
    expect({ cleartext: oznitelik('usesCleartextTraffic') }).toEqual({ cleartext: null });
  });
});

describe('ağ güvenliği yapılandırması', () => {
  // ── FINAL21 EKİ — YAPILANDIRMANIN BAĞLI OLDUĞU DA ÖLÇÜLÜR ────────────────
  // Bu blok eskiden yalnızca dosyanın İÇERİĞİNE bakıyordu. Dosya doğruydu ama
  // hiçbir manifest ona atıfta bulunmuyordu: yani ölü koddu ve emülatörde
  // `http://10.0.2.2:3000` bağlantısı sessizce başarısız oluyordu.
  // Artık ÜÇ şey birlikte kilitli:
  //   1. main manifest açık metin İZNİ TAŞIMAZ (üretim sıkı kalır)
  //   2. debug overlay yapılandırmaya ATIFTA BULUNUR (geliştirme çalışır)
  //   3. yapılandırma yalnızca loopback/emülatör adreslerini içerir
  it('main manifest açık metin izni TAŞIMAZ (üretim sıkı)', () => {
    expect({
      oznitelik: oznitelik('usesCleartextTraffic'),
      yapilandirma: /android:networkSecurityConfig/.test(kod),
    }).toEqual({ oznitelik: null, yapilandirma: false });
  });

  it('debug overlay yapılandırmaya BAĞLIDIR', () => {
    const p = path.join(__dirname, '..', 'android', 'app', 'src', 'debug', 'AndroidManifest.xml');
    const xml = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ') : '';
    expect({
      dosyaVar: fs.existsSync(p),
      bagli: /android:networkSecurityConfig="@xml\/network_security_config"/.test(xml),
    }).toEqual({ dosyaVar: true, bagli: true });
  });

  it('açık metin YALNIZCA yerel geliştirme adreslerinde', () => {
    // localhost + 10.0.2.2 (emulator host) kabul edilebilir; herhangi bir
    // GERCEK alan adi burada olmamali.
    const p = path.join(ANDROID, 'res', 'xml', 'network_security_config.xml');
    const xml = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
    const alanlar = [...xml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map(m => m[1].trim());
    const izinli = ['localhost', '10.0.2.2', '127.0.0.1'];
    expect({ izinsiz: alanlar.filter(a => !izinli.includes(a)) }).toEqual({ izinsiz: [] });
  });
});
