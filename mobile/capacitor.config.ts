import { CapacitorConfig } from '@capacitor/cli';

// Production builds: set BRIDGE_SERVER_URL env var before running `npx cap sync`
// Example: BRIDGE_SERVER_URL=https://chat.example.com npx cap sync
const serverUrl = process.env.BRIDGE_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'app.bridge.chat',
  appName: 'Bridge',
  webDir: 'www',
  ...(serverUrl ? { server: { url: serverUrl, cleartext: false } } : {}),
  plugins: {
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
