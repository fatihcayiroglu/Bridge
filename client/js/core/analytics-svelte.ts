// client/js/core/analytics-svelte.ts
// Sprint 116 — AnalyticsTracker mount shim (ADR-0008 Faz 3)
// Kullanıcı analitik takipçisi
import { mount } from 'svelte';
import AnalyticsTracker from './AnalyticsTracker.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AnalyticsTrackerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAnalyticsTracker(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('analytics-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'analytics-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AnalyticsTracker, { target: el, props: {} });
  log.info('AnalyticsTracker mounted via shim');
}

export function unmountAnalyticsTracker(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAnalyticsTracker(), { once: true });
} else {
  mountAnalyticsTracker();
}
document.addEventListener('bridge:socket-ready', () => mountAnalyticsTracker(), { once: true });
