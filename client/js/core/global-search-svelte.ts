// client/js/core/global-search-svelte.ts
// FAZ K/1 — GlobalSearchPanel mount shim.
//
// Kanonik bicim `search-svelte.ts` / `group-dm-svelte.ts` ile AYNI: kendi
// kokunu olusturur, `unmount()` GERCEKTEN cagrilir (yoksa `onDestroy`
// calismaz ve `openGlobalSearch` kaydi olu bir bilesene isaret ederdi).

import { mount, unmount } from 'svelte';
import GlobalSearchPanel from './GlobalSearchPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountGlobalSearch(target?: HTMLElement): void {
  if (instance) return;
  const el = target ?? document.getElementById('global-search-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'global-search-root';
    document.body.appendChild(div);
    return div;
  })();
  instance = mount(GlobalSearchPanel, { target: el, props: {} });
}

export function unmountGlobalSearch(): void {
  if (!instance) return;
  void unmount(instance);
  instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountGlobalSearch(), { once: true });
} else {
  mountGlobalSearch();
}
