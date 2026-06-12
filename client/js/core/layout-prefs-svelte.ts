// client/js/core/layout-prefs-svelte.ts
// Sprint 116 — LayoutPrefs mount shim (ADR-0008 Faz 3)
// Kullanıcı layout tercihleri yöneticisi
import { mount } from 'svelte';
import LayoutPrefs from './LayoutPrefs.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('LayoutPrefsShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountLayoutPrefs(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('layout-prefs-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'layout-prefs-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(LayoutPrefs, { target: el, props: {} });
  log.info('LayoutPrefs mounted via shim');
}

export function unmountLayoutPrefs(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountLayoutPrefs(), { once: true });
} else {
  mountLayoutPrefs();
}
document.addEventListener('bridge:socket-ready', () => mountLayoutPrefs(), { once: true });
