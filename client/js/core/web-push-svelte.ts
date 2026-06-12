// client/js/core/web-push-svelte.ts
// Sprint 116 — WebPushManager mount shim (ADR-0008 Faz 3)
// Web Push bildirim yöneticisi
import { mount } from 'svelte';
import WebPushManager from './WebPushManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('WebPushManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountWebPushManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('web-push-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'web-push-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(WebPushManager, { target: el, props: {} });
  log.info('WebPushManager mounted via shim');
}

export function unmountWebPushManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountWebPushManager(), { once: true });
} else {
  mountWebPushManager();
}
document.addEventListener('bridge:socket-ready', () => mountWebPushManager(), { once: true });
