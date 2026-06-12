// client/js/core/messages-renderer-svelte.ts
// Sprint 116 — MessageRenderer mount shim (ADR-0008 Faz 3)
// Mesaj render, markdown, embed, kod blokları
import { mount } from 'svelte';
import MessageRenderer from './MessageRenderer.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MessageRendererShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMessageRenderer(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('messages-renderer-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-renderer-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MessageRenderer, { target: el, props: {} });
  log.info('MessageRenderer mounted via shim');
}

export function unmountMessageRenderer(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMessageRenderer(), { once: true });
} else {
  mountMessageRenderer();
}
document.addEventListener('bridge:socket-ready', () => mountMessageRenderer(), { once: true });
