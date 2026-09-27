// client/js/core/server-menu-svelte.ts
// UX/P1 — Sunucu menüsü mount köprüsü.
//
// KANONİK BİÇİM: `invite-svelte.ts` / `search-svelte.ts` ile aynı sözleşme —
// `unmount()` GERÇEKTEN çağrılır (referansı null'lamak `onDestroy`u çalıştırmaz
// ve kayıtlar ölü bileşene işaret etmeye devam ederdi).
import { mount, unmount } from 'svelte';
import ServerMenu from './ServerMenu.svelte';

let _instance: ReturnType<typeof mount> | null = null;

export function mountServerMenu(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('server-menu-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'server-menu-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ServerMenu, { target: el, props: {} });
}

export function unmountServerMenu(): void {
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerMenu(), { once: true });
} else {
  mountServerMenu();
}
