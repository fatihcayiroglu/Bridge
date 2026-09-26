// client/js/core/pinned-messages-svelte.ts
// PinnedMessagesPanel mount shim — global-search-svelte.ts ile AYNI kanonik
// biçim: kendi kökünü oluşturur, `unmount()` GERÇEKTEN çağrılır (yoksa
// `onDestroy` çalışmaz ve `openPinnedMessages` kaydı ölü bir bileşene işaret
// ederdi).
import { mount, unmount } from 'svelte';
import PinnedMessagesPanel from './PinnedMessagesPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountPinnedMessages(target?: HTMLElement): void {
  if (instance) return;
  const el = target ?? document.getElementById('pinned-messages-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'pinned-messages-root';
    document.body.appendChild(div);
    return div;
  })();
  instance = mount(PinnedMessagesPanel, { target: el, props: {} });
}

export function unmountPinnedMessages(): void {
  if (!instance) return;
  void unmount(instance);
  instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountPinnedMessages(), { once: true });
} else {
  mountPinnedMessages();
}
