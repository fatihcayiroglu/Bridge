// client/js/core/api-error-toast-svelte.ts
// Sprint 116 — ApiErrorToast mount shim (ADR-0008 Faz 3)
// API hata bildirim toast bileşeni
import { mount } from 'svelte';
import ApiErrorToast from './ApiErrorToast.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ApiErrorToastShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountApiErrorToast(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('api-error-toast-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'api-error-toast-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ApiErrorToast, { target: el, props: {} });
  log.info('ApiErrorToast mounted via shim');
}

export function unmountApiErrorToast(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountApiErrorToast(), { once: true });
} else {
  mountApiErrorToast();
}
document.addEventListener('bridge:socket-ready', () => mountApiErrorToast(), { once: true });
