// client/js/core/mobile-ux.js — Bridge Mobil UX İyileştirmeleri
// Capacitor native uygulamada çalışan UX geliştirmeleri.
// Alan: Native mobil deneyim

'use strict';
import { getRtc } from './globals.js';

const IS_CAPACITOR = typeof window !== 'undefined' && !!(window.Capacitor?.isNativePlatform?.());
const IS_IOS       = IS_CAPACITOR && window.Capacitor?.getPlatform?.() === 'ios';
const IS_ANDROID   = IS_CAPACITOR && window.Capacitor?.getPlatform?.() === 'android';

/* ── SWIPE TO GO BACK (iOS Tarzı) ─────────────────────── */
let swipeStartX = 0;
let swipeStartY = 0;

function initSwipeNavigation() {
  if (!IS_CAPACITOR) return;

  document.addEventListener('touchstart', (e) => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - swipeStartY);

    // Sağa swipe (kenardan, yatay baskın)
    if (swipeStartX < 30 && dx > 80 && dy < 60) {
      // Sidebar aç (mobilde kanal listesi)
      const sidebar = document.querySelector('.channel-sidebar');
      if (sidebar) sidebar.classList.toggle('mobile-open');
    }
    // Sola swipe: sidebar kapat
    if (dx < -80 && dy < 60) {
      const sidebar = document.querySelector('.channel-sidebar');
      if (sidebar) sidebar.classList.remove('mobile-open');
    }
  }, { passive: true });
}

/* ── KLAVYE KAÇINMA ────────────────────────────────────── */
function initKeyboardAvoidance() {
  if (!IS_CAPACITOR) return;

  // visualViewport API ile klavye yüksekliğini takip et
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const offset = window.innerHeight - window.visualViewport.height;
      const msgArea = document.querySelector('.message-input-area, .msg-input-wrap');
      if (msgArea) {
        msgArea.style.transform = offset > 50
          ? `translateY(-${offset}px)`
          : '';
      }
    });
  }
}

/* ── PULL-TO-REFRESH ───────────────────────────────────── */
let pullStartY = 0;
let pulling = false;

