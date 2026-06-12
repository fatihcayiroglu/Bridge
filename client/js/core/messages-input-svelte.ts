// client/js/core/messages-input-svelte.ts
// Sprint 116 — MessageInputPanel mount shim (ADR-0008 Faz 3)
// Mesaj girişi, emoji, upload, slash komutları
import { mount } from 'svelte';
import MessageInputPanel from './MessageInputPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MessageInputPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMessageInputPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('messages-input-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-input-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MessageInputPanel, { target: el, props: {} });
  log.info('MessageInputPanel mounted via shim');
}

export function unmountMessageInputPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMessageInputPanel(), { once: true });
} else {
  mountMessageInputPanel();
}
document.addEventListener('bridge:socket-ready', () => mountMessageInputPanel(), { once: true });
