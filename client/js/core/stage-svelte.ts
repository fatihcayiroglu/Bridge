// client/js/core/stage-svelte.ts
// Sprint 116 — StagePanel mount shim (ADR-0008 Faz 3)
// Stage kanal paneli
import { mount } from 'svelte';
import StagePanel from './StagePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('StagePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountStagePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('stage-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'stage-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(StagePanel, { target: el, props: {} });
  log.info('StagePanel mounted via shim');
}

export function unmountStagePanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountStagePanel(), { once: true });
} else {
  mountStagePanel();
}
document.addEventListener('bridge:socket-ready', () => mountStagePanel(), { once: true });
