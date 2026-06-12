// client/js/core/search-svelte.ts
// Sprint 115 — SearchPanel mount shim (ADR-0008 Faz 2)
import { mount } from 'svelte';
import SearchPanel from './SearchPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';

let _searchInstance: ReturnType<typeof mount> | null = null;

function mountSearchPanel() {
  if (_searchInstance) return;
  const el = document.getElementById('search-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'search-root';
    document.body.appendChild(div);
    return div;
  })();
  _searchInstance = mount(SearchPanel, { target: el, props: {} });
  // BridgeRegistry.register('openSearch') — SearchPanel.svelte'in onMount'unda yapılır
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountSearchPanel, { once: true });
} else {
  mountSearchPanel();
}
document.addEventListener('bridge:socket-ready', mountSearchPanel, { once: true });
