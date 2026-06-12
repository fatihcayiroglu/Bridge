// client/js/core/automod-svelte.ts
// Sprint 116 — AutomodPanel mount shim (ADR-0008 Faz 3)
// Otomatik moderasyon kural yönetimi
import { mount } from 'svelte';
import AutomodPanel from './AutomodPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AutomodPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAutomodPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('automod-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'automod-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AutomodPanel, { target: el, props: {} });
  log.info('AutomodPanel mounted via shim');
}

export function unmountAutomodPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAutomodPanel(), { once: true });
} else {
  mountAutomodPanel();
}
document.addEventListener('bridge:socket-ready', () => mountAutomodPanel(), { once: true });
