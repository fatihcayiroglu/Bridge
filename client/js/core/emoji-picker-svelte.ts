// client/js/core/emoji-picker-svelte.ts
// Sprint 116 — EmojiPickerPanel mount shim (ADR-0008 Faz 3)
// Emoji seçici popup paneli
import { mount } from 'svelte';
import EmojiPickerPanel from './EmojiPickerPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('EmojiPickerPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountEmojiPickerPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('emoji-picker-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'emoji-picker-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(EmojiPickerPanel, { target: el, props: {} });
  log.info('EmojiPickerPanel mounted via shim');
}

export function unmountEmojiPickerPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountEmojiPickerPanel(), { once: true });
} else {
  mountEmojiPickerPanel();
}
document.addEventListener('bridge:socket-ready', () => mountEmojiPickerPanel(), { once: true });
