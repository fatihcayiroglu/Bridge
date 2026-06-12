// mobile/tests/__mocks__/capacitor-plugins.js
//
// @capacitor/* plugin mock'ları — her plugin kendi jest.fn() metotlarıyla.
// İçe aktarım: const { PushNotifications } = require('./capacitor-plugins');
//
// Kullanım: jest.mock('@capacitor/push-notifications', () => require('./__mocks__/capacitor-plugins').PushNotificationsModule);

'use strict';

const { WebPlugin } = require('./@capacitor/core');

// ── PushNotifications ────────────────────────────────────────────────────────
class PushNotificationsPlugin extends WebPlugin {
  requestPermissions = jest.fn().mockResolvedValue({ receive: 'granted' });
  register           = jest.fn().mockResolvedValue(undefined);
  getDeliveredNotifications = jest.fn().mockResolvedValue({ notifications: [] });
  removeDeliveredNotifications = jest.fn().mockResolvedValue(undefined);
  removeAllDeliveredNotifications = jest.fn().mockResolvedValue(undefined);
}

const PushNotificationsModule = {
  PushNotifications: new PushNotificationsPlugin(),
};

// ── Network ──────────────────────────────────────────────────────────────────
class NetworkPlugin extends WebPlugin {
  getStatus = jest.fn().mockResolvedValue({ connected: true, connectionType: 'wifi' });
}

const NetworkModule = {
  Network: new NetworkPlugin(),
};

// ── App ──────────────────────────────────────────────────────────────────────
class AppPlugin extends WebPlugin {
  getInfo    = jest.fn().mockResolvedValue({ id: 'app.bridge.chat', name: 'Bridge', build: '1', version: '45.0.0' });
  getState   = jest.fn().mockResolvedValue({ isActive: true });
  exitApp    = jest.fn();
  minimizeApp = jest.fn();
  getLaunchUrl = jest.fn().mockResolvedValue(null);
}

const AppModule = {
  App: new AppPlugin(),
};

// AppPlugin._emit yoksa WebPlugin base'inden geliyor; deep link testleri için
// appUrlOpen event'ini tetiklemek amacıyla kullanılır.

// ── BiometricAuth ─────────────────────────────────────────────────────────────
class BiometricAuthPlugin extends WebPlugin {
  checkBiometry = jest.fn().mockResolvedValue({
    isAvailable: true,
    biometryType: 'touchId',
    reason: '',
    code: 0,
  });
  authenticate = jest.fn().mockResolvedValue(undefined);
}

const BiometricAuthModule = {
  BiometricAuth: new BiometricAuthPlugin(),
};

// ── Haptics ──────────────────────────────────────────────────────────────────
class HapticsPlugin extends WebPlugin {
  vibrate  = jest.fn().mockResolvedValue(undefined);
  impact   = jest.fn().mockResolvedValue(undefined);
  selectionStart  = jest.fn().mockResolvedValue(undefined);
  selectionEnd    = jest.fn().mockResolvedValue(undefined);
}

const HapticsModule = {
  Haptics: new HapticsPlugin(),
};

// ── Badge ─────────────────────────────────────────────────────────────────────
class BadgePlugin extends WebPlugin {
  set   = jest.fn().mockResolvedValue(undefined);
  clear = jest.fn().mockResolvedValue(undefined);
  get   = jest.fn().mockResolvedValue({ count: 0 });
}

const BadgeModule = {
  Badge: new BadgePlugin(),
};

module.exports = {
  PushNotificationsModule,
  NetworkModule,
  AppModule,
  BiometricAuthModule,
  HapticsModule,
  BadgeModule,
};
