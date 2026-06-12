// client/js/core/mobile-ux-svelte.ts
// Sprint 116 — MobileUXManager mount shim (ADR-0008 Faz 3)
// Mobil UX iyileştirmeleri yöneticisi
import { mount } from 'svelte';
import MobileUXManager from './MobileUXManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MobileUXManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMobileUXManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('mobile-ux-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'mobile-ux-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MobileUXManager, { target: el, props: {} });
  log.info('MobileUXManager mounted via shim');
}

export function unmountMobileUXManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMobileUXManager(), { once: true });
} else {
  mountMobileUXManager();
}
document.addEventListener('bridge:socket-ready', () => mountMobileUXManager(), { once: true });

// Legacy compatibility export used by app.ts.
export function onNativePushLogin(): void {
  mountMobileUXManager();
}
