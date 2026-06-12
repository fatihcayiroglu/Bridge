// client/js/core/auth-revoked-svelte.ts
// Sprint 116 — AuthRevokedNotice mount shim (ADR-0008 Faz 3)
// Oturum iptali bildirimi
import { mount } from 'svelte';
import AuthRevokedNotice from './AuthRevokedNotice.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AuthRevokedNoticeShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAuthRevokedNotice(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('auth-revoked-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'auth-revoked-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AuthRevokedNotice, { target: el, props: {} });
  log.info('AuthRevokedNotice mounted via shim');
}

export function unmountAuthRevokedNotice(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAuthRevokedNotice(), { once: true });
} else {
  mountAuthRevokedNotice();
}
document.addEventListener('bridge:socket-ready', () => mountAuthRevokedNotice(), { once: true });
