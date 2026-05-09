# Bridge Mobil Uygulama (Capacitor)

Bridge'in iOS ve Android uygulaması **Capacitor** kullanılarak mevcut web kodundan üretilir.
React Native gibi sıfırdan yazılmış bir uygulama değildir — bu sayede web ve mobil özellikler her zaman senkronize kalır.

---

## Mimari

```
bridge-v29/
├── client/          ← Web uygulaması (kaynak)
├── mobile/
│   ├── www/         ← Kopyalanan web dosyaları (Capacitor'ın okuduğu yer)
│   ├── ios/         ← Xcode projesi (cap add ios sonrası oluşur)
│   ├── android/     ← Android Studio projesi (cap add android sonrası)
│   ├── capacitor-bridge.js  ← Native entegrasyonlar
│   ├── capacitor.config.ts
│   └── scripts/setup.js
└── server/
    └── routes/mobilePush.js  ← Native push token endpoint'leri
```

---

## Kurulum

### Gereksinimler

| Platform | Gereksinim |
|----------|------------|
| iOS      | macOS + Xcode 15+ + Apple Developer Account |
| Android  | Android Studio + JDK 17+ |
| Her ikisi | Node.js 18+ |

### Adımlar

```bash
# 1. Mobile dizinine gir
cd mobile

# 2. Bağımlılıkları yükle
npm install

# 3. Web dosyalarını www/ dizinine kopyala
node scripts/setup.js

# 4. Capacitor platformlarını ekle
npx cap add ios
npx cap add android

# 5. Sync et
npx cap sync
```

---

## Geliştirme

### Canlı Yenileme (Live Reload)

Geliştirme sırasında web sunucusundan canlı yükleme için `capacitor.config.ts` dosyasında şu satırı aç:

```typescript
server: {
  url: 'http://192.168.1.X:3001',  // bilgisayarının yerel IP'si
  cleartext: true,
}
```

Sonra:

```bash
npx cap run ios      # veya android
```

### iOS (Xcode)

```bash
npx cap open ios
# Xcode açılır → sol üstten cihaz seç → ▶️ çalıştır
```

### Android (Android Studio)

```bash
npx cap open android
# Android Studio açılır → Run → Run 'app'
```

---

## Native Özellikler

### Push Bildirimleri

`capacitor-bridge.js` otomatik olarak:
1. Kullanıcıdan push bildirimi izni ister
2. Token alır ve `/api/mobile/push/register` endpoint'ine gönderir
3. Uygulama açıkken gelen bildirimleri yerel bildirim olarak gösterir
4. Bildirime tıklandığında ilgili kanala yönlendirir

### Haptic Geri Bildirim

```javascript
// Mesaj gönderirken otomatik tetiklenir
// Manuel kullanım:
window.bridgeHaptic.light();    // hafif
window.bridgeHaptic.success();  // başarı
window.bridgeHaptic.error();    // hata
```

### Çevrimdışı Durumu

Bağlantı kesildiğinde ekranın üstünde kırmızı banner gösterilir.
Bağlantı gelince otomatik kaybolur.

### Android Geri Tuşu

- Modal açıksa → modalı kapat
- Başka durumda → uygulamayı minimize et (kapat değil)

---

## Üretim Build

### iOS (App Store)

1. Xcode'da `Signing & Capabilities` → Apple Developer hesabını bağla
2. `Product → Archive`
3. `Distribute App → App Store Connect`

### Android (Google Play)

1. Android Studio → `Build → Generate Signed Bundle / APK`
2. Keystore oluştur veya mevcut keystoreyi kullan
3. `.aab` dosyasını Play Console'a yükle

---

## Sunucu Ayarları

### Native Push Token Endpoint'leri

```
POST   /api/mobile/push/register    → Token kayıt
DELETE /api/mobile/push/unregister  → Token sil (çıkış)
GET    /api/mobile/info             → Uygulama versiyon bilgisi
```

### Gerekli .env Değişkenleri

```env
# iOS APNs (Apple Push Notification service)
# APNS_KEY_ID=
# APNS_TEAM_ID=
# APNS_KEY_FILE=./certs/apns.p8
# APNS_BUNDLE_ID=app.bridge.chat

# Android / iOS FCM HTTP v1 (Firebase Cloud Messaging)
# Eski FCM_SERVER_KEY artık kullanılmıyor — Temmuz 2025'te kapandı.
# Bunun yerine HTTP v1 + OAuth2 kullan:
# FCM_SERVICE_ACCOUNT_PATH=/etc/bridge/firebase-service-account.json
# FCM_PROJECT_ID=your-firebase-project-id
```

---

## Sık Karşılaşılan Sorunlar

**`cap sync` hatası**: `www/` dizininin boş olmadığını kontrol et (`node scripts/setup.js`)

**iOS'ta beyaz ekran**: `capacitor.config.ts` içinde `server.url` aktifse kaldır (production build'de olmamalı)

**Android'de bildirim gelmiyor**: `google-services.json` dosyasının `android/app/` dizininde olduğunu kontrol et

**Klavye içeriği kapatıyor**: `capacitor.config.ts` → `Keyboard.resize: 'body'` ayarı zaten yapılmış

---

*Bridge — Capacitor 6 — Nisan 2026*
