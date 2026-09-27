// client/js/core/member-profile-svelte.ts
// UX/P1 — Üye profili popover mount köprüsü.
// Kanonik biçim: `unmount()` GERÇEKTEN çağrılır (referans null'lamak onDestroy'u
// çalıştırmaz ve kayıtlar ölü bileşene işaret etmeye devam ederdi).
import { mount, unmount } from 'svelte';
import MemberProfilePopover from './MemberProfilePopover.svelte';

let _instance: ReturnType<typeof mount> | null = null;

export function mountMemberProfile(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('member-profile-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'member-profile-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MemberProfilePopover, { target: el, props: {} });
}

export function unmountMemberProfile(): void {
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMemberProfile(), { once: true });
} else {
  mountMemberProfile();
}
