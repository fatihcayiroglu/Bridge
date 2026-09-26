// client/js/core/messages-svelte.ts
// Sprint 116 — MessageListPanel mount shim (ADR-0008 Faz 3)
// Ana mesaj liste paneli
import { mount, unmount } from 'svelte';
import MessageListPanel from './MessageListPanel.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('MessageListPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMessageListPanel(target?: HTMLElement): void {
  if (_instance) return;
  // Faz 4: mevcut kabuk #messages-area (index.html:213) mount noktasıdır.
  const el = target ?? document.getElementById('messages-root') ?? document.getElementById('messages-area') ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MessageListPanel, { target: el, props: {} });
  log.info('MessageListPanel mounted via shim');
}

export function unmountMessageListPanel(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMessageListPanel(), { once: true });
} else {
  mountMessageListPanel();
}
document.addEventListener('bridge:socket-ready', () => mountMessageListPanel(), { once: true });
