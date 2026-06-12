// mobile/capacitor-bridge.ts
// Capacitor native API'lerini Bridge web uygulamasına bağlar.
//
// Özellikler:
//   - Splash screen, status bar, klavye yönetimi
//   - Push bildirimleri (FCM / APNs)
//   - Haptic geri bildirim
//   - Ağ durumu takibi
//   - Uygulama yaşam döngüsü
//   - Deep link (bridge://...)
//   - Biometric auth (Face ID / Fingerprint)
//   - Camera & Gallery (fotoğraf/video gönderme)
//   - Badge sayacı (okunmamış mesaj)
//   - Share sheet
//
// NOT: Bu dosya build adımında www/js/capacitor-bridge.js olarak derlenir.

'use strict';

// ── Capacitor global tip tanımları ────────────────────────────────────────────

interface CapacitorPlugin { [key: string]: unknown }

interface PushPermissionResult  { receive: 'granted' | 'denied' | 'prompt' }
interface PushToken             { value: string }
interface PushNotification      { title?: string; body?: string; data?: Record<string, string> }
interface PushActionPerformed   { notification: PushNotification }
interface LocalNotificationItem { title: string; body: string; id: number; extra: Record<string, unknown>; smallIcon?: string; iconColor?: string }

interface IPushNotifications extends CapacitorPlugin {
  requestPermissions(): Promise<PushPermissionResult>;
  register(): Promise<void>;
  addListener(event: 'registration',                    cb: (t: PushToken) => void): void;
  addListener(event: 'pushNotificationReceived',        cb: (n: PushNotification) => void): void;
  addListener(event: 'pushNotificationActionPerformed', cb: (a: PushActionPerformed) => void): void;
}
interface ILocalNotifications extends CapacitorPlugin {
  schedule(opts: { notifications: LocalNotificationItem[] }): Promise<void>;
}
interface IStatusBar extends CapacitorPlugin {
  setStyle(opts: { style: string }): Promise<void>;
  setBackgroundColor(opts: { color: string }): Promise<void>;
}
interface ISplashScreen extends CapacitorPlugin { hide(opts: { fadeOutDuration: number }): Promise<void> }
interface IKeyboard extends CapacitorPlugin {
  addListener(event: 'keyboardWillShow', cb: (info: { keyboardHeight: number }) => void): void;
  addListener(event: 'keyboardWillHide', cb: () => void): void;
}
interface IHaptics extends CapacitorPlugin {
  impact(opts: { style: string }): Promise<void>;
  notification(opts: { type: string }): Promise<void>;
}
interface INetwork extends CapacitorPlugin {
  addListener(event: 'networkStatusChange', cb: (s: { connected: boolean; connectionType: string }) => void): void;
}
interface IApp extends CapacitorPlugin {
  addListener(event: 'appUrlOpen',    cb: (e: { url: string }) => void): void;
  addListener(event: 'appStateChange',cb: (s: { isActive: boolean }) => void): void;
  addListener(event: 'backButton',    cb: () => void): void;
  getLaunchUrl(): Promise<{ url?: string } | null>;
  minimizeApp(): void;
}
interface IBiometricAuth extends CapacitorPlugin {
  checkBiometry(): Promise<{ isAvailable: boolean }>;
  authenticate(opts: { reason: string; cancelTitle?: string; allowDeviceCredential?: boolean; iosFallbackTitle?: string }): Promise<void>;
}
interface PhotoResult {
  format?: string;
  dataUrl?: string;
  base64String?: string;
}
interface MultiPickResult { photos?: PhotoResult[] }
interface ICamera extends CapacitorPlugin {
  getPhoto(opts: { quality: number; allowEditing: boolean; resultType: string; source: string; saveToGallery: boolean }): Promise<PhotoResult>;
  pickImages(opts: { quality: number; limit: number }): Promise<MultiPickResult>;
  checkPermissions(): Promise<{ camera: string }>;
  requestPermissions(opts: { permissions: string[] }): Promise<{ camera: string; photos: string }>;
}
interface IBadge extends CapacitorPlugin { set(opts: { count: number }): Promise<void> }
interface IShare extends CapacitorPlugin {
  share(opts: { title?: string; text?: string; url?: string; dialogTitle?: string }): Promise<void>;
}

