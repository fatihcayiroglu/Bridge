// client/js/core/globals-svelte.ts
// Sprint 116 — GlobalsProvider mount shim (ADR-0008 Faz 3)
// Global değişken sağlayıcı
import { mount } from 'svelte';
import GlobalsProvider from './GlobalsProvider.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('GlobalsProviderShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountGlobalsProvider(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('globals-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'globals-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(GlobalsProvider, { target: el, props: {} });
  log.info('GlobalsProvider mounted via shim');
}

export function unmountGlobalsProvider(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountGlobalsProvider(), { once: true });
} else {
  mountGlobalsProvider();
}
document.addEventListener('bridge:socket-ready', () => mountGlobalsProvider(), { once: true });

// Legacy compatibility export used by app.ts.
export function getAPI(): string {
  const api = (globalThis as unknown as { BRIDGE_API?: unknown }).BRIDGE_API;
  return typeof api === 'string' && api.length > 0 ? api : location.origin;
}
