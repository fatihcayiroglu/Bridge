// capacitor.config.js — Kök dizin canonical re-export
//
// Canonical kaynak: mobile/capacitor.config.ts
// Bu dosya sadece Capacitor CLI için bir köprüdür.
// Tüm değişiklikleri mobile/capacitor.config.ts'te yapın.
//
// Neden bu yaklaşım?
//   - Capacitor CLI kök dizindeki .js dosyasını otomatik bulur
//   - mobile/capacitor.config.ts'i doğrudan okuyamaz (TS runtime yok)
//   - Tek kaynak doğrusu: mobile/capacitor.config.ts → burada yansıtılır
//
// mobile/capacitor.config.ts'i değiştirince:
//   1. webDir'in burada da 'mobile/www' (kökten relative) olduğunu kontrol edin
//   2. Ekstra plugin varsa aşağıya ekleyin

'use strict';

const serverUrl = process.env.BRIDGE_SERVER_URL;

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  // Uygulama kimligi: yerel projelerle (mobile/android app/build.gradle applicationId/namespace,
  // mobile/ios PRODUCT_BUNDLE_IDENTIFIER) AYNI olmak ZORUNDADIR. Final21 Faz 19'a kadar burada
  // `app.bridge.chat` yaziyordu: `cap add` ile uretilen proje ve FCM/APNs/App Links belgeleri
  // kurulan uygulamadan FARKLI bir kimlige isaret ediyordu (mobile/tests/native-identity.test.js).
  appId:   'com.bridge.app',
  appName: 'Bridge',
  // mobile/capacitor.config.ts'de webDir: 'www' (mobile/ klasöründen relative)
  // Kök config'de kök'ten relative olması gerekir:
  webDir:  'mobile/www',

  ...(serverUrl
    ? { server: { url: serverUrl, cleartext: false } }
    : {}),

  plugins: {
    // Final21 Faz 19 (19-28): paketlenmiş uygulamanın kökeni https://localhost, API başka bir kökendir.
    // Oturum yenileme çerezi SameSite=strict olduğundan WebView onu çapraz-site isteğe EKLEMEZDİ ve
    // erişim jetonu (15 dk) dolunca oturum düşerdi. REST istekleri ve çerezler yerel HTTP katmanından geçer
    // (CORS ve SameSite tarayıcı kısıtları yerel istekte yoktur); Socket.IO WebSocket'i doğrudan kalır.
    CapacitorHttp: { enabled: true },
    CapacitorCookies: { enabled: true },
    SplashScreen: {
      launchShowDuration:          1500,
      backgroundColor:             '#1a1a2e',
      androidSplashResourceName:   'splash',
      androidScaleType:            'CENTER_CROP',
      showSpinner:                 false,
    },
    StatusBar: {
      style:           'Dark',
      backgroundColor: '#1a1a2e',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Keyboard: {
      resize:             'body',
      style:              'dark',
      resizeOnFullScreen: true,
    },
    Camera: {
      // iOS: NSCameraUsageDescription + NSPhotoLibraryUsageDescription
      // Info.plist'e manuel ekle (BUILD.md'ye bakın)
    },
    // Deep link — iOS Universal Links / Android App Links
    // ios/App/App/AppDelegate.swift ve AndroidManifest.xml'e URL scheme gerekir
  },

  ios: {
    contentInset:    'automatic',
    backgroundColor: '#1a1a2e',
    // Universal Links: Xcode → Signing & Capabilities → Associated Domains
    // → applinks:bridge.app
  },
  android: {
    backgroundColor:   '#1a1a2e',
    allowMixedContent: false,
    // App Links: android/app/src/main/AndroidManifest.xml'e intent-filter ekle
  },
};

module.exports = config;
