// client/js/core/messages-input-svelte.ts
// Sprint 116 — MessageInputPanel mount shim (ADR-0008 Faz 3)
// Mesaj girişi, emoji, upload, slash komutları
import { mount, unmount } from 'svelte';
import MessageInputPanel from './MessageInputPanel.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('MessageInputPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMessageInputPanel(target?: HTMLElement): void {
  if (_instance) return;
  // Faz 4: bağlam şeridi (yanıtla/düzenle) composer'ın hemen üstünde görünmeli.
  const el = target ?? document.getElementById('messages-input-root') ?? (() => {
    const wrap = document.getElementById('msg-input-wrap');
    if (wrap?.parentElement) {
      const holder = document.createElement('div');
      holder.id = 'messages-input-root';
      wrap.parentElement.insertBefore(holder, wrap);
      return holder;
    }
    return null;
  })() ?? (() => {
    const div = document.createElement('div');
    div.id = 'messages-input-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MessageInputPanel, { target: el, props: {} });
  log.info('MessageInputPanel mounted via shim');
}

export function unmountMessageInputPanel(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMessageInputPanel(), { once: true });
} else {
  mountMessageInputPanel();
}
document.addEventListener('bridge:socket-ready', () => mountMessageInputPanel(), { once: true });
