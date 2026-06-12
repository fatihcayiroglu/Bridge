# Bridge Mobile — Native Push Bildirimleri Kurulum & Test Rehberi

> Sprint 64'te oluşturuldu. `mobile/capacitor-bridge.js` ve
> `server/routes/mobilePush.ts` mevcut; bu belge eksik platform
> dosyalarını ve test kapsamını tanımlar.

---

## Mevcut Durum

| Bileşen | Durum |
|---------|-------|
| `mobile/capacitor-bridge.js` | ✅ Mevcut |
| `server/routes/mobilePush.ts` | ✅ Mevcut (token kayıt + badge sıfırla) |
| `server/lib/pushSender.ts` | ✅ Mevcut |
| `server/tests/mobilePush.test.ts` | ✅ Mevcut |
| iOS `ios/` platform klasörü | ❌ Commit'e dahil değil (`.gitignore`) |
| Android `android/` platform klasörü | ❌ Commit'e dahil değil (`.gitignore`) |
| `GoogleService-Info.plist` | ❌ Secret — `.gitignore`'da |
| `google-services.json` | ❌ Secret — `.gitignore`'da |
| E2E native push testi | ⚠️ Yalnızca API seviyesinde |

Platform klasörlerinin commit'e dahil olmadığı **beklenen davranış** —
bunlar `npx cap add ios` / `npx cap add android` ile üretilir ve her
geliştiricinin kendi ortamında tutulur.

---

## 1. İlk Kurulum (Yeni Ortam)

### 1.1 Bağımlılıklar

```bash
# Kök dizinde
npm install

# Mobile bağımlılıkları
cd mobile && npm install && cd ..

# Capacitor CLI (global)
npm install -g @capacitor/cli
```

### 1.2 Platform Klasörlerini Oluştur

```bash
# iOS (macOS + Xcode 14+ gerektirir)
npx cap add ios

# Android (Android Studio gerektirir)
npx cap add android

# Web varlıklarını kopyala
npx cap sync
```

### 1.3 Firebase Yapılandırması

**iOS — `GoogleService-Info.plist`**

