// client/js/core/clips-svelte.ts
// Sprint 116 — ClipsPanel mount shim (ADR-0008 Faz 3)
// Video klip kayıt ve paylaşım paneli
import { mount } from 'svelte';
import ClipsPanel from './ClipsPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ClipsPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountClipsPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('clips-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'clips-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ClipsPanel, { target: el, props: {} });
  log.info('ClipsPanel mounted via shim');
}

export function unmountClipsPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountClipsPanel(), { once: true });
} else {
  mountClipsPanel();
}
document.addEventListener('bridge:socket-ready', () => mountClipsPanel(), { once: true });
