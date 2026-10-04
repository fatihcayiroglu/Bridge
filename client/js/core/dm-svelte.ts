// client/js/core/dm-svelte.ts
// Sprint 116 — DmPanel mount shim (ADR-0008 Faz 3)
// Direkt mesaj paneli
import { mount, unmount } from 'svelte';
import DmPanel from './DmPanel.svelte';
import { createLogger } from './logger.ts';
import { BridgeRegistry } from './bridge-registry.ts';
import { mountRemoteDmPanel, unmountRemoteDmPanel } from './remote-dm-svelte.ts';
import { t } from './i18n/index.ts';
const log = createLogger('DmPanelShim');

let _instance: ReturnType<typeof mount> | null = null;
let _observer: MutationObserver | null = null;

function ensureRemoteDmEntry(root: HTMLElement): void {
  const heading = root.querySelector<HTMLElement>('.dm-heading');
  if (!heading || heading.querySelector('.dm-remote-entry')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dm-remote-entry';
  button.textContent = t('remote_dm_entry', 'Federated');
  button.setAttribute('aria-label', t('remote_dm_open', 'Federated direkt mesajları aç'));
  // `.dm-heading button` existing close style is intentionally large. Keep the
  // P6 entry compact without changing the canonical DmPanel stylesheet.
  button.style.fontSize = '12px';
  button.style.fontWeight = '600';
  button.style.padding = '6px 8px';
  button.style.border = '1px solid var(--border-subtle)';
  button.style.borderRadius = 'var(--radius-control)';
  button.style.background = 'var(--surface-1)';
  button.addEventListener('click', () => {
    BridgeRegistry.call('closeDmPanel');
    BridgeRegistry.call('showRemoteDmPanel');
  });

  // Append rather than prepend: existing e2e intentionally clicks the FIRST
  // heading button as the DM close control.
  heading.appendChild(button);
}

function watchRemoteDmEntry(root: HTMLElement): void {
  _observer?.disconnect();
  ensureRemoteDmEntry(root);
  _observer = new MutationObserver(() => ensureRemoteDmEntry(root));
  _observer.observe(root, { childList: true, subtree: true });
}

export function mountDmPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('dm-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'dm-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DmPanel, { target: el, props: {} });
  mountRemoteDmPanel();
  watchRemoteDmEntry(el);
  log.info('DmPanel mounted via shim');
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
  _observer?.disconnect();
  _observer = null;
  unmountRemoteDmPanel();
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDmPanel(), { once: true });
} else {
  mountDmPanel();
}
document.addEventListener('bridge:socket-ready', () => mountDmPanel(), { once: true });