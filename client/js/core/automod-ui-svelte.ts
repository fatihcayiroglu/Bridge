// client/js/core/automod-ui-svelte.ts
// Sprint 116 — AutomodUIPanel mount shim (ADR-0008 Faz 3)
// Otomatik moderasyon arayüz bileşeni
import { mount } from 'svelte';
import AutomodUIPanel from './AutomodUIPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AutomodUIPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAutomodUIPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('automod-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'automod-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AutomodUIPanel, { target: el, props: {} });
  log.info('AutomodUIPanel mounted via shim');
}

export function unmountAutomodUIPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAutomodUIPanel(), { once: true });
} else {
  mountAutomodUIPanel();
}
document.addEventListener('bridge:socket-ready', () => mountAutomodUIPanel(), { once: true });
