// client/js/core/server-events-svelte.ts
// Sprint 116 — ServerEventsPanel mount shim (ADR-0008 Faz 3)
// Sunucu etkinlik yönetimi paneli
import { mount } from 'svelte';
import ServerEventsPanel from './ServerEventsPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ServerEventsPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountServerEventsPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('server-events-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'server-events-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ServerEventsPanel, { target: el, props: {} });
  log.info('ServerEventsPanel mounted via shim');
}

export function unmountServerEventsPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerEventsPanel(), { once: true });
} else {
  mountServerEventsPanel();
}
document.addEventListener('bridge:socket-ready', () => mountServerEventsPanel(), { once: true });
