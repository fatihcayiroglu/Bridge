// client/js/core/announcement-ui-svelte.ts
// Sprint 116 — AnnouncementPanel mount shim (ADR-0008 Faz 3)
// Duyuru kanalı UI paneli
import { mount } from 'svelte';
import AnnouncementPanel from './AnnouncementPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AnnouncementPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAnnouncementPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('announcement-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'announcement-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AnnouncementPanel, { target: el, props: {} });
  log.info('AnnouncementPanel mounted via shim');
}

export function unmountAnnouncementPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAnnouncementPanel(), { once: true });
} else {
  mountAnnouncementPanel();
}
document.addEventListener('bridge:socket-ready', () => mountAnnouncementPanel(), { once: true });
