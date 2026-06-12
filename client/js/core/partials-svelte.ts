// client/js/core/partials-svelte.ts
// Sprint 116 — PartialsManager mount shim (ADR-0008 Faz 3)
// Kısmi HTML şablonları yöneticisi
import { mount } from 'svelte';
import PartialsManager from './PartialsManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('PartialsManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountPartialsManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('partials-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'partials-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(PartialsManager, { target: el, props: {} });
  log.info('PartialsManager mounted via shim');
}

export function unmountPartialsManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountPartialsManager(), { once: true });
} else {
  mountPartialsManager();
}
document.addEventListener('bridge:socket-ready', () => mountPartialsManager(), { once: true });
