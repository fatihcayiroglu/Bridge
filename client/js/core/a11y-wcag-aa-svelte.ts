// client/js/core/a11y-wcag-aa-svelte.ts
// Sprint 116 — WcagAudit mount shim (ADR-0008 Faz 3)
// WCAG AA uyumluluk denetim yardımcısı
import { mount } from 'svelte';
import WcagAudit from './WcagAudit.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('WcagAuditShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountWcagAudit(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('a11y-wcag-aa-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'a11y-wcag-aa-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(WcagAudit, { target: el, props: {} });
  log.info('WcagAudit mounted via shim');
}

export function unmountWcagAudit(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountWcagAudit(), { once: true });
} else {
  mountWcagAudit();
}
document.addEventListener('bridge:socket-ready', () => mountWcagAudit(), { once: true });

// Legacy compatibility export used by app.ts.
export function initA11yWcagAA(): void {
  mountWcagAudit();
}
