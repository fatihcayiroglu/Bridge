// mobile/tests/capacitor-bridge.test.js
//
// capacitor-bridge.js birim testleri — Capacitor plugin mock'larıyla
// Çalıştırma: npx jest --config jest.mobile.config.js

'use strict';

// Plugin mock'ları moduleNameMapper ve global Capacitor ile sağlanır.
const { Capacitor, WebPlugin } = require('./__mocks__/@capacitor/core');
const { PushNotificationsModule } = require('./__mocks__/capacitor-plugins');
const { NetworkModule }           = require('./__mocks__/capacitor-plugins');
const { AppModule }               = require('./__mocks__/capacitor-plugins');
const { BiometricAuthModule }     = require('./__mocks__/capacitor-plugins');
const { HapticsModule }           = require('./__mocks__/capacitor-plugins');
const { BadgeModule }             = require('./__mocks__/capacitor-plugins');

const { PushNotifications } = PushNotificationsModule;
const { Network }           = NetworkModule;
const { App }               = AppModule;
const { BiometricAuth }     = BiometricAuthModule;
const { Haptics }           = HapticsModule;
const { Badge }             = BadgeModule;

Capacitor.Plugins = { PushNotifications, Network, App, BiometricAuth, Haptics, Badge };
global.Capacitor = Capacitor;
if (typeof window !== 'undefined') {
  window.Capacitor = Capacitor;
  window.matchMedia = window.matchMedia || jest.fn().mockReturnValue({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Capacitor — platform detection', () => {
  afterEach(() => {
    Capacitor.getPlatform.mockReset();
    Capacitor.isNativePlatform.mockReset();
    Capacitor.getPlatform.mockReturnValue('web');
    Capacitor.isNativePlatform.mockReturnValue(false);
  });

  it('web platformunda isNativePlatform false döndürmeli', () => {
    expect(Capacitor.isNativePlatform()).toBe(false);
    expect(Capacitor.getPlatform()).toBe('web');
  });

  it('iOS simülasyonunda isNativePlatform true döndürmeli', () => {
    Capacitor._setPlatform('ios');
    expect(Capacitor.isNativePlatform()).toBe(true);
    expect(Capacitor.getPlatform()).toBe('ios');
  });

  it('Android simülasyonunda platform "android" olmalı', () => {
    Capacitor._setPlatform('android');
    expect(Capacitor.getPlatform()).toBe('android');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PushNotifications mock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requestPermissions "granted" döndürmeli', async () => {
    const result = await PushNotifications.requestPermissions();
    expect(result).toEqual({ receive: 'granted' });
  });

  it('register() çözümlenebilmeli', async () => {
    await expect(PushNotifications.register()).resolves.toBeUndefined();
    expect(PushNotifications.register).toHaveBeenCalledTimes(1);
  });

  it('addListener ile registration token event simüle edilmeli', async () => {
    const tokenCb = jest.fn();
    await PushNotifications.addListener('registration', tokenCb);
    PushNotifications._emit('registration', { value: 'test-device-token-123' });
    expect(tokenCb).toHaveBeenCalledWith({ value: 'test-device-token-123' });
  });

  it('addListener ile pushNotificationReceived simüle edilmeli', async () => {
    const notifCb = jest.fn();
    await PushNotifications.addListener('pushNotificationReceived', notifCb);
    PushNotifications._emit('pushNotificationReceived', {
      id: 'notif-1',
      title: 'Yeni mesaj',
      body: 'Merhaba!',
      data: { channelId: 'ch-abc' },
    });
    expect(notifCb).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Yeni mesaj', data: { channelId: 'ch-abc' } })
    );
  });

  it('registrationError eventi simüle edilmeli', async () => {
    const errorCb = jest.fn();
    await PushNotifications.addListener('registrationError', errorCb);
    PushNotifications._emit('registrationError', { error: 'permission denied' });
    expect(errorCb).toHaveBeenCalledWith({ error: 'permission denied' });
  });

  it('removeDeliveredNotifications çağrılabilmeli', async () => {
    await expect(
      PushNotifications.removeDeliveredNotifications({ notifications: [{ id: '1', title: '', body: '', data: {} }] })
    ).resolves.toBeUndefined();
  });

  it('listener.remove() ile dinleyici kaldırılabilmeli', async () => {
    const cb = jest.fn();
    const handle = await PushNotifications.addListener('registration', cb);
    handle.remove();
    // İkinci emit'ten sonra cb çağrılmamalı
    PushNotifications._emit('registration', { value: 'token-after-remove' });
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Network mock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getStatus() bağlı durumu döndürmeli', async () => {
    const status = await Network.getStatus();
    expect(status).toEqual({ connected: true, connectionType: 'wifi' });
  });

  it('networkStatusChange eventi simüle edilmeli', async () => {
    const cb = jest.fn();
    await Network.addListener('networkStatusChange', cb);
    Network._emit('networkStatusChange', { connected: false, connectionType: 'none' });
    expect(cb).toHaveBeenCalledWith({ connected: false, connectionType: 'none' });
  });

  it('offline durumu simüle edilebilmeli', async () => {
    Network.getStatus.mockResolvedValueOnce({ connected: false, connectionType: 'none' });
    const status = await Network.getStatus();
    expect(status.connected).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('BiometricAuth mock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('checkBiometry() biyometri mevcut döndürmeli', async () => {
    const result = await BiometricAuth.checkBiometry();
    expect(result.isAvailable).toBe(true);
  });

  it('authenticate() başarılı çözümlenmeli', async () => {
    await expect(BiometricAuth.authenticate()).resolves.toBeUndefined();
  });

  it('authenticate() hata simülasyonu — kullanıcı iptal', async () => {
    BiometricAuth.authenticate.mockRejectedValueOnce({ code: 'userCancelled', message: 'User cancelled' });
    await expect(BiometricAuth.authenticate()).rejects.toMatchObject({ code: 'userCancelled' });
  });

  it('biyometri kullanılamıyor simülasyonu', async () => {
    BiometricAuth.checkBiometry.mockResolvedValueOnce({
      isAvailable: false,
      biometryType: 'none',
      reason: 'notEnrolled',
      code: 5,
    });
    const result = await BiometricAuth.checkBiometry();
    expect(result.isAvailable).toBe(false);
    expect(result.reason).toBe('notEnrolled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Haptics mock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('vibrate() çözümlenmeli', async () => {
    await expect(Haptics.vibrate()).resolves.toBeUndefined();
  });

  it('impact() çağrılmalı', async () => {
    await Haptics.impact({ style: 'Light' });
    expect(Haptics.impact).toHaveBeenCalledWith({ style: 'Light' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Badge mock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('set({ count }) çözümlenmeli', async () => {
    await expect(Badge.set({ count: 5 })).resolves.toBeUndefined();
    expect(Badge.set).toHaveBeenCalledWith({ count: 5 });
  });

  it('clear() çözümlenmeli', async () => {
    await expect(Badge.clear()).resolves.toBeUndefined();
  });

  it('get() 0 döndürmeli', async () => {
    const result = await Badge.get();
    expect(result.count).toBe(0);
  });

  it('badge sayısı güncelleme simülasyonu', async () => {
    Badge.get.mockResolvedValueOnce({ count: 12 });
    const result = await Badge.get();
    expect(result.count).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Native bridge simülasyonu — platform değişimine göre davranış', () => {
  afterEach(() => Capacitor._setPlatform('web'));

  it('iOS platformunda push token registration simüle edilmeli', async () => {
    Capacitor._setPlatform('ios');
    expect(Capacitor.isNativePlatform()).toBe(true);

    // iOS platform akışını simüle et
    await PushNotifications.requestPermissions();
    await PushNotifications.register();

    const tokenCb = jest.fn();
    await PushNotifications.addListener('registration', tokenCb);
    PushNotifications._emit('registration', { value: 'ios-apns-token-xyz' });

    expect(tokenCb).toHaveBeenCalledWith({ value: 'ios-apns-token-xyz' });
  });

  it('Android platformunda FCM token akışı simüle edilmeli', async () => {
    Capacitor._setPlatform('android');

    await PushNotifications.register();
    const tokenCb = jest.fn();
    await PushNotifications.addListener('registration', tokenCb);
    PushNotifications._emit('registration', { value: 'android-fcm-token-abc' });

    expect(tokenCb).toHaveBeenCalledWith({ value: 'android-fcm-token-abc' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 85 fix: Deep link dispatch testleri
// handleDeepLink fonksiyonu window'a bridge:deeplink CustomEvent dispatch eder.
// ─────────────────────────────────────────────────────────────────────────────

// Gerçek modülü yükle — Capacitor plugin'leri zaten mock'lanmış durumda.
// Bu satır olmadan testler sahte bir implementasyonu test eder; asıl kodda
// bir bug olsa testler kırmızıya dönmez.
require('../capacitor-bridge.js');

describe('Deep link dispatch', () => {
  let dispatchedEvents = [];
  let listener;

  beforeEach(() => {
    dispatchedEvents = [];
    listener = (e) => dispatchedEvents.push(e.detail);
    window.addEventListener('bridge:deeplink', listener);
    // window.bridgeDeepLink gerçek modül tarafından kurulur (require en üstte).
    // Sahte implementasyon kaldırıldı — Sprint 85 fix: testler artık asıl kodu test eder.
  });

  afterEach(() => {
    window.removeEventListener('bridge:deeplink', listener);
    dispatchedEvents = [];
  });

  it('bridge://channel/:id → navigate:channel', () => {
    window.bridgeDeepLink.handle('bridge://channel/ch-123');
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0]).toMatchObject({ type: 'navigate:channel', channelId: 'ch-123' });
  });

  it('bridge://dm/:userId → navigate:dm', () => {
    window.bridgeDeepLink.handle('bridge://dm/user-456');
    expect(dispatchedEvents[0]).toMatchObject({ type: 'navigate:dm', userId: 'user-456' });
  });

  it('bridge://server/:id → navigate:server', () => {
    window.bridgeDeepLink.handle('bridge://server/srv-789');
    expect(dispatchedEvents[0]).toMatchObject({ type: 'navigate:server', serverId: 'srv-789' });
  });

  it('bridge://server/:id/channel/:id → navigate:channel (server + channel)', () => {
    window.bridgeDeepLink.handle('bridge://server/srv-1/channel/ch-2');
    expect(dispatchedEvents[0]).toMatchObject({
      type: 'navigate:channel',
      serverId: 'srv-1',
      channelId: 'ch-2',
    });
  });

  it('bridge://invite/:code → navigate:invite', () => {
    window.bridgeDeepLink.handle('bridge://invite/abc456xyz');
    expect(dispatchedEvents[0]).toMatchObject({ type: 'navigate:invite', code: 'abc456xyz' });
  });

  it('bridge://activity/:channelId/:activityId → navigate:activity', () => {
    window.bridgeDeepLink.handle('bridge://activity/ch-1/act-2');
    expect(dispatchedEvents[0]).toMatchObject({
      type: 'navigate:activity',
      channelId: 'ch-1',
      activityId: 'act-2',
    });
  });

  it('bridge://settings → varsayılan tab account', () => {
    window.bridgeDeepLink.handle('bridge://settings');
    expect(dispatchedEvents[0]).toMatchObject({ type: 'navigate:settings', tab: 'account' });
  });

  it('bridge://settings/:tab → belirtilen tab', () => {
    window.bridgeDeepLink.handle('bridge://settings/notifications');
    expect(dispatchedEvents[0]).toMatchObject({ type: 'navigate:settings', tab: 'notifications' });
  });

  it('bridge://auth/callback?token=tok_xyz → auth:callback token', () => {
    window.bridgeDeepLink.handle('bridge://auth/callback?token=tok_xyz_123');
    expect(dispatchedEvents[0]).toMatchObject({ type: 'auth:callback', token: 'tok_xyz_123' });
  });

  it('geçersiz şema → event dispatch edilmez', () => {
    window.bridgeDeepLink.handle('https://example.com/random');
    expect(dispatchedEvents).toHaveLength(0);
  });

  it('bilinmeyen bridge path → event dispatch edilmez', () => {
    window.bridgeDeepLink.handle('bridge://unknown/path');
    expect(dispatchedEvents).toHaveLength(0);
  });

  it('boş URL → hata fırlatmaz', () => {
    expect(() => window.bridgeDeepLink.handle('')).not.toThrow();
    expect(dispatchedEvents).toHaveLength(0);
  });

  it('null URL → hata fırlatmaz', () => {
    expect(() => window.bridgeDeepLink.handle(null)).not.toThrow();
    expect(dispatchedEvents).toHaveLength(0);
  });
});
