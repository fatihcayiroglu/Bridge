// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MobileUxPanel.svelte
//              client/js/core/mobile-ux-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/mobile-ux.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Bridge Mobil UX İyileştirmeleri — Capacitor native uygulamada çalışır

import { BridgeRegistry } from './bridge-registry.js';
import { getRtc }         from './globals.js';

// ── Tip tanımları ─────────────────────────────────────────────

type ThemeName = 'dark' | 'light' | 'amoled' | 'midnight';

interface CapacitorWindow extends Window {
  Capacitor?: {
    isNativePlatform?(): boolean;
    getPlatform?(): string;
    Plugins?: {
      App?:              { minimizeApp?(): void };
      StatusBar?:        { setBackgroundColor?(opts: { color: string }): void };
      NativeAudio?:      Record<string, unknown>;
      CapacitorAudioSession?: { configure?(opts: Record<string, unknown>): Promise<void> };
      AudioSession?:     { configure?(opts: Record<string, unknown>): Promise<void> };
      ProximitySensor?:  { enable?(): void; disable?(): void; addListener?(event: string, cb: (data: { near: boolean }) => void): void };
      PushNotifications?: {
        register?(): Promise<void>;
        addListener?(event: string, cb: (data: Record<string, unknown>) => void): void;
      };
    };
  };
}

interface RtcLike {
  isInVoice?(): boolean;
  reconfigureAudio?(): void;
}

declare const window: CapacitorWindow;

// ── Platform tespiti ──────────────────────────────────────────

const IS_CAPACITOR = typeof window !== 'undefined' && !!(window.Capacitor?.isNativePlatform?.());
const IS_IOS       = IS_CAPACITOR && window.Capacitor?.getPlatform?.() === 'ios';
const IS_ANDROID   = IS_CAPACITOR && window.Capacitor?.getPlatform?.() === 'android';

// ── Swipe navigation ──────────────────────────────────────────

let swipeStartX = 0;
let swipeStartY = 0;

// Sprint 96: Enhanced swipe — server-list (< 20px edge), channel-sidebar (20-60px),
//             member-list (swipe left from right edge), velocity threshold.
let _swipeTsStart = 0;

export function initSwipeNavigation(): void {
  if (!IS_CAPACITOR) return;

  document.addEventListener('touchstart', e => {
    swipeStartX  = e.touches[0].clientX;
    swipeStartY  = e.touches[0].clientY;
    _swipeTsStart = Date.now();
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const dx       = e.changedTouches[0].clientX - swipeStartX;
    const dy       = Math.abs(e.changedTouches[0].clientY - swipeStartY);
    const dt       = Math.max(Date.now() - _swipeTsStart, 1);
    const vx       = Math.abs(dx) / dt; // px/ms
    const w        = window.innerWidth;

    // Reject vertical-dominant swipes
    if (dy > Math.abs(dx) * 0.8) return;

    const serverList  = document.querySelector<HTMLElement>('.server-list');
    const sidebar     = document.querySelector<HTMLElement>('.channel-sidebar');
    const memberList  = document.querySelector<HTMLElement>('.member-list');
    const backdrop    = document.getElementById('mobile-backdrop');

    const openPanel = (el: HTMLElement | null) => {
      if (!el) return;
      serverList?.classList.remove('mobile-open');
      sidebar?.classList.remove('mobile-open');
      memberList?.classList.remove('mobile-open');
      el.classList.add('mobile-open');
      backdrop?.classList.add('active');
    };
    const closeAll = () => {
      serverList?.classList.remove('mobile-open');
      sidebar?.classList.remove('mobile-open');
      memberList?.classList.remove('mobile-open');
      backdrop?.classList.remove('active');
    };

    const isSwipe = Math.abs(dx) > 50 || vx > 0.3;
    if (!isSwipe) return;

    if (dx > 0) {
      // Swipe RIGHT
      if (swipeStartX < 20) {
        // Far left edge → server list
        openPanel(serverList);
      } else if (swipeStartX < 60) {
        // Left edge → channel sidebar
        openPanel(sidebar);
      }
    } else {
      // Swipe LEFT
      if (swipeStartX > w - 40) {
        // Right edge → member list
        openPanel(memberList);
      } else {
        // Anywhere → close panels
        closeAll();
      }
    }
  }, { passive: true });
}

// ── Keyboard avoidance ────────────────────────────────────────

