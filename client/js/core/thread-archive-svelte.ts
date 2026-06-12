// client/js/core/thread-archive-svelte.ts
// Sprint 116 — ThreadArchivePanel mount shim (ADR-0008 Faz 3)
// Thread arşiv ve liste paneli
import { mount } from 'svelte';
import ThreadArchivePanel from './ThreadArchivePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ThreadArchivePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountThreadArchivePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('thread-archive-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'thread-archive-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ThreadArchivePanel, { target: el, props: {} });
  log.info('ThreadArchivePanel mounted via shim');
}

export function unmountThreadArchivePanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountThreadArchivePanel(), { once: true });
} else {
  mountThreadArchivePanel();
}
document.addEventListener('bridge:socket-ready', () => mountThreadArchivePanel(), { once: true });
