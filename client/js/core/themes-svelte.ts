// client/js/core/themes-svelte.ts
// Sprint 116 — ThemeSelector mount shim (ADR-0008 Faz 3)
// Tema seçici ve özel tema
import { mount } from 'svelte';
import ThemeSelector from './ThemeSelector.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ThemeSelectorShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountThemeSelector(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('themes-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'themes-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ThemeSelector, { target: el, props: {} });
  log.info('ThemeSelector mounted via shim');
}

export function unmountThemeSelector(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountThemeSelector(), { once: true });
} else {
  mountThemeSelector();
}
document.addEventListener('bridge:socket-ready', () => mountThemeSelector(), { once: true });
