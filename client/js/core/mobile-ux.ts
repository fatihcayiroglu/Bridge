// client/js/core/mobile-ux.js â€” Bridge Mobil UX Ä°yileÅŸtirmeleri
// Capacitor native uygulamada Ã§alÄ±ÅŸan UX geliÅŸtirmeleri.
// Alan: Native mobil deneyim

'use strict';

const IS_CAPACITOR = typeof window !== 'undefined' && !!(window.Capacitor?.isNativePlatform?.());
const IS_IOS       = IS_CAPACITOR && window.Capacitor?.getPlatform?.() === 'ios';
const IS_ANDROID   = IS_CAPACITOR && window.Capacitor?.getPlatform?.() === 'android';

/* â”€â”€ SWIPE TO GO BACK (iOS TarzÄ±) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

    // SaÄŸa swipe (kenardan, yatay baskÄ±n)
    if (swipeStartX < 30 && dx > 80 && dy < 60) {
      // Sidebar aÃ§ (mobilde kanal listesi)
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

/* â”€â”€ KLAVYE KAÃ‡INMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function initKeyboardAvoidance() {
  if (!IS_CAPACITOR) return;

  // visualViewport API ile klavye yÃ¼ksekliÄŸini takip et
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

/* â”€â”€ PULL-TO-REFRESH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
      // Daha eski mesajlarÄ± yÃ¼kle
      window.loadMoreMessages?.();
      pulling = false;
    }
  }, { passive: true });

  msgList.addEventListener('touchend', () => { pulling = false; }, { passive: true });
}

/* â”€â”€ DOUBLE TAP TO REACT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
      // Double tap â†’ â¤ï¸ reaksiyonu
      window.addReaction?.(msgId, 'â¤ï¸');
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
  heart.textContent = 'â¤ï¸';
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
    /* Mesaj baloncuÄŸu â€” mobilde biraz daha bÃ¼yÃ¼k dokunma hedefi */
    .message-item { min-height: 44px; }
    .reaction { min-width: 44px; min-height: 32px; }
  }
