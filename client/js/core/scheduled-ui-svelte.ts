// client/js/core/scheduled-ui-svelte.ts
// Sprint 116 — ScheduledEventsPanel mount shim (ADR-0008 Faz 3)
// Planlanmış etkinlikler paneli
import { mount } from 'svelte';
import ScheduledEventsPanel from './ScheduledEventsPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ScheduledEventsPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountScheduledEventsPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('scheduled-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'scheduled-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ScheduledEventsPanel, { target: el, props: {} });
  log.info('ScheduledEventsPanel mounted via shim');
}

export function unmountScheduledEventsPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountScheduledEventsPanel(), { once: true });
} else {
  mountScheduledEventsPanel();
}
document.addEventListener('bridge:socket-ready', () => mountScheduledEventsPanel(), { once: true });
