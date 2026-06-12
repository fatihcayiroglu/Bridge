// client/js/core/advanced-search-svelte.ts
// Sprint 116 — AdvancedSearchPanel mount shim (ADR-0008 Faz 3)
// Gelişmiş arama filtre paneli
import { mount } from 'svelte';
import AdvancedSearchPanel from './AdvancedSearchPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AdvancedSearchPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAdvancedSearchPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('advanced-search-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'advanced-search-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AdvancedSearchPanel, { target: el, props: {} });
  log.info('AdvancedSearchPanel mounted via shim');
}

export function unmountAdvancedSearchPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAdvancedSearchPanel(), { once: true });
} else {
  mountAdvancedSearchPanel();
}
document.addEventListener('bridge:socket-ready', () => mountAdvancedSearchPanel(), { once: true });
