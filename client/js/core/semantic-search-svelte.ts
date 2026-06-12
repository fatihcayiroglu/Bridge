// client/js/core/semantic-search-svelte.ts
// Sprint 116 — SemanticSearchPanel mount shim (ADR-0008 Faz 3)
// pgvector semantik arama paneli
import { mount } from 'svelte';
import SemanticSearchPanel from './SemanticSearchPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SemanticSearchPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSemanticSearchPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('semantic-search-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'semantic-search-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SemanticSearchPanel, { target: el, props: {} });
  log.info('SemanticSearchPanel mounted via shim');
}

export function unmountSemanticSearchPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSemanticSearchPanel(), { once: true });
} else {
  mountSemanticSearchPanel();
}
document.addEventListener('bridge:socket-ready', () => mountSemanticSearchPanel(), { once: true });
