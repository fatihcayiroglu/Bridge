// client/js/core/go-live-svelte.ts
// Sprint 116 — GoLivePanel mount shim (ADR-0008 Faz 3)
// Go Live / Ekran paylaşımı yayın paneli
import { mount } from 'svelte';
import GoLivePanel from './GoLivePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('GoLivePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountGoLivePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('go-live-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'go-live-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(GoLivePanel, { target: el, props: {} });
  log.info('GoLivePanel mounted via shim');
}

export function unmountGoLivePanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountGoLivePanel(), { once: true });
} else {
  mountGoLivePanel();
}
document.addEventListener('bridge:socket-ready', () => mountGoLivePanel(), { once: true });
