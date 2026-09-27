// client/js/core/messages-loader-svelte.ts
// Sprint 116 — MessageLoader mount shim (ADR-0008 Faz 3)
// Mesaj yükleme, cursor tabanlı sayfalama
import { mount, unmount } from 'svelte';
import MessageLoader from './MessageLoader.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('MessageLoaderShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMessageLoader(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('messages-loader-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-loader-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MessageLoader, { target: el, props: {} });
  log.info('MessageLoader mounted via shim');
}

export function unmountMessageLoader(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMessageLoader(), { once: true });
} else {
  mountMessageLoader();
}
document.addEventListener('bridge:socket-ready', () => mountMessageLoader(), { once: true });
