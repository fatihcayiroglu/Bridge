// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/StatePanel.svelte
//              client/js/core/state-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/state.ts
// Minimal reactive state store.
//
// Sprint 31: ESM export eklendi — import { BridgeState } from './state.js'
// Sprint 80: window.BridgeState köprüsü kaldırıldı. Tüm tüketiciler ESM import kullanıyor.
//            import { BridgeState } from './state.js'  ← tek doğru yol
//
// Kullanım:
//   import { BridgeState } from './state.js';
//   const ch = BridgeState.state.currentChannel;
//   BridgeState.setState({ currentChannel: channel });
//   const unsub = BridgeState.subscribe('currentChannel', (v) => { ... });

'use strict';

import { createLogger } from './logger.js';
const log = createLogger('State');


export interface BridgeStateShape {
  currentUser:         Record<string, unknown> | null;
  token:               string | null;
  currentServer:       Record<string, unknown> | null;
  currentChannel:      Record<string, unknown> | null;
  currentDm:           Record<string, unknown> | null;
  sidebarCollapsed:    boolean;
  mobileView:          boolean;
  currentVoiceChannel: Record<string, unknown> | null;
  voiceConnected:      boolean;
}

type StateKey = keyof BridgeStateShape;
type SubscriberFn<K extends StateKey> = (newVal: BridgeStateShape[K], oldVal: BridgeStateShape[K]) => void;
type WildcardFn = (key: StateKey, newVal: unknown, oldVal: unknown) => void;

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

export const state = new Proxy(_state, {
  set() {
    log.warn('[State] Direkt atama yapma, setState() kullan.');
    return false;
  },
}) as BridgeStateShape;

export function setState(patch: Partial<BridgeStateShape>): void {
  for (const _key of Object.keys(patch) as StateKey[]) {
    const newVal = patch[_key];
    if (!(_key in _state)) {
      log.warn(`[State] Bilinmeyen alan: ${_key}`);
      continue;
    }
    const oldVal = _state[_key];
    if (oldVal === newVal) continue;
    (_state as Record<string, unknown>)[_key] = newVal;

    if (_key === 'token') {
      (window as Record<string, unknown>).token = newVal;
      if (newVal) localStorage.setItem('token', newVal as string);
    }

    const subs = _subscribers.get(_key);
    if (subs) subs.forEach(fn => { try { fn(newVal, oldVal); } catch { /**/ } });

    const allSubs = _subscribers.get('*');
    if (allSubs) allSubs.forEach(fn => { try { fn(_key, newVal, oldVal); } catch { /**/ } });
  }
}

export function subscribe<K extends StateKey>(key: K, fn: SubscriberFn<K>): () => void;
export function subscribe(key: '*', fn: WildcardFn): () => void;
export function subscribe(key: string, fn: (...args: unknown[]) => void): () => void {
  if (!_subscribers.has(key)) _subscribers.set(key, new Set());
  _subscribers.get(key)!.add(fn);
  return () => _subscribers.get(key)?.delete(fn);
}

export function initState(): void {
  const savedToken = localStorage.getItem('token');
  if (savedToken) _state.token = savedToken;
  const w = window as Record<string, unknown>;
  if (w.currentUser)    _state.currentUser    = w.currentUser    as BridgeStateShape['currentUser'];
  if (w.currentServer)  _state.currentServer  = w.currentServer  as BridgeStateShape['currentServer'];
  if (w.currentChannel) _state.currentChannel = w.currentChannel as BridgeStateShape['currentChannel'];
}

export const BridgeState = { state, setState, subscribe, initState };

// Convenience re-export — settingsStore ve Svelte bileşenleri için
export { getMe as getCurrentUser } from './globals.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initState, { once: true });
} else {
  initState();
}
