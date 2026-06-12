// client/js/core/messages-embeds-svelte.ts
// Sprint 116 — EmbedRenderer mount shim (ADR-0008 Faz 3)
// URL embed önizleme
import { mount } from 'svelte';
import EmbedRenderer from './EmbedRenderer.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('EmbedRendererShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountEmbedRenderer(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('messages-embeds-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-embeds-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(EmbedRenderer, { target: el, props: {} });
  log.info('EmbedRenderer mounted via shim');
}

export function unmountEmbedRenderer(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountEmbedRenderer(), { once: true });
} else {
  mountEmbedRenderer();
}
document.addEventListener('bridge:socket-ready', () => mountEmbedRenderer(), { once: true });
