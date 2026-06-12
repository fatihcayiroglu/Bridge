// @ts-check
// mobile/capacitor-bridge.js
// Capacitor native API'lerini Bridge web uygulamasına bağlar.
// Sprint 50: IIFE → ESM dönüşümü + JSDoc eklendi
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
// NOT: Bu dosya www/js/capacitor-bridge.js olarak kopyalanır (build adımı).
//      www/js/capacitor-bridge.js artık kaynak olarak tutulmamaktadır.

// mobile/capacitor-bridge.js
// Capacitor native API'lerini Bridge web uygulamasına bağlar.
// Bu dosya www/js/capacitor-bridge.js olarak kopyalanır ve index.html'e eklenir.
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

  'use strict';

/**
 * Capacitor mevcut değilse (web ortamı) modülü sessizce sonlandır.
 * @returns {void}
 */
if (typeof Capacitor === 'undefined') {
  // Web ortamında Capacitor API'leri mevcut değil
  // eslint-disable-next-line no-console
  console.debug('[Bridge Mobile] Capacitor bulunamadı, native modül devre dışı.');
} else {

  const {
    PushNotifications, LocalNotifications,
    StatusBar, SplashScreen, Keyboard,
    Haptics, Network, App,
    BiometricAuth,
    Camera,
    Badge,
    Share,
  } = Capacitor.Plugins;

  // ── SPLASH SCREEN ──────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    try { await SplashScreen.hide({ fadeOutDuration: 300 }); } catch (_) {}
  });

  // ── STATUS BAR ─────────────────────────────────────────────────
  async function applyStatusBar(isDark) {
    try {
      await StatusBar.setStyle({ style: isDark ? 'Dark' : 'Light' });
      await StatusBar.setBackgroundColor({ color: isDark ? '#1a1a2e' : '#ffffff' });
    } catch (_) {}
  }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  applyStatusBar(prefersDark.matches);
  prefersDark.addEventListener('change', e => applyStatusBar(e.matches));

  // ── KLAVYE ─────────────────────────────────────────────────────
  if (Keyboard) {
    Keyboard.addListener('keyboardWillShow', info => {
      document.documentElement.style.setProperty('--keyboard-height', info.keyboardHeight + 'px');
      document.body.classList.add('keyboard-open');
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.style.setProperty('--keyboard-height', '0px');
      document.body.classList.remove('keyboard-open');
    });
  }

  // ── HAPTIC ─────────────────────────────────────────────────────
  window.bridgeHaptic = {
    light:   () => Haptics && Haptics.impact({ style: 'Light' }).catch(() => {}),
    medium:  () => Haptics && Haptics.impact({ style: 'Medium' }).catch(() => {}),
    success: () => Haptics && Haptics.notification({ type: 'Success' }).catch(() => {}),
    warning: () => Haptics && Haptics.notification({ type: 'Warning' }).catch(() => {}),
    error:   () => Haptics && Haptics.notification({ type: 'Error' }).catch(() => {}),
  };
  document.addEventListener('click', e => {
    if (e.target.closest('#sendButton, .send-btn, [data-haptic]')) window.bridgeHaptic.light();
  });

  // ── BADGE SAYACI ───────────────────────────────────────────────
  var bridgeBadge = {
    _count: 0,
    set: async function(count) {
      this._count = Math.max(0, count);
      try { if (Badge) await Badge.set({ count: this._count }); } catch (_) {}
      window.dispatchEvent(new CustomEvent('bridge:badge', { detail: { count: this._count } }));
    },
    increment: async function() { await this.set(this._count + 1); },
    clear: async function() {
      await this.set(0);
      var jwt = localStorage.getItem('bridge_token');
      if (jwt) fetch('/api/mobile/push/badge/clear', { method: 'POST', headers: { 'Authorization': 'Bearer ' + jwt } }).catch(function(){});
    },
  };
  window.bridgeBadge = bridgeBadge;

  // ── PUSH BİLDİRİMLERİ ──────────────────────────────────────────
  async function setupPushNotifications() {
    if (!PushNotifications) return;
    var permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') { console.warn('[Bridge Mobile] Push izni verilmedi'); return; }
    await PushNotifications.register();

    PushNotifications.addListener('registration', async function(token) {
      try {
        var jwt = localStorage.getItem('bridge_token');
        if (!jwt) return;
        await fetch('/api/mobile/push/register-native', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
          body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() }),
        });
      } catch (err) { console.error('[Bridge Mobile] Token kaydı başarısız:', err); }
    });

    PushNotifications.addListener('pushNotificationReceived', function(notification) {
      showLocalNotification(notification.title, notification.body, notification.data);
      bridgeBadge.increment();
    });

    PushNotifications.addListener('pushNotificationActionPerformed', function(action) {
      var data = action.notification.data;
      bridgeBadge.clear();
      if (data && data.channelId) {
        window.dispatchEvent(new CustomEvent('bridge:navigate', { detail: { channelId: data.channelId, serverId: data.serverId } }));
      }
    });
  }

  async function showLocalNotification(title, body, data) {
    if (!LocalNotifications) return;
    try {
      await LocalNotifications.schedule({ notifications: [{ title: title, body: body, id: Date.now(), extra: data || {}, smallIcon: 'ic_stat_bridge', iconColor: '#2d9cdb' }] });
    } catch (_) {}
  }

  // ── DEEP LINK ──────────────────────────────────────────────────
  // bridge://invite/<code>
  // Desteklenen şemalar:
  //   bridge://channel/<channelId>
  //   bridge://dm/<userId>
  //   bridge://server/<serverId>
  //   bridge://server/<serverId>/channel/<channelId>
  //   bridge://invite/<code>
  //   bridge://activity/<channelId>/<activityId>
  //   bridge://settings[/<tab>]
  //   bridge://auth/callback?token=<jwt>
  //   bridge://user/<userId>   (eski uyumluluk — profile açar)
  //
  // Dispatch: window.dispatchEvent('bridge:deeplink', { detail }) ile ana uygulamaya iletilir.
  function handleDeepLink(url) {
    if (!url) return;
    var parsed;
    try { parsed = new URL(url); } catch (_) { return; }
    var isCustomScheme = parsed.protocol === 'bridge:';
    var path = isCustomScheme
      ? (parsed.hostname + parsed.pathname).replace(/^\/+/, '')
      : parsed.pathname.replace(/^\/+/, '');
    var parts = path.split('/').filter(Boolean);
    var section = parts[0];
    var rest    = parts.slice(1);

    var navPayload = (function () {
      switch (section) {
        case 'channel':
          return { type: 'navigate:channel', channelId: rest[0] };

        case 'dm':
          return { type: 'navigate:dm', userId: rest[0] };

        case 'user':
          return { type: 'navigate:profile', userId: rest[0] };

        case 'server':
          if (rest[1] === 'channel') {
            return { type: 'navigate:channel', serverId: rest[0], channelId: rest[2] };
          }
          return { type: 'navigate:server', serverId: rest[0] };

        case 'invite':
          return { type: 'navigate:invite', code: rest[0] };

        case 'activity':
          return { type: 'navigate:activity', channelId: rest[0], activityId: rest[1] };

        case 'settings':
          return { type: 'navigate:settings', tab: rest[0] || 'account' };

        case 'auth':
          if (rest[0] === 'callback') {
            var qs = url.indexOf('?') !== -1 ? url.slice(url.indexOf('?') + 1) : '';
            var params = new URLSearchParams(qs);
            return { type: 'auth:callback', token: params.get('token') };
          }
          return null;

        default:
          console.warn('[Bridge Mobile] Bilinmeyen deep link:', section, '| URL:', url);
          return null;
      }
    }());

    if (navPayload) {
      window.bridgeHaptic && window.bridgeHaptic.light();
      window.dispatchEvent(new CustomEvent('bridge:deeplink', { detail: navPayload }));
      console.debug('[Bridge Mobile] Deep link dispatched:', navPayload);
    }
  }

  if (App) {
    App.addListener('appUrlOpen', function(event) { handleDeepLink(event.url); });
    App.getLaunchUrl().then(function(result) { if (result && result.url) handleDeepLink(result.url); }).catch(function(){});
  }
  window.bridgeDeepLink = { handle: handleDeepLink };

  // ── BİOMETRİK AUTH ─────────────────────────────────────────────
  // Face ID (iOS) / Fingerprint (Android)
  var bridgeBiometric = {
    isAvailable: async function() {
      if (!BiometricAuth) return false;
      try { var r = await BiometricAuth.checkBiometry(); return r.isAvailable; } catch (_) { return false; }
    },
    authenticate: async function(reason) {
      if (!BiometricAuth) return { success: false, error: 'plugin_unavailable' };
      try {
        await BiometricAuth.authenticate({
          reason: reason || "Bridge'e giriş yapmak için kimliğinizi doğrulayın",
          cancelTitle: 'İptal',
          allowDeviceCredential: true,
          iosFallbackTitle: 'Şifre Kullan',
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err.code || err.message };
      }
    },
    isEnabled:  function() { return localStorage.getItem('bridge_biometric_enabled') === 'true'; },
    enable:     function() { localStorage.setItem('bridge_biometric_enabled', 'true'); },
    disable:    function() { localStorage.removeItem('bridge_biometric_enabled'); },
  };
  window.bridgeBiometric = bridgeBiometric;

  window.addEventListener('load', async function() {
    var jwt = localStorage.getItem('bridge_token');
    if (jwt && bridgeBiometric.isEnabled()) {
      var available = await bridgeBiometric.isAvailable();
      if (available) window.dispatchEvent(new CustomEvent('bridge:biometric:prompt'));
    }
  });

  // ── KAMERA & GALERİ ────────────────────────────────────────────
  function formatPhoto(photo) {
    var ext      = (photo.format || 'jpeg').toLowerCase();
    var mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    var dataUrl  = photo.dataUrl || ('data:' + mimeType + ';base64,' + photo.base64String);
    return {
      dataUrl:  dataUrl,
      mimeType: mimeType,
      fileName: 'bridge_' + Date.now() + '.' + ext,
      toBlob: function() {
        var base64 = dataUrl.split(',')[1];
        var binary = atob(base64);
        var bytes  = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mimeType });
      },
      toFile: function() {
        return new File([this.toBlob()], this.fileName, { type: mimeType });
      },
    };
  }

  var bridgeCamera = {
    takePhoto: async function() { return this._capture('CAMERA'); },
    pickFromGallery: async function() { return this._capture('PHOTOS'); },
    pickMultiple: async function() {
      if (!Camera) return [];
      try {
        var result = await Camera.pickImages({ quality: 85, limit: 10 });
        return (result.photos || []).map(formatPhoto);
      } catch (err) {
        if (err.message && (err.message.includes('cancelled') || err.message.includes('User cancelled'))) return [];
        console.error('[Bridge Mobile] Çoklu galeri hatası:', err);
        return [];
      }
    },
    _capture: async function(source) {
      if (!Camera) return null;
      try {
        var photo = await Camera.getPhoto({ quality: 85, allowEditing: false, resultType: 'dataUrl', source: source, saveToGallery: false });
        return formatPhoto(photo);
      } catch (err) {
        if (err.message && (err.message.includes('cancelled') || err.message.includes('User cancelled'))) return null;
        console.error('[Bridge Mobile] Kamera/galeri hatası:', err);
        return null;
      }
    },
    isAvailable: async function() {
      if (!Camera) return false;
      try { var p = await Camera.checkPermissions(); return p.camera !== 'denied'; } catch (_) { return false; }
    },
    requestPermissions: async function() {
      if (!Camera) return false;
      try { var r = await Camera.requestPermissions({ permissions: ['camera', 'photos'] }); return r.camera === 'granted' || r.photos === 'granted'; } catch (_) { return false; }
    },
  };
  window.bridgeCamera = bridgeCamera;

  // data-native-camera / data-native-gallery attribute'lu butonları yakala
  document.addEventListener('click', async function(e) {
    var trigger = e.target.closest('[data-native-camera], [data-native-gallery]');
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    window.bridgeHaptic.light();
    var isCamera = trigger.hasAttribute('data-native-camera');
    var photo = isCamera ? await bridgeCamera.takePhoto() : await bridgeCamera.pickFromGallery();
    if (photo) {
      trigger.dispatchEvent(new CustomEvent('bridge:file:selected', { bubbles: true, detail: { file: photo.toFile(), photo: photo } }));
    }
  });

  // ── SHARE SHEET ────────────────────────────────────────────────
  var bridgeShare = {
    share: async function(opts) {
      if (Share) {
        try { await Share.share({ title: opts.title, text: opts.text, url: opts.url, dialogTitle: 'Paylaş' }); return true; } catch (_) {}
      }
      if (navigator.share) {
        try { await navigator.share(opts); return true; } catch (_) {}
      }
      return false;
    },
    shareMessage: function(message) {
      var url = window.location.origin + '/channel/' + message.channelId + '?msg=' + message.id;
      return this.share({ title: 'Bridge mesajı', text: (message.content || '').slice(0, 100), url: url });
    },
    shareInvite: function(inviteCode) {
      return this.share({ title: "Bridge'e katıl", text: "Bridge'de benimle sohbet et!", url: 'https://bridge.app/invite/' + inviteCode });
    },
  };
  window.bridgeShare = bridgeShare;

  // ── AĞ DURUMU ──────────────────────────────────────────────────
  if (Network) {
    Network.addListener('networkStatusChange', function(status) {
      window.dispatchEvent(new CustomEvent('bridge:network', { detail: { connected: status.connected, type: status.connectionType } }));
      var banner = document.getElementById('offline-banner') || createOfflineBanner();
      banner.textContent = '⚠️  İnternet bağlantısı yok';
      banner.style.display = status.connected ? 'none' : 'block';
    });
  }

  function createOfflineBanner() {
    var el = document.createElement('div');
    el.id = 'offline-banner';
    Object.assign(el.style, { position: 'fixed', top: '0', left: '0', right: '0', background: '#ed4245', color: '#fff', textAlign: 'center', padding: '8px', zIndex: '9999', display: 'none', fontSize: '13px' });
    document.body.prepend(el);
    return el;
  }

  // ── UYGULAMA YAŞAM DÖNGÜSÜ ─────────────────────────────────────
  if (App) {
    App.addListener('appStateChange', function(state) {
      window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: state.isActive } }));
      if (state.isActive) bridgeBadge.clear();
    });

    App.addListener('backButton', function() {
      var modal = document.querySelector('.modal.active, .overlay.active, [data-modal].active');
      if (modal) { modal.classList.remove('active'); window.bridgeHaptic.light(); return; }
      var inChannel = document.querySelector('[data-view="channel"]');
      if (inChannel) { window.dispatchEvent(new CustomEvent('bridge:navigate', { detail: { view: 'server-list' } })); return; }
      App.minimizeApp();
    });
  }

  // ── BAŞLAT ─────────────────────────────────────────────────────
  window.addEventListener('load', function() {
    setupPushNotifications();
    console.log('[Bridge Mobile] Capacitor entegrasyonu hazır —', Capacitor.getPlatform());
    console.log('[Bridge Mobile] Özellikler: push, badge, deep-link, biometric, camera, share');
  });
} // end Capacitor guard

export const capacitorBridgeReady = true;
