// client/js/core/api-error-toast-svelte.ts
// Sprint 116 — ApiErrorToast mount shim (ADR-0008 Faz 3)
// API hata bildirim toast bileşeni
import { mount, unmount } from 'svelte';
import ApiErrorToast from './ApiErrorToast.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('ApiErrorToastShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountApiErrorToast(target?: HTMLElement): void {
  if (_instance) return;
  // Faz 8: mevcut kabuk kullanılır — index.html:668 `<div id="toast-container">`
  // (CSS konumlandırması css/modules/modals.css içindedir). Kabuk yoksa
  // eski davranışa düşülür.
  const el = target
    ?? document.getElementById('toast-container')
    ?? document.getElementById('api-error-toast-root')
    ?? (() => {
      const div = document.createElement('div');
      div.id = 'api-error-toast-root';
      div.className = 'toast-container';
      document.body.appendChild(div);
      return div;
    })();
  _instance = mount(ApiErrorToast, { target: el, props: {} });
  log.info('ApiErrorToast mounted via shim');
}

export function unmountApiErrorToast(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountApiErrorToast(), { once: true });
} else {
  mountApiErrorToast();
}
document.addEventListener('bridge:socket-ready', () => mountApiErrorToast(), { once: true });
