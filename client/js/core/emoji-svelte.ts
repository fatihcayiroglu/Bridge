// client/js/core/emoji-svelte.ts
// Sprint 116 — EmojiRenderer mount shim (ADR-0008 Faz 3)
// Emoji render ve özel emoji desteği
import { mount } from 'svelte';
import EmojiRenderer from './EmojiRenderer.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('EmojiRendererShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountEmojiRenderer(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('emoji-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'emoji-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(EmojiRenderer, { target: el, props: {} });
  log.info('EmojiRenderer mounted via shim');
}

export function unmountEmojiRenderer(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountEmojiRenderer(), { once: true });
} else {
  mountEmojiRenderer();
}
document.addEventListener('bridge:socket-ready', () => mountEmojiRenderer(), { once: true });
