// client/js/core/activity-svelte.ts
// Sprint 116 — ActivityPanel mount shim (ADR-0008 Faz 3)
// Kullanıcı aktivite gösterimi
import { mount } from 'svelte';
import ActivityPanel from './ActivityPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ActivityPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountActivityPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('activity-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'activity-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ActivityPanel, { target: el, props: {} });
  log.info('ActivityPanel mounted via shim');
}

export function unmountActivityPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountActivityPanel(), { once: true });
} else {
  mountActivityPanel();
}
document.addEventListener('bridge:socket-ready', () => mountActivityPanel(), { once: true });
