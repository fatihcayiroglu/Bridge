// client/js/core/moderation-svelte.ts
// Sprint 116 — ModerationPanel mount shim (ADR-0008 Faz 3)
// Moderasyon araçları - ban, kick, timeout
import { mount } from 'svelte';
import ModerationPanel from './ModerationPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ModerationPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountModerationPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('moderation-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'moderation-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ModerationPanel, { target: el, props: {} });
  log.info('ModerationPanel mounted via shim');
}

export function unmountModerationPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountModerationPanel(), { once: true });
} else {
  mountModerationPanel();
}
document.addEventListener('bridge:socket-ready', () => mountModerationPanel(), { once: true });