interface CapacitorGlobal {
  Plugins: {
    PushNotifications?: IPushNotifications;
    LocalNotifications?: ILocalNotifications;
    StatusBar?: IStatusBar;
    SplashScreen?: ISplashScreen;
    Keyboard?: IKeyboard;
    Haptics?: IHaptics;
    Network?: INetwork;
    App?: IApp;
    BiometricAuth?: IBiometricAuth;
    Camera?: ICamera;
    Badge?: IBadge;
    Share?: IShare;
  };
  getPlatform(): string;
}

declare const Capacitor: CapacitorGlobal | undefined;

// ── Public window API tipleri ─────────────────────────────────────────────────

export interface BridgeHapticAPI {
  light():   Promise<void>;
  medium():  Promise<void>;
  success(): Promise<void>;
  warning(): Promise<void>;
  error():   Promise<void>;
}

export interface BridgeBadgeAPI {
  set(count: number): Promise<void>;
  increment(): Promise<void>;
  clear(): Promise<void>;
}

export interface FormattedPhoto {
  dataUrl:  string;
  mimeType: string;
  fileName: string;
  toBlob(): Blob;
  toFile(): File;
}

export interface BridgeCameraAPI {
  takePhoto():         Promise<FormattedPhoto | null>;
  pickFromGallery():   Promise<FormattedPhoto | null>;
  pickMultiple():      Promise<FormattedPhoto[]>;
  isAvailable():       Promise<boolean>;
  requestPermissions(): Promise<boolean>;
}

export interface ShareOptions { title?: string; text?: string; url?: string }
export interface MessageLike  { channelId: string; id: string; content?: string }

export interface BridgeShareAPI {
  share(opts: ShareOptions): Promise<boolean>;
  shareMessage(message: MessageLike): Promise<boolean>;
  shareInvite(inviteCode: string): Promise<boolean>;
}

export interface BridgeBiometricAPI {
  isAvailable(): Promise<boolean>;
  authenticate(reason?: string): Promise<{ success: boolean; error?: string }>;
  isEnabled(): boolean;
  enable(): void;
  disable(): void;
}

// Genişletilmiş Window tipi
declare global {
  interface Window {
    bridgeHaptic:    BridgeHapticAPI;
    bridgeBadge:     BridgeBadgeAPI;
    bridgeCamera:    BridgeCameraAPI;
    bridgeShare:     BridgeShareAPI;
    bridgeBiometric: BridgeBiometricAPI;
    bridgeDeepLink:  { handle: (url: string) => void };
  }
}

// ── Guard: Capacitor yoksa devre dışı ────────────────────────────────────────