export function initKeyboardAvoidance(): void {
  if (!IS_CAPACITOR) return;
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const offset = window.innerHeight - (window.visualViewport?.height ?? window.innerHeight);
      const msgArea = document.querySelector<HTMLElement>('.message-input-area, .msg-input-wrap');
      if (msgArea) msgArea.style.transform = offset > 50 ? `translateY(-${offset}px)` : '';
    });
  }
}

// ── Pull-to-refresh ───────────────────────────────────────────

let pullStartY = 0;
let pulling    = false;

export function initPullToRefresh(): void {
  if (!IS_CAPACITOR) return;
  const msgList = document.querySelector<HTMLElement>('#messages, .messages-list');
  if (!msgList) return;
  msgList.addEventListener('touchstart', e => {
    if (msgList.scrollTop === 0) { pullStartY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });
  msgList.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - pullStartY;
    if (dy > 60 && msgList.scrollTop === 0) { BridgeRegistry.call('loadMoreMessages'); pulling = false; }
  }, { passive: true });
  msgList.addEventListener('touchend', () => { pulling = false; }, { passive: true });
}

// ── Double-tap react ──────────────────────────────────────────

const tapTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function initDoubleTapReact(): void {
  if (!IS_CAPACITOR) return;
  document.addEventListener('touchend', e => {
    const msgEl = (e.target as HTMLElement).closest<HTMLElement>('.message-item');
    if (!msgEl) return;
    const msgId = msgEl.dataset.id;
    if (!msgId) return;
    if (tapTimers.has(msgId)) {
      clearTimeout(tapTimers.get(msgId)!);
      tapTimers.delete(msgId);
      BridgeRegistry.call('addReaction', msgId, '❤️');
      BridgeRegistry.call('bridgeHaptic:light');
      showHeartBurst(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    } else {
      tapTimers.set(msgId, setTimeout(() => tapTimers.delete(msgId), 300));
    }
  }, { passive: true });
}

export function showHeartBurst(x: number, y: number): void {
  const heart = document.createElement('div');
  heart.textContent = '❤️';
  heart.style.cssText = `
    position:fixed;left:${x}px;top:${y}px;font-size:28px;
    pointer-events:none;z-index:9999;
    animation:heartBurst 600ms ease-out forwards;transform-origin:center;`;
  document.body.appendChild(heart);
  setTimeout(() => heart.remove(), 650);
}

// CSS enjeksiyonu
const heartStyle = document.createElement('style');
heartStyle.textContent = `
  @keyframes heartBurst {
    0%   { opacity:1; transform: scale(0.5) translate(-50%,-50%); }
    50%  { opacity:1; transform: scale(1.4) translate(-50%,-50%); }
    100% { opacity:0; transform: scale(1.0) translate(-50%,-110%); }
  }
  @media (max-width: 768px) {
    .channel-sidebar { position:fixed !important;left:0;top:0;bottom:0;z-index:var(--z-sidebar,200);transform:translateX(-100%);transition:transform 250ms cubic-bezier(0.16,1,0.3,1);box-shadow:var(--shadow-xl); }
    .channel-sidebar.mobile-open { transform:translateX(0); }
    .channel-sidebar.mobile-open ~ .main-area { pointer-events:none; }
    .mobile-sidebar-backdrop { position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:calc(var(--z-sidebar,200) - 1); }
    .message-input-area, .msg-input-wrap { padding-bottom:env(safe-area-inset-bottom,0px); }
    .message-item { min-height:44px; }
    .reaction { min-width:44px;min-height:32px; }
  }`;
document.head.appendChild(heartStyle);

// ── Android back ──────────────────────────────────────────────

export function initAndroidBack(): void {
  if (!IS_ANDROID) return;
  document.addEventListener('backbutton', e => {
    e.preventDefault();
    const modal   = document.querySelector<HTMLElement>('.modal-overlay');
    if (modal)   { modal.remove(); return; }
    const sidebar = document.querySelector<HTMLElement>('.channel-sidebar.mobile-open');
    if (sidebar) { sidebar.classList.remove('mobile-open'); return; }
    window.Capacitor?.Plugins?.App?.minimizeApp?.();
  });
}

// ── Status bar ────────────────────────────────────────────────

export function updateStatusBarColor(theme: string): void {
  if (!IS_CAPACITOR) return;
  const colors: Record<string, string> = { dark: '#1a1b1e', light: '#f2f3f5', amoled: '#000000', midnight: '#0d0f16' };
  window.Capacitor?.Plugins?.StatusBar?.setBackgroundColor?.({ color: colors[theme] ?? colors['dark'] });
}

// ── Mobile audio ──────────────────────────────────────────────

let _mobileAudioSessionActive = false;

export function initMobileAudio(): void {
  _patchMobileAudioConstraints();
  if (!IS_CAPACITOR) return;
  void _setupNativeAudioSession();
  _watchHeadphoneEvents();
  if (IS_IOS) _watchProximitySensor();
}

async function _setupNativeAudioSession(): Promise<void> {
  try {
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession ?? window.Capacitor?.Plugins?.AudioSession;
    if (AudioSession) {
      await AudioSession.configure?.({
        category: 'playAndRecord',
        mode: IS_IOS ? 'voiceChat' : 'communication',
        options: ['allowBluetooth', 'allowBluetoothA2DP', 'defaultToSpeaker'],
      });
    }
  } catch { /* ignore */ }
}

function _watchHeadphoneEvents(): void {
  try {
    window.addEventListener('audiopluginstatechange', () => {
      const rtc = getRtc() as RtcLike | null;
      if (rtc?.isInVoice?.()) void rtc.reconfigureAudio?.();
    });
  } catch { /* ignore */ }
}

function _watchProximitySensor(): void {
  const prox = window.Capacitor?.Plugins?.ProximitySensor;
  if (!prox) return;
  prox.enable?.();
  prox.addListener?.('proximityChange', ({ near }) => {
    if (near) window.Capacitor?.Plugins?.StatusBar?.setBackgroundColor?.({ color: '#000000' });
  });
}

function _patchMobileAudioConstraints(): void {
  const constraints = {
    echoCancellation:  { ideal: true },
    noiseSuppression:  { ideal: true },
    autoGainControl:   { ideal: true },
    sampleRate:        { ideal: 16_000 },
    channelCount:      { ideal: 1 },
  };
  BridgeRegistry.register('BridgeMobileAudioConstraints', constraints);
}

export async function activateMobileAudioSession(): Promise<void> {
  if (_mobileAudioSessionActive) return;
  await _setupNativeAudioSession();
  _mobileAudioSessionActive = true;
}

export async function deactivateMobileAudioSession(): Promise<void> {
  _mobileAudioSessionActive = false;
}

// ── Native Push Notifications (Capacitor) ────────────────────
// Sprint 96: Capacitor PushNotifications plugin entegrasyonu.
// APNs (iOS) ve FCM (Android) token'larını alıp server'a kaydeder.
// Gelen foreground bildirimleri toast olarak gösterir.
//
// Sprint 97: İki iyileştirme
//   1. registerPushToken() — token → server kaydı bağımsız, retry ile
//   2. onNativePushLogin()  — login sonrası çağrılabilir; token hâlâ bellekteyse
//      hemen kaydeder, yoksa Push.register() ile yeniden talep eder.

// Son alınan token bellekte tutulur — login sonrası yeniden kayıt için.
let _cachedPushToken: string | undefined;
let _pushListenersAttached = false;

/**
 * Token + auth bilgisiyle /api/mobile/push/register'a kayıt yapar.
 * Auth henüz yoksa sessizce çıkar; caller (onNativePushLogin) uygun
 * zamanda tekrar çağırır.
 *
 * @param token     APNs/FCM cihaz token'ı
 * @param retries   Kalan deneme sayısı (exponential back-off: 1s → 2s → 4s)
 */
async function registerPushToken(token: string, retries = 3): Promise<void> {
  const platform = IS_IOS ? 'ios' : 'android';

  // Auth token fallback zinciri: BridgeRegistry → sessionStorage → Capacitor Preferences
  // localStorage Capacitor'da private mod / storage sınırı nedeniyle güvenilmez.
  const me   = BridgeRegistry.call('getMe') as { token?: string } | null;
  let auth   = me?.token ?? '';

  if (!auth) {
    auth = sessionStorage.getItem('token') ?? '';
  }

  if (!auth) {
    try {
      const Preferences = window.Capacitor?.Plugins?.Preferences;
      if (Preferences) {
        const result = await (Preferences.get({ key: 'token' }) as Promise<{ value: string | null }>);
        auth = result?.value ?? '';
      }
    } catch {
      // Plugin yoksa sessiz devam
    }
  }

  const api = (BridgeRegistry.get('apiBase') as string | null) ?? '';

  // Auth henüz yok — login olmamış, çıkıyoruz. onNativePushLogin() daha sonra çağırır.
  if (!auth || !api) return;

  try {
    const res = await fetch(`${api}/api/mobile/push/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body:    JSON.stringify({ token, platform }),
    });
    if (!res.ok && retries > 0) {
      // 4xx → retry yapma (token geçersiz veya sunucu hatası); 5xx → retry
      if (res.status >= 500) {
        const delay = Math.pow(2, 3 - retries) * 1000; // 1s, 2s, 4s
        setTimeout(() => registerPushToken(token, retries - 1), delay);
      }
    }
  } catch {
    // Ağ hatası — retry
    if (retries > 0) {
      const delay = Math.pow(2, 3 - retries) * 1000;
      setTimeout(() => registerPushToken(token, retries - 1), delay);
    }
  }
}

/**
 * Login sonrası çağrılır. Token zaten bellekteyse hemen kaydeder.
 * Token yoksa (uygulama ilk açılışta izin reddedilmişti veya listener
 * henüz ateşlenmemişti) Push.register() ile yeniden talep eder.
 *
 * Kullanım — auth/login başarı callback'inden:
 *   import { onNativePushLogin } from './core/mobile-ux.js';
 *   onNativePushLogin();
 */
export function onNativePushLogin(): void {
  if (!IS_CAPACITOR) return;
  if (_cachedPushToken) {
    // Token var — doğrudan kaydı dene (artık auth da var)
    registerPushToken(_cachedPushToken).catch(() => {/* sessiz */});
    return;
  }
  // Token yok — yeniden register iste; 'registration' event registerPushToken'ı tetikler
  window.Capacitor?.Plugins?.PushNotifications?.register?.()?.catch(() => {/* sessiz */});
}

export async function initNativePush(): Promise<void> {
  if (!IS_CAPACITOR) return;
  const Push = window.Capacitor?.Plugins?.PushNotifications;
  if (!Push) return;

  // Listener'lar bir kez eklenir — hot-reload / SPA navigasyon'da çift eklemeyi önler
  if (_pushListenersAttached) {
    await Push.register?.();
    return;
  }
  _pushListenersAttached = true;

  try {
    // Token kayıt hatası — izin reddedildi veya cihaz desteklemez
    Push.addListener?.('registrationError', (err: Record<string, unknown>) => {
      console.warn('[NativePush] Token kaydı başarısız:', err);
      // Sessiz devam — push opsiyonel özellik, uygulama çalışmaya devam eder
    });

    // Token alındığında: bellekte sakla + server'a kaydet
    Push.addListener?.('registration', (data: Record<string, unknown>) => {
      const token = data.value as string | undefined;
      if (!token) return;
      _cachedPushToken = token;                     // login sonrası retry için sakla
      registerPushToken(token).catch(() => {/* sessiz */});
    });

    // Foreground bildirim → toast
    Push.addListener?.('pushNotificationReceived', (notification: Record<string, unknown>) => {
      const title = (notification.title as string | undefined) ?? '';
      const body  = (notification.body  as string | undefined) ?? '';
      const text  = title ? `${title}: ${body}` : body;
      if (text) BridgeRegistry.call('toast', text, 'info');
    });

    // Bildirime tıklandı → uygulama içi yönlendirme
    Push.addListener?.('pushNotificationActionPerformed', (action: Record<string, unknown>) => {
      const notif = action.notification as Record<string, unknown> | undefined;
      const data  = notif?.data as Record<string, unknown> | undefined;
      const url   = data?.url as string | undefined;
      if (url) BridgeRegistry.call('navigateToUrl', url);
    });

    // İzin iste + token al
    await Push.register?.();
  } catch (err) {
    // Push izni reddedildi veya plugin yok — sessiz devam
    console.warn('[NativePush] Init başarısız:', err);
  }
}

// ── Init ──────────────────────────────────────────────────────

export function initMobileUX(): void {
  initSwipeNavigation();
  initKeyboardAvoidance();
  initPullToRefresh();
  initDoubleTapReact();
  initAndroidBack();
  initMobileAudio();
  initNativePush().catch(() => {/* Capacitor yoksa sessiz */});

  const observer = new MutationObserver(() => {
    updateStatusBarColor(document.body.dataset.theme ?? 'dark');
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileUX);
} else {
  initMobileUX();
}

// ── BridgeRegistry ────────────────────────────────────────────

const _mobileUX = { updateStatusBarColor, activateMobileAudioSession, deactivateMobileAudioSession };
BridgeRegistry.register('BridgeMobileUX', _mobileUX);

export const getBridgeMobileAudioConstraints = (): unknown => BridgeRegistry.get('BridgeMobileAudioConstraints');
export const getBridgeMobileUX = (): typeof _mobileUX | null => BridgeRegistry.get('BridgeMobileUX') as typeof _mobileUX | null;
