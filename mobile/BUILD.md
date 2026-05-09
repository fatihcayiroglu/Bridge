# Bridge — Mobil Native Build Kılavuzu

## Ön Koşullar
- Node.js 18+
- Xcode 15+ (iOS, sadece macOS)
- Android Studio Hedgehog+ (Android)
- Java 17+

## 1. Bağımlılıkları yükle

```bash
npm install
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android \
  @capacitor/push-notifications @capacitor/status-bar @capacitor/splash-screen \
  @capacitor/keyboard @capacitor/network @capacitor/haptics \
  @capacitor/camera @capacitor/filesystem
```

## 2. www/ dizinini hazırla

```bash
node mobile/scripts/setup.js
```

Bu script:
- client/ dosyalarını www/ dizinine kopyalar
- API URL'ini production URL ile değiştirir
- Service worker'ı ayarlar

## 3. Native platformları ekle / senkronize et

```bash
# İlk kez (ios/ ve android/ dizinlerini oluşturur)
npm run mobile:init
# Yukarıdaki şununla eşdeğer:
#   node mobile/scripts/setup.js && npx cap add ios && npx cap add android && npx cap sync

# Her kod güncellemesinde
npm run mobile:sync
```

> **Not:** `ios/` ve `android/` dizinleri `.gitignore`'da — her makinede `mobile:init` çalıştırılmalı.

## 4. iOS Build (macOS gerektirir)

```bash
npx cap open ios
# Xcode açılır
# → Signing & Capabilities → Team seç
# → Product → Archive → TestFlight'a yükle
```

### Info.plist izinleri (Xcode'da ekle):
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Sesli konuşmalar için mikrofon gereklidir.</string>
<key>NSCameraUsageDescription</key>
<string>Profil fotoğrafı ve video için kamera gereklidir.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Fotoğraf göndermek için galeri erişimi gereklidir.</string>
```

## 5. Android Build

```bash
npx cap open android
# Android Studio açılır
# → Build → Generate Signed Bundle/APK
# → Google Play Console → Internal Testing
```

### AndroidManifest.xml izinleri (otomatik eklenir):
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

## 6. Push Notification Kurulumu

### Firebase (Android + iOS)
1. Firebase Console → Proje oluştur
2. Android app ekle → `google-services.json` → `android/app/` dizinine koy
3. iOS app ekle → `GoogleService-Info.plist` → `ios/App/App/` dizinine koy
4. Firebase Console → Project Settings → Service Accounts → **Generate new private key** (JSON indir)
5. `.env` dosyasına ekle:
   ```
   # Seçenek A — dosya yolu (önerilen)
   FCM_SERVICE_ACCOUNT_PATH=/secrets/firebase-service-account.json
   FCM_PROJECT_ID=your-firebase-project-id

   # Seçenek B — JSON içeriği tek satır (Docker secret olmadan)
   # FCM_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
   # FCM_PROJECT_ID=your-firebase-project-id
   ```

> **Not:** Bridge, iOS push'larını da FCM HTTP v1 API üzerinden gönderir (doğrudan APNs değil).
> `GoogleService-Info.plist` Xcode projesine eklenince iOS APNs desteği FCM üzerinden otomatik çalışır.

### Web Push / VAPID (tarayıcı bildirimleri)
```bash
npm run vapid:generate
# Çıktıyı .env dosyasına ekle:
# VAPID_PUBLIC_KEY=...
# VAPID_PRIVATE_KEY=...
# VAPID_SUBJECT=mailto:admin@bridge.app
```

## 7. Production API URL

`mobile/scripts/setup.js` çalıştırıldığında `BRIDGE_API_URL` env değişkenini okur.

```bash
BRIDGE_API_URL=https://yourdomain.com node mobile/scripts/setup.js
```

## 8. Canlı Geliştirme (Hot Reload)

```bash
# .env veya capacitor.config.ts'de:
# server.url = 'http://192.168.x.x:3001'
npx cap run android --livereload --external
npx cap run ios --livereload --external
```

---

## 9. Deep Link Kurulumu

### iOS (Universal Links)
1. Xcode → `Signing & Capabilities` → `+ Capability` → **Associated Domains**
2. `applinks:bridge.app` ekle
3. Sunucunuzda `/.well-known/apple-app-site-association` dosyası yayınlayın:
```json
{
  "applinks": {
    "apps": [],
    "details": [{ "appID": "TEAMID.app.bridge.chat", "paths": ["/invite/*", "/channel/*", "/dm/*"] }]
  }
}
```

### Android (App Links)
`android/app/src/main/AndroidManifest.xml` içinde `<activity>` tag'ine ekleyin:
```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="bridge.app" android:pathPrefix="/invite" />
  <data android:scheme="https" android:host="bridge.app" android:pathPrefix="/channel" />
</intent-filter>
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="bridge" />
</intent-filter>
```

---

## 10. Biometric Auth Kurulumu

```bash
npm install @aparajita/capacitor-biometric-auth
npx cap sync
```

### iOS
`Info.plist`'e ekleyin:
```xml
<key>NSFaceIDUsageDescription</key>
<string>Bridge'e hızlı giriş için Face ID kullanılır.</string>
```

### Android
`AndroidManifest.xml`'e ekleyin:
```xml
<uses-permission android:name="android.permission.USE_BIOMETRIC" />
```

Web kodunda kullanım:
```javascript
// Biometric girişi etkinleştir (ayarlar sayfasında)
await window.bridgeBiometric.enable();

// Giriş sırasında kullan
const result = await window.bridgeBiometric.authenticate();
if (result.success) { /* girişe izin ver */ }
```

---

## 11. Kamera & Galeri Kurulumu

```bash
npm install @capacitor/camera
npx cap sync
```

### iOS — Info.plist
```xml
<key>NSCameraUsageDescription</key>
<string>Fotoğraf ve video göndermek için kamera gereklidir.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Fotoğraf göndermek için galeri erişimi gereklidir.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Video çekmek için mikrofon gereklidir.</string>
```

HTML'de kullanım:
```html
<!-- Kamera butonu -->
<button data-native-camera>📷 Fotoğraf Çek</button>
<!-- Galeri butonu -->
<button data-native-gallery>🖼 Galeriden Seç</button>
```

JS'de kullanım:
```javascript
button.addEventListener('bridge:file:selected', async (e) => {
  const { file } = e.detail;
  // file: File objesi — normal upload akışına ver
  await uploadFile(file);
});
```

---

## 12. Badge Sayacı Kurulumu

```bash
npm install @capawesome/capacitor-badge
npx cap sync
```

### iOS — Info.plist
```xml
<key>UIBackgroundModes</key>
<array><string>remote-notification</string></array>
```

Otomatik çalışır — push gelince artар, uygulama açılınca sıfırlanır.
Manuel kullanım:
```javascript
window.bridgeBadge.set(5);   // badge = 5
window.bridgeBadge.clear();  // badge = 0
```

---

## 13. Share Sheet

```bash
npm install @capacitor/share
npx cap sync
```

Kullanım:
```javascript
// Davet linki paylaş
await window.bridgeShare.shareInvite('abc123');

// Mesaj paylaş
await window.bridgeShare.shareMessage(message);
```
