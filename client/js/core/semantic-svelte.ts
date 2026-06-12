// client/js/core/semantic-svelte.ts
// Sprint 116 — SemanticPanel mount shim (ADR-0008 Faz 3)
// Anlamsal arama UI bileşeni
import { mount } from 'svelte';
import SemanticPanel from './SemanticPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SemanticPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSemanticPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('semantic-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'semantic-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SemanticPanel, { target: el, props: {} });
  log.info('SemanticPanel mounted via shim');
}

export function unmountSemanticPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSemanticPanel(), { once: true });
} else {
  mountSemanticPanel();
}
document.addEventListener('bridge:socket-ready', () => mountSemanticPanel(), { once: true });
