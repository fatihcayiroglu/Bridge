// client/js/core/translate-btn-svelte.ts
// Sprint 116 — TranslateButton mount shim (ADR-0008 Faz 3)
// Mesaj çeviri butonu
import { mount } from 'svelte';
import TranslateButton from './TranslateButton.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('TranslateButtonShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountTranslateButton(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('translate-btn-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'translate-btn-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(TranslateButton, { target: el, props: { messageId: '', content: '' } });
  log.info('TranslateButton mounted via shim');
}

export function unmountTranslateButton(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountTranslateButton(), { once: true });
} else {
  mountTranslateButton();
}
document.addEventListener('bridge:socket-ready', () => mountTranslateButton(), { once: true });