function initPullToRefresh() {
  if (!IS_CAPACITOR) return;

  const msgList = document.querySelector('#messages, .messages-list');
  if (!msgList) return;

  msgList.addEventListener('touchstart', (e) => {
    if (msgList.scrollTop === 0) {
      pullStartY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  msgList.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - pullStartY;
    if (dy > 60 && msgList.scrollTop === 0) {
      // Daha eski mesajları yükle
      window.loadMoreMessages?.();
      pulling = false;
    }
  }, { passive: true });

  msgList.addEventListener('touchend', () => { pulling = false; }, { passive: true });
}

/* ── DOUBLE TAP TO REACT ───────────────────────────────── */
const tapTimers = new Map();

function initDoubleTapReact() {
  if (!IS_CAPACITOR) return;

  document.addEventListener('touchend', (e) => {
    const msgEl = e.target.closest('.message-item');
    if (!msgEl) return;

    const msgId = msgEl.dataset.id;
    if (!msgId) return;

    if (tapTimers.has(msgId)) {
      clearTimeout(tapTimers.get(msgId));
      tapTimers.delete(msgId);
      // Double tap → ❤️ reaksiyonu
      window.addReaction?.(msgId, '❤️');
      // Haptic feedback
      window.bridgeHaptic?.light?.();
      // Mini kalp animasyonu
      showHeartBurst(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    } else {
      tapTimers.set(msgId, setTimeout(() => tapTimers.delete(msgId), 300));
    }
  }, { passive: true });
}

function showHeartBurst(x, y) {
  const heart = document.createElement('div');
  heart.textContent = '❤️';
  heart.style.cssText = `
    position:fixed;left:${x}px;top:${y}px;font-size:28px;
    pointer-events:none;z-index:9999;
    animation:heartBurst 600ms ease-out forwards;transform-origin:center;
  `;
  document.body.appendChild(heart);
  setTimeout(() => heart.remove(), 650);
}

// Stil enjekte et
const heartStyle = document.createElement('style');
heartStyle.textContent = `
  @keyframes heartBurst {
    0%   { opacity:1; transform: scale(0.5) translate(-50%,-50%); }
    50%  { opacity:1; transform: scale(1.4) translate(-50%,-50%); }
    100% { opacity:0; transform: scale(1.0) translate(-50%,-110%); }
  }
  /* Mobil sidebar overlay */
  @media (max-width: 768px) {
    .channel-sidebar {
      position: fixed !important;
      left: 0; top: 0; bottom: 0;
      z-index: var(--z-sidebar, 200);
      transform: translateX(-100%);
      transition: transform 250ms var(--ease-out, cubic-bezier(0.16,1,0.3,1));
      box-shadow: var(--shadow-xl);
    }
    .channel-sidebar.mobile-open {
      transform: translateX(0);
    }
    .server-list {
      position: fixed !important;
      left: 0; top: 0; bottom: 0;
      z-index: calc(var(--z-sidebar, 200) + 1);
      transform: translateX(-100%);
      transition: transform 250ms var(--ease-out, cubic-bezier(0.16,1,0.3,1));
    }
    .channel-sidebar.mobile-open ~ .main-area { pointer-events: none; }
    .mobile-sidebar-backdrop {
      position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:calc(var(--z-sidebar,200) - 1);
    }
    /* Bottom safe area (iPhone X+) */
    .message-input-area, .msg-input-wrap {
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    /* Mesaj baloncuğu — mobilde biraz daha büyük dokunma hedefi */
    .message-item { min-height: 44px; }
    .reaction { min-width: 44px; min-height: 32px; }
  }
`;
document.head.appendChild(heartStyle);

/* ── ANDROID BACK BUTTON ───────────────────────────────── */
function initAndroidBack() {
  if (!IS_ANDROID) return;

  document.addEventListener('backbutton', (e) => {
    e.preventDefault();
    const modal = document.querySelector('.modal-overlay');
    if (modal) { modal.remove(); return; }
    const sidebar = document.querySelector('.channel-sidebar.mobile-open');
    if (sidebar) { sidebar.classList.remove('mobile-open'); return; }
    // Minimize et (kapat değil)
    window.Capacitor?.Plugins?.App?.minimizeApp?.();
  });
}

/* ── STATUS BAR RENK GÜNCELLEME ────────────────────────── */
function updateStatusBarColor(theme) {
  if (!IS_CAPACITOR) return;
  const colors = {
    dark:     '#1a1b1e',
    light:    '#f2f3f5',
    amoled:   '#000000',
    midnight: '#0d0f16',
  };
  const color = colors[theme] || colors.dark;
  window.Capacitor?.Plugins?.StatusBar?.setBackgroundColor?.({ color });
}

/* ── MOBİL SES DESTEĞİ ─────────────────────────────────── */
// iOS ve Android için ses oturumu yönetimi:
//  • iOS: AVAudioSession kategori & mod ayarı (Capacitor Native Audio)
//  • Android: AudioManager modu (communication mode)
//  • Her ikisi: getUserMedia'ya mobil optimize kısıtlamalar
//  • Kulaklık tak/çıkar olayları
//  • WebRTC stream'i için mobil ses track entegrasyonu

let _mobileAudioSessionActive = false;

function initMobileAudio() {
  if (!IS_CAPACITOR) {
    // Web tarayıcısında da mobilin ses constraint düzeltmesini uygula
    _patchMobileAudioConstraints();
    return;
  }

  // Capacitor Native Audio (varsa) — iOS AVAudioSession
  _setupNativeAudioSession();

  // Kulaklık değişikliği olayı
  _watchHeadphoneEvents();

  // Proximiy sensörü — iOS kulaklıksız konuşmada hoparlöre geçiş
  if (IS_IOS) _watchProximitySensor();

  // getUserMedia kısıtlamalarını mobil için optimize et
  _patchMobileAudioConstraints();

  console.log('[MobileAudio] Mobil ses desteği başlatıldı ✓');
}

/* iOS AVAudioSession ve Android AudioManager */
async function _setupNativeAudioSession() {
  try {
    // @capacitor-community/native-audio veya özel plugin
    const NativeAudio = window.Capacitor?.Plugins?.NativeAudio;
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession || window.Capacitor?.Plugins?.AudioSession;

    if (AudioSession) {
      // VoiceChat kategorisi — echo cancellation + bluetooth desteği
      await AudioSession.configure({
        category: 'playAndRecord',
        mode: IS_IOS ? 'voiceChat' : 'communication',
        options: ['allowBluetooth', 'allowBluetoothA2DP', 'defaultToSpeaker'],
      });
      console.log('[MobileAudio] AudioSession yapılandırıldı (voiceChat modu)');
    }

    // Android: AudioManager communication mode
    if (IS_ANDROID) {
      const AndroidAudio = window.Capacitor?.Plugins?.AndroidAudio;
      if (AndroidAudio) {
        await AndroidAudio.setMode({ mode: 'COMMUNICATION' });
      }
    }
  } catch (e) {
    console.info('[MobileAudio] Native audio session kurulamadı, web fallback:', e.message);
  }
}

/* Ses kanalına girince AudioSession aktive et */
async function activateMobileAudioSession() {
  if (!IS_CAPACITOR || _mobileAudioSessionActive) return;
  try {
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession || window.Capacitor?.Plugins?.AudioSession;
    if (AudioSession?.activate) {
      await AudioSession.activate();
      _mobileAudioSessionActive = true;
      console.log('[MobileAudio] AudioSession aktive edildi');
    }
  } catch (e) {
    console.info('[MobileAudio] AudioSession activate hatası:', e.message);
  }
}

/* Ses kanalından çıkınca AudioSession deaktive et */
async function deactivateMobileAudioSession() {
  if (!IS_CAPACITOR || !_mobileAudioSessionActive) return;
  try {
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession || window.Capacitor?.Plugins?.AudioSession;
    if (AudioSession?.deactivate) {
      await AudioSession.deactivate();
      _mobileAudioSessionActive = false;
      console.log('[MobileAudio] AudioSession deaktive edildi');
    }
  } catch (e) {}
}

/* Kulaklık tak/çıkar olayları */
function _watchHeadphoneEvents() {
  try {
    // Capacitor AudioSession headphone events
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession || window.Capacitor?.Plugins?.AudioSession;
    if (AudioSession?.addListener) {
      AudioSession.addListener('headphonesChange', ({ connected, type }) => {
        console.log(`[MobileAudio] Kulaklık değişikliği: ${connected ? 'takıldı' : 'çıkarıldı'} (${type})`);
        window.dispatchEvent(new CustomEvent('bridge:headphones-changed', { detail: { connected, type } }));
        if (!connected && getRtc()?.isInVoice()) {
          // Kulaklık çıkarıldı — kullanıcıya bildir
          if (typeof toast === 'function') toast('🎧 Kulaklık bağlantısı kesildi', 'warn');
        }
      });
    }
  } catch (e) {
    console.info('[MobileAudio] Kulaklık olayları dinlenemedi:', e.message);
  }
}

/* iOS proximity sensörü — kulaklıksız kullanımda hoparlöre otomatik geçiş */
function _watchProximitySensor() {
  try {
    if ('ProximitySensor' in window) {
      const sensor = new window.ProximitySensor();
      sensor.addEventListener('reading', () => {
        const near = sensor.near;
        _setIosSpeaker(!near); // yakın → kulaklık (ear), uzak → hoparlör
      });
      sensor.start();
    }
  } catch (e) {
    // Sensör yoksa sorun değil
  }
}

/* iOS hoparlör / earpiece geçişi */
async function _setIosSpeaker(useSpeaker) {
  try {
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession || window.Capacitor?.Plugins?.AudioSession;
    if (AudioSession?.configure) {
      await AudioSession.configure({
        category: 'playAndRecord',
        mode: 'voiceChat',
        options: useSpeaker
          ? ['allowBluetooth', 'allowBluetoothA2DP', 'defaultToSpeaker']
          : ['allowBluetooth', 'allowBluetoothA2DP'],
      });
    }
  } catch (e) {}
}

/* Mobil için getUserMedia ses kısıtlamalarını optimize et */
function _patchMobileAudioConstraints() {
  // webrtc.js joinVoice çağrılmadan önce BridgeMobileAudioConstraints objesini yayınla
  // webrtc.js bunu okuyarak kendi constraints'ini geçersiz kılar

  // Mobil optimize kısıtlamalar:
  //  - echoCancellation: true (mobilde çok önemli — hoparlör/mikrofon aynı cihazda)
  //  - noiseSuppression: true
  //  - autoGainControl: true (mobil microfonlar geniş dinamik aralık)
  //  - sampleRate: 48000
  //  - channelCount: 1 (mono — mobilde stereo gereksiz, bant genişliğini artırır)
  //  - latency: 0 (düşük gecikme)

  window.BridgeMobileAudioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  true,
    sampleRate:       48000,
    channelCount:     1,
    latency:          0,
    ...(IS_IOS ? { suppressLocalAudioPlayback: true } : {}),
  };

  // webrtc.js'deki joinVoice'u kapasitör'de çalışırken patch'le
  if (!IS_CAPACITOR) return;

  const _originalJoinVoice = window.BridgeRTCClass?.prototype?.joinVoice;
  if (!_originalJoinVoice) {
    // webrtc.js henüz yüklenmemiş, event ile bekle
    document.addEventListener('bridge:rtc-ready', _applyRTCPatch);
    return;
  }
  _applyRTCPatch();
}

function _applyRTCPatch() {
  // rtc instance üzerinde joinVoice çağrısını intercept ederek
  // mobil ses kısıtlamalarını ve AudioSession aktivasyonunu uygula
  const rtcObj = getRtc() || window.bridgeRTC;
  if (!rtcObj) return;

  const orig = rtcObj.joinVoice?.bind(rtcObj);
  if (!orig || rtcObj._mobilePatchApplied) return;
  rtcObj._mobilePatchApplied = true;

  rtcObj.joinVoice = async function(channelId, serverId) {
    await activateMobileAudioSession();

    // Mevcut constraints'e mobil optimize constraints'i merge et
    const mobileConstraints = window.BridgeMobileAudioConstraints || {};
    this._mobileAudioOverride = mobileConstraints;

    try {
      return await orig(channelId, serverId);
    } finally {
      this._mobileAudioOverride = null;
    }
  };

  const origLeave = rtcObj.leaveVoice?.bind(rtcObj);
  if (origLeave) {
    rtcObj.leaveVoice = async function() {
      const result = origLeave();
      await deactivateMobileAudioSession();
      return result;
    };
  }

  console.log('[MobileAudio] RTC patch uygulandı ✓');
}

/* ── BAŞLAT ─────────────────────────────────────────────── */
function initMobileUX() {
  initSwipeNavigation();
  initKeyboardAvoidance();
  initPullToRefresh();
  initDoubleTapReact();
  initAndroidBack();
  initMobileAudio();

  // Tema değişince status bar'ı güncelle
  const observer = new MutationObserver(() => {
    const theme = document.body.dataset.theme || 'dark';
    updateStatusBarColor(theme);
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });

  console.log(`[MobileUX] Başlatıldı — platform: ${IS_IOS ? 'iOS' : IS_ANDROID ? 'Android' : 'Web'}`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileUX);
} else {
  initMobileUX();
}

window.BridgeMobileUX = {
  updateStatusBarColor,
  activateMobileAudioSession,
  deactivateMobileAudioSession,
};

export {
  activateMobileAudioSession,
  deactivateMobileAudioSession,
  initAndroidBack,
  initDoubleTapReact,
  initKeyboardAvoidance,
  initMobileAudio,
  initMobileUX,
  initPullToRefresh,
  initSwipeNavigation,
  showHeartBurst,
  updateStatusBarColor,
};

export const getBridgeMobileAudioConstraints = () => window.BridgeMobileAudioConstraints;
export const getBridgeMobileUX = () => window.BridgeMobileUX;
