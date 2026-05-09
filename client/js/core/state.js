// client/js/core/state.js
// Minimal reactive state store — window.* global dağılımını önler.
//
// Kullanım:
//   import { state, setState, subscribe } from './state.js';
//
//   // Okuma
//   const channel = state.currentChannel;
//
//   // Yazma
//   setState({ currentChannel: channel, currentServer: server });
//
//   // İzleme
//   const unsub = subscribe('currentChannel', (newVal, oldVal) => { ... });
//   unsub(); // aboneliği iptal et
//
// Mevcut window.* erişimleri geriye dönük uyumluluk için korunur
// ama tüm yeni kod state.* kullanmalıdır.

'use strict';

(function (global) {

  const _state = {
    // Auth
    currentUser:       null,   // { _id, username, displayName, avatarColor, ... }
    token:             null,   // JWT access token

    // Navigation
    currentServer:     null,   // { _id, name, icon, ... }
    currentChannel:    null,   // { _id, name, type, ... }
    currentDm:         null,   // { _id, participants, ... }

    // UI
    sidebarCollapsed:  false,
    mobileView:        false,

    // Voice
    currentVoiceChannel: null,
    voiceConnected:      false,
  };

  const _subscribers = new Map(); // key → Set<fn>

  /**
   * Mevcut state snapshot'ı döner.
   * Mutasyon yapmayın — setState kullanın.
   */
  const state = new Proxy(_state, {
    set() {
      console.warn('[State] Direkt atama yapma, setState() kullan.');
      return false;
    },
  });

  /**
   * State'i günceller ve aboneleri tetikler.
   * @param {Partial<typeof _state>} patch
   */
  function setState(patch) {
    for (const [key, newVal] of Object.entries(patch)) {
      if (!(key in _state)) {
        console.warn(`[State] Bilinmeyen alan: ${key}`);
        continue;
      }
      const oldVal = _state[key];
      if (oldVal === newVal) continue;
      _state[key] = newVal;

      // Geriye dönük uyumluluk: window.* güncelle
      if (key === 'currentChannel')    global.currentChannel    = newVal;
      if (key === 'currentServer')     global.currentServer     = newVal;
      if (key === 'currentUser')       global.currentUser       = newVal;
      if (key === 'token')             { global.token = newVal; if (newVal) localStorage.setItem('token', newVal); }

      // Aboneleri bildir
      const subs = _subscribers.get(key);
      if (subs) subs.forEach(fn => { try { fn(newVal, oldVal); } catch {} });

      // Wildcard subscribers
      const allSubs = _subscribers.get('*');
      if (allSubs) allSubs.forEach(fn => { try { fn(key, newVal, oldVal); } catch {} });
    }
  }

  /**
   * State değişikliklerine abone ol.
   * @param {string} key - alan adı veya '*' (tüm değişiklikler)
   * @param {Function} fn
   * @returns {Function} - aboneliği iptal eden fonksiyon
   */
  function subscribe(key, fn) {
    if (!_subscribers.has(key)) _subscribers.set(key, new Set());
    _subscribers.get(key).add(fn);
    return () => _subscribers.get(key)?.delete(fn);
  }

  /**
   * State'i başlangıç değerleriyle doldur (sayfa yüklenince).
   * localStorage'daki token ve user varsa uygular.
   */
  function initState() {
    const savedToken = localStorage.getItem('token');
    if (savedToken) _state.token = savedToken;

    // window.* mevcut global değerleri okuyarak başlat (geçiş kolaylığı)
    if (global.currentUser)    _state.currentUser    = global.currentUser;
    if (global.currentServer)  _state.currentServer  = global.currentServer;
    if (global.currentChannel) _state.currentChannel = global.currentChannel;
  }

  // Dışa aç
  global.BridgeState = { state, setState, subscribe, initState };

  // Sayfa yüklenince başlat
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initState, { once: true });
  } else {
    initState();
  }

})(window);

// ─────────────────────────────────────────────────────────────

// IIFE zaten window.BridgeState atar — shim gerekmez.
// Yeni kod: import { state, setState, subscribe } from './state.js';
// ─────────────────────────────────────────────────────────────
export const state     = window.BridgeState?.state;
export const setState  = (...args) => window.BridgeState?.setState(...args);
export const subscribe = (...args) => window.BridgeState?.subscribe(...args);
export const initState = ()        => window.BridgeState?.initState();
export const BridgeState = window.BridgeState;
