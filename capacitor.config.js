// capacitor.config.js — proje kökünde, Capacitor CLI bunu otomatik bulur.
// `npx cap sync` / `npx cap open ios|android` komutları buradan çalışır.
// Asıl konfigürasyon mobile/capacitor.config.ts içinde; bu dosya runtime uyumluluk shim'idir.

const serverUrl = process.env.BRIDGE_SERVER_URL;

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId:   'app.bridge.chat',
  appName: 'Bridge',
  webDir:  'mobile/www',          // ← kök'ten relative: mobile/www/
  ...(serverUrl ? { server: { url: serverUrl, cleartext: false } } : {}),
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor:    '#1a1a2e',
      androidSplashResourceName: 'splash',
      androidScaleType:   'CENTER_CROP',
      showSpinner:        false,
    },
    StatusBar: {
      style:           'Dark',
      backgroundColor: '#1a1a2e',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Keyboard: {
      resize:              'body',
      style:               'dark',
      resizeOnFullScreen:  true,
    },
  },
  ios: {
    contentInset:    'automatic',
    backgroundColor: '#1a1a2e',
  },
  android: {
    backgroundColor:    '#1a1a2e',
    allowMixedContent:  false,
  },
};

module.exports = config;
