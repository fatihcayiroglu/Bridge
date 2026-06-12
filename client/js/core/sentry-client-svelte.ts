// client/js/core/sentry-client-svelte.ts
// Sprint 116 — SentryClient mount shim (ADR-0008 Faz 3)
// Sentry hata izleme entegrasyonu
import { mount } from 'svelte';
import SentryClient from './SentryClient.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SentryClientShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSentryClient(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('sentry-client-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'sentry-client-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SentryClient, { target: el, props: {} });
  log.info('SentryClient mounted via shim');
}

export function unmountSentryClient(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSentryClient(), { once: true });
} else {
  mountSentryClient();
}
document.addEventListener('bridge:socket-ready', () => mountSentryClient(), { once: true });