`;
document.head.appendChild(heartStyle);

/* â”€â”€ ANDROID BACK BUTTON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function initAndroidBack() {
  if (!IS_ANDROID) return;

  document.addEventListener('backbutton', (e) => {
    e.preventDefault();
    const modal = document.querySelector('.modal-overlay');
    if (modal) { modal.remove(); return; }
    const sidebar = document.querySelector('.channel-sidebar.mobile-open');
    if (sidebar) { sidebar.classList.remove('mobile-open'); return; }
    // Minimize et (kapat deÄŸil)
    window.Capacitor?.Plugins?.App?.minimizeApp?.();
  });
}

/* â”€â”€ STATUS BAR RENK GÃœNCELLEME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€ MOBÄ°L SES DESTEÄÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
// iOS ve Android iÃ§in ses oturumu yÃ¶netimi:
//  â€¢ iOS: AVAudioSession kategori & mod ayarÄ± (Capacitor Native Audio)
//  â€¢ Android: AudioManager modu (communication mode)
//  â€¢ Her ikisi: getUserMedia'ya mobil optimize kÄ±sÄ±tlamalar
//  â€¢ KulaklÄ±k tak/Ã§Ä±kar olaylarÄ±
//  â€¢ WebRTC stream'i iÃ§in mobil ses track entegrasyonu

let _mobileAudioSessionActive = false;

function initMobileAudio() {
  if (!IS_CAPACITOR) {
    // Web tarayÄ±cÄ±sÄ±nda da mobilin ses constraint dÃ¼zeltmesini uygula
    _patchMobileAudioConstraints();
    return;
  }

  // Capacitor Native Audio (varsa) â€” iOS AVAudioSession
  _setupNativeAudioSession();

  // KulaklÄ±k deÄŸiÅŸikliÄŸi olayÄ±
  _watchHeadphoneEvents();

  // Proximiy sensÃ¶rÃ¼ â€” iOS kulaklÄ±ksÄ±z konuÅŸmada hoparlÃ¶re geÃ§iÅŸ
  if (IS_IOS) _watchProximitySensor();

  // getUserMedia kÄ±sÄ±tlamalarÄ±nÄ± mobil iÃ§in optimize et
  _patchMobileAudioConstraints();

  console.log('[MobileAudio] Mobil ses desteÄŸi baÅŸlatÄ±ldÄ± âœ“');
}

/* iOS AVAudioSession ve Android AudioManager */
async function _setupNativeAudioSession() {
  try {
    // @capacitor-community/native-audio veya Ã¶zel plugin
    const NativeAudio = window.Capacitor?.Plugins?.NativeAudio;
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession || window.Capacitor?.Plugins?.AudioSession;

    if (AudioSession) {
      // VoiceChat kategorisi â€” echo cancellation + bluetooth desteÄŸi
      await AudioSession.configure({
        category: 'playAndRecord',
        mode: IS_IOS ? 'voiceChat' : 'communication',
        options: ['allowBluetooth', 'allowBluetoothA2DP', 'defaultToSpeaker'],
      });
      console.log('[MobileAudio] AudioSession yapÄ±landÄ±rÄ±ldÄ± (voiceChat modu)');
    }

    // Android: AudioManager communication mode
    if (IS_ANDROID) {
      const AndroidAudio = window.Capacitor?.Plugins?.AndroidAudio;
      if (AndroidAudio) {
        await AndroidAudio.setMode({ mode: 'COMMUNICATION' });
      }
    }
  } catch (e) {
    console.info('[MobileAudio] Native audio session kurulamadÄ±, web fallback:', e.message);
  }
}

/* Ses kanalÄ±na girince AudioSession aktive et */
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
    console.info('[MobileAudio] AudioSession activate hatasÄ±:', e.message);
  }
}

/* Ses kanalÄ±ndan Ã§Ä±kÄ±nca AudioSession deaktive et */
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

/* KulaklÄ±k tak/Ã§Ä±kar olaylarÄ± */
function _watchHeadphoneEvents() {
  try {
    // Capacitor AudioSession headphone events
    const AudioSession = window.Capacitor?.Plugins?.CapacitorAudioSession || window.Capacitor?.Plugins?.AudioSession;
    if (AudioSession?.addListener) {
      AudioSession.addListener('headphonesChange', ({ connected, type }) => {
        console.log(`[MobileAudio] KulaklÄ±k deÄŸiÅŸikliÄŸi: ${connected ? 'takÄ±ldÄ±' : 'Ã§Ä±karÄ±ldÄ±'} (${type})`);
        window.dispatchEvent(new CustomEvent('bridge:headphones-changed', { detail: { connected, type } }));
        if (!connected && window.rtc?.isInVoice()) {
          // KulaklÄ±k Ã§Ä±karÄ±ldÄ± â€” kullanÄ±cÄ±ya bildir
          if (typeof toast === 'function') toast('ğŸ§ KulaklÄ±k baÄŸlantÄ±sÄ± kesildi', 'warn');
        }
      });
    }
  } catch (e) {
    console.info('[MobileAudio] KulaklÄ±k olaylarÄ± dinlenemedi:', e.message);
  }
}

/* iOS proximity sensÃ¶rÃ¼ â€” kulaklÄ±ksÄ±z kullanÄ±mda hoparlÃ¶re otomatik geÃ§iÅŸ */
function _watchProximitySensor() {
  try {
    if ('ProximitySensor' in window) {
      const sensor = new window.ProximitySensor();
      sensor.addEventListener('reading', () => {
        const near = sensor.near;
        _setIosSpeaker(!near); // yakÄ±n â†’ kulaklÄ±k (ear), uzak â†’ hoparlÃ¶r
      });
      sensor.start();
    }
  } catch (e) {
    // SensÃ¶r yoksa sorun deÄŸil
  }
}

/* iOS hoparlÃ¶r / earpiece geÃ§iÅŸi */
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

/* Mobil iÃ§in getUserMedia ses kÄ±sÄ±tlamalarÄ±nÄ± optimize et */
function _patchMobileAudioConstraints() {
  // webrtc.js joinVoice Ã§aÄŸrÄ±lmadan Ã¶nce BridgeMobileAudioConstraints objesini yayÄ±nla
  // webrtc.js bunu okuyarak kendi constraints'ini geÃ§ersiz kÄ±lar

  // Mobil optimize kÄ±sÄ±tlamalar:
  //  - echoCancellation: true (mobilde Ã§ok Ã¶nemli â€” hoparlÃ¶r/mikrofon aynÄ± cihazda)
  //  - noiseSuppression: true
  //  - autoGainControl: true (mobil microfonlar geniÅŸ dinamik aralÄ±k)
  //  - sampleRate: 48000
  //  - channelCount: 1 (mono â€” mobilde stereo gereksiz, bant geniÅŸliÄŸini artÄ±rÄ±r)
  //  - latency: 0 (dÃ¼ÅŸÃ¼k gecikme)

  window.BridgeMobileAudioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  true,
    sampleRate:       48000,
    channelCount:     1,
    latency:          0,
    ...(IS_IOS ? { suppressLocalAudioPlayback: true } : {}),
  };

  // webrtc.js'deki joinVoice'u kapasitÃ¶r'de Ã§alÄ±ÅŸÄ±rken patch'le
  if (!IS_CAPACITOR) return;

  const _originalJoinVoice = window.BridgeRTCClass?.prototype?.joinVoice;
  if (!_originalJoinVoice) {
    // webrtc.js henÃ¼z yÃ¼klenmemiÅŸ, event ile bekle
    document.addEventListener('bridge:rtc-ready', _applyRTCPatch);
    return;
  }
  _applyRTCPatch();
}

function _applyRTCPatch() {
  // rtc instance Ã¼zerinde joinVoice Ã§aÄŸrÄ±sÄ±nÄ± intercept ederek
  // mobil ses kÄ±sÄ±tlamalarÄ±nÄ± ve AudioSession aktivasyonunu uygula
  const rtcObj = window.rtc || window.bridgeRTC;
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

  console.log('[MobileAudio] RTC patch uygulandÄ± âœ“');
}

/* â”€â”€ BAÅLAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function initMobileUX() {
  initSwipeNavigation();
  initKeyboardAvoidance();
  initPullToRefresh();
  initDoubleTapReact();
  initAndroidBack();
  initMobileAudio();

  // Tema deÄŸiÅŸince status bar'Ä± gÃ¼ncelle
  const observer = new MutationObserver(() => {
    const theme = document.body.dataset.theme || 'dark';
    updateStatusBarColor(theme);
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });

  console.log(`[MobileUX] BaÅŸlatÄ±ldÄ± â€” platform: ${IS_IOS ? 'iOS' : IS_ANDROID ? 'Android' : 'Web'}`);
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

