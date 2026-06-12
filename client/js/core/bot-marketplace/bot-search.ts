import { getCatalog } from './bot-catalog.js';
import type { BotEntry, MarketplaceTab, SortMode } from './types.js';

export interface BotFilterOptions {
  category?: string;
  tab?: MarketplaceTab;
  searchQuery?: string;
  sortBy?: SortMode;
  installedIds?: Set<string>;
}

export function filterBots(itemsOrOptions: BotEntry[] | BotFilterOptions, query = ''): BotEntry[] {
  const options = Array.isArray(itemsOrOptions) ? { searchQuery: query } : itemsOrOptions;
  let items = Array.isArray(itemsOrOptions) ? itemsOrOptions : getCatalog();
  if (options.category) items = items.filter(b => b.category === options.category);
  if (options.tab === 'installed' && options.installedIds) items = items.filter(b => options.installedIds?.has(b.id));
  const q = (options.searchQuery ?? '').toLowerCase();
  if (q) items = items.filter(b => `${b.name ?? b.username ?? ''} ${b.description ?? ''} ${(b.tags ?? []).join(' ')}`.toLowerCase().includes(q));
  const sort = options.sortBy ?? 'installs';
  return [...items].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'rating') return (b.rating ?? 0) - (a.rating ?? 0);
    return (Number(b.installs ?? 0)) - (Number(a.installs ?? 0));
  });
}
