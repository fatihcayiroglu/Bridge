// client/js/core/search-highlight-svelte.ts
// Sprint 116 — SearchHighlight mount shim (ADR-0008 Faz 3)
// Arama sonucu metin vurgulama
import { mount } from 'svelte';
import SearchHighlight from './SearchHighlight.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SearchHighlightShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSearchHighlight(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('search-highlight-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'search-highlight-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SearchHighlight, { target: el, props: {} });
  log.info('SearchHighlight mounted via shim');
}

export function unmountSearchHighlight(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSearchHighlight(), { once: true });
} else {
  mountSearchHighlight();
}
document.addEventListener('bridge:socket-ready', () => mountSearchHighlight(), { once: true });
