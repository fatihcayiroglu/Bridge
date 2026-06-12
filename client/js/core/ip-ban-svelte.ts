// client/js/core/ip-ban-svelte.ts
// Sprint 116 — IpBanPanel mount shim (ADR-0008 Faz 3)
// IP ban yönetim paneli
import { mount } from 'svelte';
import IpBanPanel from './IpBanPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('IpBanPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountIpBanPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('ip-ban-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'ip-ban-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(IpBanPanel, { target: el, props: {} });
  log.info('IpBanPanel mounted via shim');
}

export function unmountIpBanPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountIpBanPanel(), { once: true });
} else {
  mountIpBanPanel();
}
document.addEventListener('bridge:socket-ready', () => mountIpBanPanel(), { once: true });
