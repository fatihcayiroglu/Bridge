// client/js/core/messages-reactions-svelte.ts
// Sprint 116 — ReactionPicker mount shim (ADR-0008 Faz 3)
// Emoji reaksiyon seçici ve sayaç
import { mount } from 'svelte';
import ReactionPicker from './ReactionPicker.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ReactionPickerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountReactionPicker(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('messages-reactions-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-reactions-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ReactionPicker, { target: el, props: {} });
  log.info('ReactionPicker mounted via shim');
}

export function unmountReactionPicker(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountReactionPicker(), { once: true });
} else {
  mountReactionPicker();
}
document.addEventListener('bridge:socket-ready', () => mountReactionPicker(), { once: true });
