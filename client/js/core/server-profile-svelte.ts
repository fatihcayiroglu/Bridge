// client/js/core/server-profile-svelte.ts
// Sprint 116 — ServerProfilePanel mount shim (ADR-0008 Faz 3)
// Sunucu profil ve hakkında paneli
import { mount } from 'svelte';
import ServerProfilePanel from './ServerProfilePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ServerProfilePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountServerProfilePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('server-profile-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'server-profile-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ServerProfilePanel, { target: el, props: {} });
  log.info('ServerProfilePanel mounted via shim');
}

export function unmountServerProfilePanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerProfilePanel(), { once: true });
} else {
  mountServerProfilePanel();
}
document.addEventListener('bridge:socket-ready', () => mountServerProfilePanel(), { once: true });
