// client/js/core/state.ts
// Minimal reactive state store – window.* global dağılımını önler.
//
// Kullanım:
//   const channel = window.BridgeState.state.currentChannel;
//   BridgeState.setState({ currentChannel: channel, currentServer: server });
//   const unsub = BridgeState.subscribe('currentChannel', (newVal, oldVal) => { ... });
//   unsub();
//
// Mevcut window.* erişimleri geriye dönük uyumluluk için korunur
// ama tüm yeni kod state.* kullanmalıdır.

'use strict';

interface BridgeStateShape {
  currentUser:       Record<string, unknown> | null;
  token:             string | null;
  currentServer:     Record<string, unknown> | null;
  currentChannel:    Record<string, unknown> | null;
  currentDm:         Record<string, unknown> | null;
  sidebarCollapsed:  boolean;
  mobileView:        boolean;
  currentVoiceChannel: Record<string, unknown> | null;
  voiceConnected:      boolean;
}

type StateKey = keyof BridgeStateShape;
type SubscriberFn<K extends StateKey> = (newVal: BridgeStateShape[K], oldVal: BridgeStateShape[K]) => void;
type WildcardFn = (key: StateKey, newVal: unknown, oldVal: unknown) => void;

declare global {
  interface Window {
    BridgeState: {
      state: BridgeStateShape;
      setState(patch: Partial<BridgeStateShape>): void;
      subscribe<K extends StateKey>(key: K, fn: SubscriberFn<K>): () => void;
      subscribe(key: '*', fn: WildcardFn): () => void;
      initState(): void;
    };
    currentChannel:    BridgeStateShape['currentChannel'];
    currentServer:     BridgeStateShape['currentServer'];
    currentUser:       BridgeStateShape['currentUser'];
    token:             string | null;
    BRIDGE_API?:       string;
  }
}

(function (global: Window) {

  const _state: BridgeStateShape = {
    currentUser:         null,
    token:               null,
    currentServer:       null,
    currentChannel:      null,
    currentDm:           null,
    sidebarCollapsed:    false,
    mobileView:          false,
    currentVoiceChannel: null,
    voiceConnected:      false,
  };

  const _subscribers = new Map<string, Set<(...args: unknown[]) => void>>();

  const state = new Proxy(_state, {
    set() {
      console.warn('[State] Direkt atama yapma, setState() kullan.');
      return false;
    },
  }) as BridgeStateShape;

  function setState(patch: Partial<BridgeStateShape>): void {
    for (const _key of Object.keys(patch) as StateKey[]) {
      const newVal = patch[_key];
      if (!(_key in _state)) {
        console.warn(`[State] Bilinmeyen alan: ${_key}`);
        continue;
      }
      const oldVal = _state[_key];
      if (oldVal === newVal) continue;
      (_state as Record<string, unknown>)[_key] = newVal;

      if (_key === 'currentChannel')    global.currentChannel    = newVal as BridgeStateShape['currentChannel'];
      if (_key === 'currentServer')     global.currentServer     = newVal as BridgeStateShape['currentServer'];
      if (_key === 'currentUser')       global.currentUser       = newVal as BridgeStateShape['currentUser'];
      if (_key === 'token') {
        global.token = newVal as string | null;
        if (newVal) localStorage.setItem('token', newVal as string);
      }

      const subs = _subscribers.get(_key);
      if (subs) subs.forEach(fn => { try { fn(newVal, oldVal); } catch { /**/ } });

      const allSubs = _subscribers.get('*');
      if (allSubs) allSubs.forEach(fn => { try { fn(_key, newVal, oldVal); } catch { /**/ } });
    }
  }

  function subscribe<K extends StateKey>(key: K, fn: SubscriberFn<K>): () => void;
  function subscribe(key: '*', fn: WildcardFn): () => void;
  function subscribe(key: string, fn: (...args: unknown[]) => void): () => void {
    if (!_subscribers.has(key)) _subscribers.set(key, new Set());
    _subscribers.get(key)!.add(fn);
    return () => _subscribers.get(key)?.delete(fn);
  }

  function initState(): void {
    const savedToken = localStorage.getItem('token');
    if (savedToken) _state.token = savedToken;
    if (global.currentUser)    _state.currentUser    = global.currentUser;
    if (global.currentServer)  _state.currentServer  = global.currentServer;
    if (global.currentChannel) _state.currentChannel = global.currentChannel;
  }

  global.BridgeState = { state, setState, subscribe, initState };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initState, { once: true });
  } else {
    initState();
  }

})(window);

export {};
