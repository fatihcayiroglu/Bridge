// client/js/core/drafts-svelte.ts
// Sprint 116 — DraftManager mount shim (ADR-0008 Faz 3)
// Faz 8.2: bu shim hiçbir yerden import edilmiyordu; app.ts artık import ediyor.
import { mount, unmount } from 'svelte';
import DraftManager from './DraftManager.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('DraftManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDraftManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('drafts-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'drafts-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DraftManager, { target: el, props: {} });
  log.info('DraftManager mounted via shim');
}

export function unmountDraftManager(): void {
  // Faz 8.2: önceden yalnızca referans null'lanıyordu — bileşen ve bekleyen
  // zamanlayıcıları yaşamaya devam ediyordu (sızıntı). Gerçekten unmount
  // edilir; DraftManager onDestroy içinde bekleyen taslağı diske indirir.
  if (!_instance) return;
  const inst = _instance;
  _instance = null;
  void unmount(inst);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDraftManager(), { once: true });
} else {
  mountDraftManager();
}
// `_instance` guard'ı sayesinde ikinci çağrı yeni örnek üretmez (çift yönetici
// aynı taslağı iki kez yazıp birbirini ezerdi).
document.addEventListener('bridge:socket-ready', () => mountDraftManager(), { once: true });
