// client/js/core/notification-prefs-svelte.ts
// Sprint 116 — NotificationPrefsPanel mount shim (ADR-0008 Faz 3)
// Bildirim tercih yöneticisi
import { mount } from 'svelte';
import NotificationPrefsPanel from './NotificationPrefsPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('NotificationPrefsPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountNotificationPrefsPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('notification-prefs-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'notification-prefs-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(NotificationPrefsPanel, { target: el, props: {} });
  log.info('NotificationPrefsPanel mounted via shim');
}

export function unmountNotificationPrefsPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountNotificationPrefsPanel(), { once: true });
} else {
  mountNotificationPrefsPanel();
}
document.addEventListener('bridge:socket-ready', () => mountNotificationPrefsPanel(), { once: true });
