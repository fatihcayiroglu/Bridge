// client/js/core/outgoing-webhooks-svelte.ts
// Sprint 116 — OutgoingWebhooksPanel mount shim (ADR-0008 Faz 3)
// Giden webhook yönetim paneli
import { mount } from 'svelte';
import OutgoingWebhooksPanel from './OutgoingWebhooksPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('OutgoingWebhooksPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountOutgoingWebhooksPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('outgoing-webhooks-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'outgoing-webhooks-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(OutgoingWebhooksPanel, { target: el, props: {} });
  log.info('OutgoingWebhooksPanel mounted via shim');
}

export function unmountOutgoingWebhooksPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountOutgoingWebhooksPanel(), { once: true });
} else {
  mountOutgoingWebhooksPanel();
}
document.addEventListener('bridge:socket-ready', () => mountOutgoingWebhooksPanel(), { once: true });
