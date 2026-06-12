// client/js/core/activities-svelte.ts
// Sprint 116 — ActivitiesPanel mount shim (ADR-0008 Faz 3)
// Uygulama aktiviteleri paneli
import { mount } from 'svelte';
import ActivitiesPanel from './ActivitiesPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ActivitiesPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountActivitiesPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('activities-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'activities-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ActivitiesPanel, { target: el, props: {} });
  log.info('ActivitiesPanel mounted via shim');
}

export function unmountActivitiesPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountActivitiesPanel(), { once: true });
} else {
  mountActivitiesPanel();
}
document.addEventListener('bridge:socket-ready', () => mountActivitiesPanel(), { once: true });
