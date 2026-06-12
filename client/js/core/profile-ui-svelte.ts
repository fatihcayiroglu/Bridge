// client/js/core/profile-ui-svelte.ts
// Sprint 116 — ProfilePopup mount shim (ADR-0008 Faz 3)
// Kullanıcı profil popup/modal
import { mount } from 'svelte';
import ProfilePopup from './ProfilePopup.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ProfilePopupShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountProfilePopup(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('profile-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'profile-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ProfilePopup, { target: el, props: {} });
  log.info('ProfilePopup mounted via shim');
}

export function unmountProfilePopup(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountProfilePopup(), { once: true });
} else {
  mountProfilePopup();
}
document.addEventListener('bridge:socket-ready', () => mountProfilePopup(), { once: true });
