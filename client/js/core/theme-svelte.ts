// client/js/core/theme-svelte.ts
// Sprint 116 — ThemeManager mount shim (ADR-0008 Faz 3)
// Tema ve renk şeması yöneticisi
import { mount } from 'svelte';
import ThemeManager from './ThemeManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ThemeManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountThemeManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('theme-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'theme-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ThemeManager, { target: el, props: {} });
  log.info('ThemeManager mounted via shim');
}

export function unmountThemeManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountThemeManager(), { once: true });
} else {
  mountThemeManager();
}
document.addEventListener('bridge:socket-ready', () => mountThemeManager(), { once: true });

// Legacy compatibility export used by app.ts.
export async function loadTheme(): Promise<void> {
  mountThemeManager();
}
