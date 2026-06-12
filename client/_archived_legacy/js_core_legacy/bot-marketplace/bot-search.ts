// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BotSearchPanel.svelte
//              client/js/core/bot-search-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/bot-search.ts

import type { BotEntry, MarketplaceTab, SortMode } from './types.js';
import { getCatalog } from './bot-catalog.js';

export interface FilterOptions {
  category?:   string;
  tab?:        MarketplaceTab;
  searchQuery?: string;
  sortBy?:     SortMode;
  installedIds?: Set<string>;
}

export function filterBots(opts: FilterOptions): BotEntry[] {
  const {
    category = '',
    tab = 'all',
    searchQuery = '',
    sortBy = 'installs',
    installedIds = new Set<string>(),
  } = opts;

  let bots = [...getCatalog()];
  if (category) bots = bots.filter(b => b.category === category);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    bots = bots.filter(b =>
      b.name.toLowerCase().includes(q) ||
      b.description.toLowerCase().includes(q) ||
      b.tags.some(t => t.includes(q)),
    );
  }
  if (tab === 'featured')  bots = bots.filter(b => b.featured || b.installs > 10000);
  if (tab === 'installed') bots = bots.filter(b => installedIds.has(b.id));

  return sortBots(bots, sortBy);
}

export function sortBots(bots: BotEntry[], sortBy: SortMode): BotEntry[] {
  const sorted = [...bots];
  sorted.sort((a, b) => {
    if (sortBy === 'rating') return b.rating - a.rating;
    if (sortBy === 'name')   return a.name.localeCompare(b.name, 'tr');
    return b.installs - a.installs;
  });
  return sorted;
}

export function countByCategory(categoryId: string): number {
  const catalog = getCatalog();
  return categoryId === '' ? catalog.length : catalog.filter(b => b.category === categoryId).length;
}
