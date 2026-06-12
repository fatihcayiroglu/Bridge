// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SearchHighlightPanel.svelte
//              client/js/core/search-highlight-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { BridgeRegistry } from './bridge-registry.js';
// client/js/core/search-highlight.ts
// Arama Highlight — arama sonuçlarında eşleşen kelime vurgulanır
// Sprint 33: JS → TS migration

declare global {
  interface Window {
    searchMessages?: (...args: unknown[]) => Promise<void>;
  }
}

const _origSearchMessages = BridgeRegistry.get('searchMessages');
if (typeof _origSearchMessages === 'function') {
  BridgeRegistry.register('searchMessages', async function (...args: unknown[]): Promise<void> {
    const q = (document.getElementById('search-input') as HTMLInputElement | null)?.value?.trim();
    await _origSearchMessages!.apply(window, args as []);
    if (q) highlightSearchTerms(q);
  };
}

function highlightSearchTerms(query: string): void {
  if (!query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex   = new RegExp(`(${escaped})`, 'gi');
  document.querySelectorAll<HTMLElement>('.msg-text').forEach(el => {
    el.childNodes.forEach(node => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent ?? '';
      if (!regex.test(text)) return;
      regex.lastIndex = 0;
      const span = document.createElement('span');
      span.innerHTML = text.replace(regex, '<mark class="search-highlight">$1</mark>');
      node.replaceWith(...Array.from(span.childNodes));
    });
  });
}
