import { CapacitorConfig } from '@capacitor/cli';

// ÜRETİM: uygulama paketlenir (www/) ve sunucuya `BRIDGE_API_URL` ile bağlanır:
//   BRIDGE_API_URL=https://chat.example.com npm run mobile:sync   (bkz. mobile/BUILD.md §7)
// `BRIDGE_SERVER_URL` (Capacitor `server.url`) YALNIZCA geliştirmede canlı yenileme içindir; Capacitor
// onu üretim için belgelemez ve web uygulaması Bridge yerel köprüsünü (capacitor-bridge.js) yüklemez.
const serverUrl = process.env.BRIDGE_SERVER_URL;

const config: CapacitorConfig = {
  // Uygulama kimligi: yerel projelerle (mobile/android app/build.gradle applicationId/namespace,
  // mobile/ios PRODUCT_BUNDLE_IDENTIFIER) AYNI olmak ZORUNDADIR. Final21 Faz 19'a kadar burada
  // `app.bridge.chat` yaziyordu: `cap add` ile uretilen proje ve FCM/APNs/App Links belgeleri
  // kurulan uygulamadan FARKLI bir kimlige isaret ediyordu (mobile/tests/native-identity.test.js).
  appId: 'com.bridge.app',
  appName: 'Bridge',
  webDir: 'www',
  ...(serverUrl ? { server: { url: serverUrl, cleartext: false } } : {}),
  plugins: {
    // Final21 Faz 19 (19-28): paketlenmiş uygulamanın kökeni https://localhost, API başka bir kökendir.
    // Oturum yenileme çerezi SameSite=strict olduğundan WebView onu çapraz-site isteğe EKLEMEZDİ ve
    // erişim jetonu (15 dk) dolunca oturum düşerdi. REST istekleri ve çerezler yerel HTTP katmanından geçer
    // (CORS ve SameSite tarayıcı kısıtları yerel istekte yoktur); Socket.IO WebSocket'i doğrudan kalır.
    CapacitorHttp: { enabled: true },
    CapacitorCookies: { enabled: true },
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#1a1a2e',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'Dark',
      backgroundColor: '#1a1a2e',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Keyboard: {
      resize: 'body',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    // Kamera ve galeri
    Camera: {
      // iOS: NSCameraUsageDescription ve NSPhotoLibraryUsageDescription
      // Info.plist'e manuel ekle (BUILD.md'ye bakın)
    },
    // Deep link — iOS Universal Links / Android App Links
    // ios/App/App/AppDelegate.swift ve android/app/src/main/AndroidManifest.xml
    // içine URL scheme tanımlamaları gerekir (BUILD.md'ye bakın)
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#1a1a2e',
    // Universal Links için Associated Domains:
    // Xcode → Signing & Capabilities → Associated Domains → applinks:bridge.app
  },
  android: {
    backgroundColor: '#1a1a2e',
    allowMixedContent: false,
    // App Links için: android/app/src/main/AndroidManifest.xml'e intent-filter ekle
    // (BUILD.md'deki talimatları takip edin)
  },
};

export default config;