1. [Firebase Console](https://console.firebase.google.com) → Proje → iOS uygulaması ekle
2. Bundle ID: `app.bridge.chat`
3. `GoogleService-Info.plist` indir
4. Xcode'da `ios/App/App/GoogleService-Info.plist` olarak ekle (projeye sürükle)
5. Target → `App`'e dahil et

**Android — `google-services.json`**

1. Firebase Console → Android uygulaması ekle
2. Package: `app.bridge.chat`
3. `google-services.json` indir
4. `android/app/google-services.json` olarak yerleştir

### 1.4 iOS APNs Yapılandırması

```bash
# Xcode'da:
# Target → Signing & Capabilities → + Capability → Push Notifications
# Target → Signing & Capabilities → + Capability → Background Modes
#   → Remote notifications ✓
```

**APNs Key (p8):**

1. [Apple Developer Portal](https://developer.apple.com) → Certificates → Keys → +
2. Apple Push Notifications service (APNs) seç
3. `.p8` dosyasını indir — **yeniden indirilemez, güvenli yerde sakla**
4. `.env`'e ekle:

```env
APNS_KEY_PATH=/secrets/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=YYYYYYYYYY
APNS_BUNDLE_ID=app.bridge.chat
```

### 1.5 Android FCM Yapılandırması

```env
FCM_SERVICE_ACCOUNT_PATH=/secrets/firebase-service-account.json
# veya
FCM_SERVER_KEY=AAAA...  # Legacy key (önerilmez, FCM v1 kullan)
```

---

## 2. `server/lib/pushSender.ts` — Platform Desteği

```typescript
// Mevcut pushSender.ts durumu — her iki platforma da mesaj gönderebilmeli:

// iOS: APNs HTTP/2 API (node-apn veya @parse/node-apn)
// Android: FCM v1 API (googleapis veya firebase-admin)

// Önerilen kütüphaneler:
// npm install @parse/node-apn firebase-admin

// Örnek Firebase Admin başlatma (server/app/setup.ts'e ekle):
import * as admin from 'firebase-admin';
if (process.env.FCM_SERVICE_ACCOUNT_PATH) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
```

---

## 3. `.env.example` — Push Değişkenleri

Aşağıdaki satırlar `.env.example`'a eklenmiştir:

```env
# ── Native Push Bildirimleri (Capacitor) ─────────────────────

# iOS APNs (p8 yöntemi — önerilen)
# APNS_KEY_PATH=/secrets/AuthKey_XXXXXXXXXX.p8
# APNS_KEY_ID=your_10char_key_id
# APNS_TEAM_ID=your_10char_team_id
# APNS_BUNDLE_ID=app.bridge.chat
# APNS_ENV=production          # production | development

# Android FCM v1
# FCM_SERVICE_ACCOUNT_PATH=/secrets/firebase-service-account.json
# FCM_PROJECT_ID=bridge-app-xxxxx

# Native push özellikleri
# NATIVE_PUSH_ENABLED=true
# NATIVE_PUSH_BADGE_RESET=true   # /api/mobile/push/badge-reset endpoint'i aktif et
```

---

## 4. Test Stratejisi

### 4.1 Mevcut Birim Testleri

`server/tests/mobilePush.test.ts` şunları kapsar:

- `POST /api/mobile/push/register` — token kayıt
- `DELETE /api/mobile/push/unregister` — token silme
- `POST /api/mobile/push/badge-reset` — badge sıfırlama
- Geçersiz platform / eksik token → 400 kontrolü

### 4.2 Entegrasyon Testi (Manuel)

Push bildirimi uçtan uca test için:

```bash
# 1. Test token kaydet
curl -X POST http://localhost:3001/api/mobile/push/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token": "fake-device-token", "platform": "android"}'

# 2. Mesaj gönder → bildirim geldi mi kontrol et
# Android Emulator: Extended Controls → Google Play → Push Notifications
# iOS Simulator: simctl push <device_id> app.bridge.chat payload.json
```

**iOS Simulator push payload (`payload.json`):**

```json
{
  "aps": {
    "alert": {
      "title": "Test Bildirimi",
      "body": "Bridge'den test push"
    },
    "badge": 1,
    "sound": "default"
  }
}
```

```bash
# iOS Simulator'a gönder
xcrun simctl push booted app.bridge.chat payload.json
```

### 4.3 Playwright E2E (API Seviyesi)

`e2e/tests/web-push.spec.ts` WebPush'u test ediyor.
Native push için benzer bir spec eklenebilir:

```typescript
// e2e/tests/mobile-push-api.spec.ts (Sprint 65 hedefi)
test('native push token kayıt akışı', async ({ request }) => {
  const res = await request.post('/api/mobile/push/register', {
    headers: { Authorization: `Bearer ${testToken}` },
    data: { token: 'e2e-test-token-ios', platform: 'ios' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});
```

---

## 5. Bilinen Sorunlar & Sonraki Adımlar

| Sorun | Etki | Çözüm |
|-------|------|-------|
| Platform klasörleri commit'te yok | Yeni geliştirici ortam kurulumu belgelenmemişti | Bu belge ✅ |
| APNs gönderim kodu stub | iOS push gerçek cihazda test edilmedi | `node-apn` entegrasyonu Sprint 65 |
| FCM v1 migration | Legacy FCM server key deprekate oldu | `firebase-admin` ile v1 Sprint 65 |
| Badge count senkronizasyonu | `clearBadge()` çağrısı socket disconnect'e bağlı değil | Sprint 65 |
| Bildirim tıklama deep link | `capacitor-bridge.js`'de handler var, test edilmedi | Sprint 65 E2E |

---

## 6. Güvenlik Notları

- `GoogleService-Info.plist` ve `google-services.json` **asla** commit'e ekleme
- APNs `.p8` key **bir kez** indirilebilir, güvenli secret yönetimi kullan
- Token'ları DB'de şifreli saklamak için `server/lib/apKeyEncryption.ts` referans alınabilir
- Kullanıcı logout'ta token **mutlaka** silinmeli (`DELETE /api/mobile/push/unregister`)
