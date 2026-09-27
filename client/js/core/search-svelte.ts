// client/js/core/search-svelte.ts
// Sprint 115 — SearchPanel mount shim (ADR-0008 Faz 2)
import { mount, unmount } from 'svelte';
import SearchPanel from './SearchPanel.svelte';

let _searchInstance: ReturnType<typeof mount> | null = null;

export function mountSearchPanel(target?: HTMLElement) {
  if (_searchInstance) return;
  const el = target ?? document.getElementById('search-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'search-root';
    document.body.appendChild(div);
    return div;
  })();
  _searchInstance = mount(SearchPanel, { target: el, props: {} });
  // BridgeRegistry.register('openSearch') — SearchPanel.svelte'in onMount'unda yapılır
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSearchPanel(), { once: true });
} else {
  mountSearchPanel();
}
document.addEventListener('bridge:socket-ready', () => mountSearchPanel(), { once: true });

/**
 * FAZ F — GERCEK SOKME.
 * `group-dm-svelte.ts` / `settings-modal-svelte.ts` ile ayni kanonik bicim:
 * Svelte'in `unmount()`u GERCEKTEN cagrilir, yoksa `onDestroy` calismaz ve
 * kayitlar (`openSearch`…) olu bir bilesene isaret etmeye devam ederdi.
 */
export function unmountSearchPanel(): void {
  if (!_searchInstance) return;
  void unmount(_searchInstance);
  _searchInstance = null;
}
