// client/js/core/dm-svelte.ts
// Sprint 116 — DmPanel mount shim (ADR-0008 Faz 3)
// Direkt mesaj paneli + P6 ActivityPub remote DM surface.
import { mount, unmount } from 'svelte';
import DmPanel from './DmPanel.svelte';
import RemoteDmPanel from './RemoteDmPanel.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('DmPanelShim');

let _instance: ReturnType<typeof mount> | null = null;
let _remoteInstance: ReturnType<typeof mount> | null = null;

export function mountDmPanel(target?: HTMLElement): void {
  if (_instance && _remoteInstance) return;
  const el = target ?? document.getElementById('dm-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'dm-root';
    document.body.appendChild(div);
    return div;
  })();
  if (!_instance) _instance = mount(DmPanel, { target: el, props: {} });
  if (!_remoteInstance) _remoteInstance = mount(RemoteDmPanel, { target: el, props: {} });
  log.info('DM surfaces mounted via shim');
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
export function unmountDmPanel(): void {
  if (_remoteInstance) {
    void unmount(_remoteInstance);
    _remoteInstance = null;
  }
  if (_instance) {
    void unmount(_instance);
    _instance = null;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDmPanel(), { once: true });
} else {
  mountDmPanel();
}
document.addEventListener('bridge:socket-ready', () => mountDmPanel(), { once: true });
