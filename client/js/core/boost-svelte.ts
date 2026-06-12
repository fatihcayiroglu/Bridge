// client/js/core/boost-svelte.ts
// Sprint 116 — BoostPanel mount shim (ADR-0008 Faz 3)
// Sunucu boost yönetim paneli
import { mount } from 'svelte';
import BoostPanel from './BoostPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('BoostPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountBoostPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('boost-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'boost-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(BoostPanel, { target: el, props: {} });
  log.info('BoostPanel mounted via shim');
}

export function unmountBoostPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountBoostPanel(), { once: true });
} else {
  mountBoostPanel();
}
document.addEventListener('bridge:socket-ready', () => mountBoostPanel(), { once: true });

export function applyBoostFeatures(): void {
  mountBoostPanel();
}
