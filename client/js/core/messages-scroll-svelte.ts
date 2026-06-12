// client/js/core/messages-scroll-svelte.ts
// Sprint 116 — MessageScroll mount shim (ADR-0008 Faz 3)
// Mesaj listesi scroll yönetimi
import { mount } from 'svelte';
import MessageScroll from './MessageScroll.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MessageScrollShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMessageScroll(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('messages-scroll-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-scroll-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MessageScroll, { target: el, props: {} });
  log.info('MessageScroll mounted via shim');
}

export function unmountMessageScroll(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMessageScroll(), { once: true });
} else {
  mountMessageScroll();
}
document.addEventListener('bridge:socket-ready', () => mountMessageScroll(), { once: true });
