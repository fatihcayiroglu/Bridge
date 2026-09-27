// client/js/core/create-channel-svelte.ts
// UX/P0 — Kanal oluşturma paneli mount köprüsü.
//
// KANONİK BİÇİM: `invite-svelte.ts` ile aynı sözleşme — `unmount()` GERÇEKTEN
// çağrılır, böylece `onDestroy` çalışır ve kayıtlar bırakılır.
import { mount, unmount } from 'svelte';
import CreateChannelPanel from './CreateChannelPanel.svelte';

let _instance: ReturnType<typeof mount> | null = null;

export function mountCreateChannel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('create-channel-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'create-channel-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(CreateChannelPanel, { target: el, props: {} });
}

export function unmountCreateChannel(): void {
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountCreateChannel(), { once: true });
} else {
  mountCreateChannel();
}