if (typeof Capacitor === 'undefined') {
  console.debug('[Bridge Mobile] Capacitor bulunamadı, native modül devre dışı.');
} else {

  const {
    PushNotifications, LocalNotifications,
    StatusBar, SplashScreen, Keyboard,
    Haptics, Network, App,
    BiometricAuth, Camera, Badge, Share,
  } = Capacitor.Plugins;

  // ── SPLASH SCREEN ─────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    try { await SplashScreen?.hide({ fadeOutDuration: 300 }); } catch (_) {}
  });

  // ── STATUS BAR ────────────────────────────────────────────────────────────
  async function applyStatusBar(isDark: boolean): Promise<void> {
    try {
      await StatusBar?.setStyle({ style: isDark ? 'Dark' : 'Light' });
      await StatusBar?.setBackgroundColor({ color: isDark ? '#1a1a2e' : '#ffffff' });
    } catch (_) {}
  }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  applyStatusBar(prefersDark.matches);
  prefersDark.addEventListener('change', (e: MediaQueryListEvent) => applyStatusBar(e.matches));

  // ── KLAVYE ────────────────────────────────────────────────────────────────
  if (Keyboard) {
    Keyboard.addListener('keyboardWillShow', (info) => {
      document.documentElement.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);
      document.body.classList.add('keyboard-open');
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.style.setProperty('--keyboard-height', '0px');
      document.body.classList.remove('keyboard-open');
    });
  }

  // ── HAPTIC ────────────────────────────────────────────────────────────────
  const bridgeHaptic: BridgeHapticAPI = {
    light:   () => Haptics?.impact({ style: 'Light' }).catch(() => {}) ?? Promise.resolve(),
    medium:  () => Haptics?.impact({ style: 'Medium' }).catch(() => {}) ?? Promise.resolve(),
    success: () => Haptics?.notification({ type: 'Success' }).catch(() => {}) ?? Promise.resolve(),
    warning: () => Haptics?.notification({ type: 'Warning' }).catch(() => {}) ?? Promise.resolve(),
    error:   () => Haptics?.notification({ type: 'Error' }).catch(() => {}) ?? Promise.resolve(),
  };
  window.bridgeHaptic = bridgeHaptic;

  document.addEventListener('click', (e: MouseEvent) => {
    if ((e.target as Element).closest('#sendButton, .send-btn, [data-haptic]')) {
      void bridgeHaptic.light();
    }
  });

  // ── BADGE SAYACI ──────────────────────────────────────────────────────────
  const bridgeBadge: BridgeBadgeAPI = {
    _count: 0,
    async set(count: number): Promise<void> {
      (this as unknown as { _count: number })._count = Math.max(0, count);
      try { if (Badge) await Badge.set({ count: (this as unknown as { _count: number })._count }); } catch (_) {}
      window.dispatchEvent(new CustomEvent('bridge:badge', { detail: { count: (this as unknown as { _count: number })._count } }));
    },
    async increment(): Promise<void> {
      await this.set((this as unknown as { _count: number })._count + 1);
    },
    async clear(): Promise<void> {
      await this.set(0);
      const jwt = localStorage.getItem('bridge_token');
      if (jwt) {
        fetch('/api/mobile/push/badge/clear', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${jwt}` },
        }).catch(() => {});
      }
    },
  } as unknown as BridgeBadgeAPI;
  window.bridgeBadge = bridgeBadge;

  // ── PUSH BİLDİRİMLERİ ────────────────────────────────────────────────────
  async function setupPushNotifications(): Promise<void> {
    if (!PushNotifications) return;
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') {
      console.warn('[Bridge Mobile] Push izni verilmedi');
      return;
    }
    await PushNotifications.register();

    PushNotifications.addListener('registration', async (token: PushToken) => {
      try {
        const jwt = localStorage.getItem('bridge_token');
        if (!jwt) return;
        await fetch('/api/mobile/push/register-native', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
          body: JSON.stringify({ token: token.value, platform: Capacitor!.getPlatform() }),
        });
      } catch (err) {
        console.error('[Bridge Mobile] Token kaydı başarısız:', err);
      }
    });

    PushNotifications.addListener('pushNotificationReceived', (notification: PushNotification) => {
      void showLocalNotification(notification.title ?? '', notification.body ?? '', notification.data ?? {});
      void bridgeBadge.increment();
    });

    PushNotifications.addListener('pushNotificationActionPerformed', (action: PushActionPerformed) => {
      const data = action.notification.data;
      void bridgeBadge.clear();
      if (data?.channelId) {
        window.dispatchEvent(new CustomEvent('bridge:navigate', {
          detail: { channelId: data.channelId, serverId: data.serverId },
        }));
      }
    });
  }

  async function showLocalNotification(
    title: string, body: string, data: Record<string, unknown>,
  ): Promise<void> {
    if (!LocalNotifications) return;
    try {
      await LocalNotifications.schedule({
        notifications: [{
          title, body,
          id: Date.now(),
          extra: data,
          smallIcon: 'ic_stat_bridge',
          iconColor: '#2d9cdb',
        }],
      });
    } catch (_) {}
  }

  // ── DEEP LINK ─────────────────────────────────────────────────────────────
  type DeepLinkPayload =
    | { type: 'navigate:channel';  channelId: string; serverId?: string }
    | { type: 'navigate:dm';       userId: string }
    | { type: 'navigate:profile';  userId: string }
    | { type: 'navigate:server';   serverId: string }
    | { type: 'navigate:invite';   code: string }
    | { type: 'navigate:activity'; channelId: string; activityId: string }
    | { type: 'navigate:settings'; tab: string }
    | { type: 'auth:callback';     token: string | null };

  function handleDeepLink(url: string): void {
    if (!url) return;
    let parsed: URL;
    try { parsed = new URL(url); } catch (_) { return; }

    const isCustomScheme = parsed.protocol === 'bridge:';
    const rawPath = isCustomScheme
      ? (parsed.hostname + parsed.pathname).replace(/^\/+/, '')
      : parsed.pathname.replace(/^\/+/, '');
    const parts   = rawPath.split('/').filter(Boolean);
    const section = parts[0];
    const rest    = parts.slice(1);

    const navPayload = ((): DeepLinkPayload | null => {
      switch (section) {
        case 'channel':  return { type: 'navigate:channel', channelId: rest[0] };
        case 'dm':       return { type: 'navigate:dm',      userId: rest[0] };
        case 'user':     return { type: 'navigate:profile', userId: rest[0] };
        case 'server':
          return rest[1] === 'channel'
            ? { type: 'navigate:channel', serverId: rest[0], channelId: rest[2] }
            : { type: 'navigate:server',  serverId: rest[0] };
        case 'invite':   return { type: 'navigate:invite',   code: rest[0] };
        case 'activity': return { type: 'navigate:activity', channelId: rest[0], activityId: rest[1] };
        case 'settings': return { type: 'navigate:settings', tab: rest[0] ?? 'account' };
        case 'auth':
          if (rest[0] === 'callback') {
            const idx = url.indexOf('?');
            const qs  = idx !== -1 ? url.slice(idx + 1) : '';
            return { type: 'auth:callback', token: new URLSearchParams(qs).get('token') };
          }
          return null;
        default:
          console.warn('[Bridge Mobile] Bilinmeyen deep link:', section, '| URL:', url);
          return null;
      }
    })();

    if (navPayload) {
      void bridgeHaptic.light();
      window.dispatchEvent(new CustomEvent('bridge:deeplink', { detail: navPayload }));
      console.debug('[Bridge Mobile] Deep link dispatched:', navPayload);
    }
  }

  if (App) {
    App.addListener('appUrlOpen', (event) => handleDeepLink(event.url));
    App.getLaunchUrl()
      .then((result) => { if (result?.url) handleDeepLink(result.url); })
      .catch(() => {});
  }
  window.bridgeDeepLink = { handle: handleDeepLink };

  // ── BİOMETRİK AUTH ────────────────────────────────────────────────────────
  const bridgeBiometric: BridgeBiometricAPI = {
    async isAvailable(): Promise<boolean> {
      if (!BiometricAuth) return false;
      try { const r = await BiometricAuth.checkBiometry(); return r.isAvailable; } catch (_) { return false; }
    },
    async authenticate(reason?: string): Promise<{ success: boolean; error?: string }> {
      if (!BiometricAuth) return { success: false, error: 'plugin_unavailable' };
      try {
        await BiometricAuth.authenticate({
          reason: reason ?? "Bridge'e giriş yapmak için kimliğinizi doğrulayın",
          cancelTitle: 'İptal',
          allowDeviceCredential: true,
          iosFallbackTitle: 'Şifre Kullan',
        });
        return { success: true };
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        return { success: false, error: e.code ?? e.message };
      }
    },
    isEnabled():  boolean { return localStorage.getItem('bridge_biometric_enabled') === 'true'; },
    enable():     void    { localStorage.setItem('bridge_biometric_enabled', 'true'); },
    disable():    void    { localStorage.removeItem('bridge_biometric_enabled'); },
  };
  window.bridgeBiometric = bridgeBiometric;

  window.addEventListener('load', async () => {
    const jwt = localStorage.getItem('bridge_token');
    if (jwt && bridgeBiometric.isEnabled()) {
      const available = await bridgeBiometric.isAvailable();
      if (available) window.dispatchEvent(new CustomEvent('bridge:biometric:prompt'));
    }
  });

  // ── KAMERA & GALERİ ───────────────────────────────────────────────────────
  function formatPhoto(photo: PhotoResult): FormattedPhoto {
    const ext      = (photo.format ?? 'jpeg').toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    const dataUrl  = photo.dataUrl ?? `data:${mimeType};base64,${photo.base64String ?? ''}`;

    return {
      dataUrl,
      mimeType,
      fileName: `bridge_${Date.now()}.${ext}`,
      toBlob(): Blob {
        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mimeType });
      },
      toFile(): File {
        return new File([this.toBlob()], this.fileName, { type: mimeType });
      },
    };
  }

  const bridgeCamera: BridgeCameraAPI = {
    takePhoto:       () => _capture('CAMERA'),
    pickFromGallery: () => _capture('PHOTOS'),

    async pickMultiple(): Promise<FormattedPhoto[]> {
      if (!Camera) return [];
      try {
        const result = await Camera.pickImages({ quality: 85, limit: 10 });
        return (result.photos ?? []).map(formatPhoto);
      } catch (err: unknown) {
        const e = err as { message?: string };
        if (e.message?.includes('cancelled') || e.message?.includes('User cancelled')) return [];
        console.error('[Bridge Mobile] Çoklu galeri hatası:', err);
        return [];
      }
    },

    async isAvailable(): Promise<boolean> {
      if (!Camera) return false;
      try { const p = await Camera.checkPermissions(); return p.camera !== 'denied'; } catch (_) { return false; }
    },

    async requestPermissions(): Promise<boolean> {
      if (!Camera) return false;
      try {
        const r = await Camera.requestPermissions({ permissions: ['camera', 'photos'] });
        return r.camera === 'granted' || r.photos === 'granted';
      } catch (_) { return false; }
    },
  };

  async function _capture(source: string): Promise<FormattedPhoto | null> {
    if (!Camera) return null;
    try {
      const photo = await Camera.getPhoto({
        quality: 85, allowEditing: false, resultType: 'dataUrl', source, saveToGallery: false,
      });
      return formatPhoto(photo);
    } catch (err: unknown) {
      const e = err as { message?: string };
      if (e.message?.includes('cancelled') || e.message?.includes('User cancelled')) return null;
      console.error('[Bridge Mobile] Kamera/galeri hatası:', err);
      return null;
    }
  }

  window.bridgeCamera = bridgeCamera;

  document.addEventListener('click', async (e: MouseEvent) => {
    const trigger = (e.target as Element).closest('[data-native-camera], [data-native-gallery]');
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    void bridgeHaptic.light();
    const isCamera = trigger.hasAttribute('data-native-camera');
    const photo    = isCamera
      ? await bridgeCamera.takePhoto()
      : await bridgeCamera.pickFromGallery();
    if (photo) {
      trigger.dispatchEvent(new CustomEvent('bridge:file:selected', {
        bubbles: true,
        detail: { file: photo.toFile(), photo },
      }));
    }
  });

  // ── SHARE SHEET ───────────────────────────────────────────────────────────
  const bridgeShare: BridgeShareAPI = {
    async share(opts: ShareOptions): Promise<boolean> {
      if (Share) {
        try {
          await Share.share({ title: opts.title, text: opts.text, url: opts.url, dialogTitle: 'Paylaş' });
          return true;
        } catch (_) {}
      }
      if (navigator.share) {
        try { await navigator.share(opts); return true; } catch (_) {}
      }
      return false;
    },
    shareMessage(message: MessageLike): Promise<boolean> {
      const url = `${window.location.origin}/channel/${message.channelId}?msg=${message.id}`;
      return this.share({ title: 'Bridge mesajı', text: (message.content ?? '').slice(0, 100), url });
    },
    shareInvite(inviteCode: string): Promise<boolean> {
      return this.share({
        title: "Bridge'e katıl",
        text:  "Bridge'de benimle sohbet et!",
        url:   `https://bridge.app/invite/${inviteCode}`,
      });
    },
  };
  window.bridgeShare = bridgeShare;

  // ── AĞ DURUMU ─────────────────────────────────────────────────────────────
  if (Network) {
    Network.addListener('networkStatusChange', (status) => {
      window.dispatchEvent(new CustomEvent('bridge:network', {
        detail: { connected: status.connected, type: status.connectionType },
      }));
      let banner = document.getElementById('offline-banner') ?? createOfflineBanner();
      banner.textContent = '⚠️  İnternet bağlantısı yok';
      banner.style.display = status.connected ? 'none' : 'block';
    });
  }

  function createOfflineBanner(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'offline-banner';
    Object.assign(el.style, {
      position: 'fixed', top: '0', left: '0', right: '0',
      background: '#ed4245', color: '#fff', textAlign: 'center',
      padding: '8px', zIndex: '9999', display: 'none', fontSize: '13px',
    });
    document.body.prepend(el);
    return el;
  }

  // ── UYGULAMA YAŞAM DÖNGÜSÜ ────────────────────────────────────────────────
  if (App) {
    App.addListener('appStateChange', (state) => {
      window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: state.isActive } }));
      if (state.isActive) void bridgeBadge.clear();
    });

    App.addListener('backButton', () => {
      const modal = document.querySelector<HTMLElement>('.modal.active, .overlay.active, [data-modal].active');
      if (modal) { modal.classList.remove('active'); void bridgeHaptic.light(); return; }
      const inChannel = document.querySelector('[data-view="channel"]');
      if (inChannel) {
        window.dispatchEvent(new CustomEvent('bridge:navigate', { detail: { view: 'server-list' } }));
        return;
      }
      App?.minimizeApp();
    });
  }

  // ── BAŞLAT ────────────────────────────────────────────────────────────────
  window.addEventListener('load', () => {
    void setupPushNotifications();
    console.log('[Bridge Mobile] Capacitor entegrasyonu hazır —', Capacitor!.getPlatform());
    console.log('[Bridge Mobile] Özellikler: push, badge, deep-link, biometric, camera, share');
  });

} // end Capacitor guard

export const capacitorBridgeReady = true;
