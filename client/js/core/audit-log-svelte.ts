// client/js/core/audit-log-svelte.ts
// Sprint 116 — AuditLogPanel mount shim (ADR-0008 Faz 3)
// Sunucu denetim günlüğü paneli
import { mount } from 'svelte';
import AuditLogPanel from './AuditLogPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AuditLogPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAuditLogPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('audit-log-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'audit-log-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AuditLogPanel, { target: el, props: {} });
  log.info('AuditLogPanel mounted via shim');
}

export function unmountAuditLogPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAuditLogPanel(), { once: true });
} else {
  mountAuditLogPanel();
}
document.addEventListener('bridge:socket-ready', () => mountAuditLogPanel(), { once: true });
