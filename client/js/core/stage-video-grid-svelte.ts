// client/js/core/stage-video-grid-svelte.ts
// Sprint 116 — StageVideoGrid mount shim (ADR-0008 Faz 3)
// Stage kanal video grid layout
import { mount } from 'svelte';
import StageVideoGrid from './StageVideoGrid.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('StageVideoGridShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountStageVideoGrid(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('stage-video-grid-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'stage-video-grid-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(StageVideoGrid, { target: el, props: {} });
  log.info('StageVideoGrid mounted via shim');
}

export function unmountStageVideoGrid(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountStageVideoGrid(), { once: true });
} else {
  mountStageVideoGrid();
}
document.addEventListener('bridge:socket-ready', () => mountStageVideoGrid(), { once: true });

// Legacy compatibility export used by app.ts.
export function initStageVideoGrid(): void {
  mountStageVideoGrid();
}
