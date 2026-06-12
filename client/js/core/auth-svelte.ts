// client/js/core/auth-svelte.ts
// Sprint 116 — AuthManager mount shim (ADR-0008 Faz 3)
// Kimlik doğrulama akışı yöneticisi
import { mount } from 'svelte';
import AuthManager from './AuthManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AuthManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAuthManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('auth-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'auth-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AuthManager, { target: el, props: {} });
  log.info('AuthManager mounted via shim');
}

export function unmountAuthManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAuthManager(), { once: true });
} else {
  mountAuthManager();
}
document.addEventListener('bridge:socket-ready', () => mountAuthManager(), { once: true });
