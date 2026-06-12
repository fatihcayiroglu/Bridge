// client/js/core/analytics-dashboard-svelte.ts
// Sprint 116 — AnalyticsDashboard mount shim (ADR-0008 Faz 3)
// Sunucu analitik gösterge paneli
import { mount } from 'svelte';
import AnalyticsDashboard from './AnalyticsDashboard.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AnalyticsDashboardShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAnalyticsDashboard(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('analytics-dashboard-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'analytics-dashboard-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AnalyticsDashboard, { target: el, props: {} });
  log.info('AnalyticsDashboard mounted via shim');
}

export function unmountAnalyticsDashboard(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAnalyticsDashboard(), { once: true });
} else {
  mountAnalyticsDashboard();
}
document.addEventListener('bridge:socket-ready', () => mountAnalyticsDashboard(), { once: true });
