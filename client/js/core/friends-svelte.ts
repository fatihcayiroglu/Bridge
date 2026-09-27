// client/js/core/friends-svelte.ts
// Sprint 116 — FriendsPanel mount shim (ADR-0008 Faz 3)
// Arkadaş listesi ve istek yönetimi
import { mount, unmount } from 'svelte';
import FriendsPanel from './FriendsPanel.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('FriendsPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountFriendsPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('friends-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'friends-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(FriendsPanel, { target: el, props: {} });
  log.info('FriendsPanel mounted via shim');
}

/**
 * FAZ E — GERCEK SOKME.
 *
 * Onceki govde YALNIZCA `_instance = null` yaziyordu; Svelte'in
 * `unmount()`u HIC cagrilmiyordu. Sonuc: bilesen DOM'da ve bellekte
 * yasamaya devam ediyor, `onDestroy` hic calismiyordu — yani socket
 * dinleyicileri, `window` keydown isleyicileri, BridgeRegistry kayitlari
 * ve odak tuzagi TEMIZLENMIYORDU. Ayrica `_instance` null'landigi icin
 * sonraki `mount` IKINCI bir ornek yaratabilir (cift sahip riski).
 *
 * Kanonik bicim `group-dm-svelte.ts` ve `settings-modal-svelte.ts`
 * icinde zaten mevcuttu; bu dosya onlarla hizalandi.
 */
export function unmountFriendsPanel(): void {
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountFriendsPanel(), { once: true });
} else {
  mountFriendsPanel();
}
document.addEventListener('bridge:socket-ready', () => mountFriendsPanel(), { once: true });
