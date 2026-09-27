// client/js/core/state-svelte.ts
// Sprint 116 — AppState mount shim (ADR-0008 Faz 3)
// Global uygulama durumu yöneticisi
import { mount, unmount } from 'svelte';
import AppState from './AppState.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('AppStateShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAppState(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('state-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'state-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AppState, { target: el, props: {} });
  log.info('AppState mounted via shim');
}

export function unmountAppState(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAppState(), { once: true });
} else {
  mountAppState();
}
document.addEventListener('bridge:socket-ready', () => mountAppState(), { once: true });

// Legacy compatibility export used by app.ts.
export const BridgeState = {
  initState(): void {
    mountAppState();
  },
};
