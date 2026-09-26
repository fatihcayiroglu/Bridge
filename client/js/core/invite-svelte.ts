// client/js/core/invite-svelte.ts
// UX/P0 — Davet paneli mount köprüsü.
//
// KANONİK BİÇİM: `group-dm-svelte.ts` / `search-svelte.ts` ile aynı sözleşme —
// `unmount()` GERÇEKTEN çağrılır (yalnızca referans null'lamak `onDestroy`u
// çalıştırmaz ve kayıtlar ölü bileşene işaret etmeye devam ederdi).
import { mount, unmount } from 'svelte';
import InvitePanel from './InvitePanel.svelte';

let _instance: ReturnType<typeof mount> | null = null;

export function mountInvitePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('invite-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'invite-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(InvitePanel, { target: el, props: {} });
}

export function unmountInvitePanel(): void {
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountInvitePanel(), { once: true });
} else {
  mountInvitePanel();
}
