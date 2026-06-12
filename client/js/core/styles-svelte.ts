// client/js/core/styles-svelte.ts
// Sprint 116 — ThemeStyles mount shim (ADR-0008 Faz 3)
// Dinamik CSS değişken yöneticisi
import { mount } from 'svelte';
import ThemeStyles from './ThemeStyles.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ThemeStylesShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountThemeStyles(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('styles-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'styles-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ThemeStyles, { target: el, props: {} });
  log.info('ThemeStyles mounted via shim');
}

export function unmountThemeStyles(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountThemeStyles(), { once: true });
} else {
  mountThemeStyles();
}
document.addEventListener('bridge:socket-ready', () => mountThemeStyles(), { once: true });
