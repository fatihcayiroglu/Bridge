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
  appId:   'app.bridge.chat',
  appName: 'Bridge',
  // mobile/capacitor.config.ts'de webDir: 'www' (mobile/ klasöründen relative)
  // Kök config'de kök'ten relative olması gerekir:
  webDir:  'mobile/www',

  ...(serverUrl
    ? { server: { url: serverUrl, cleartext: false } }
    : {}),

  plugins: {
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
