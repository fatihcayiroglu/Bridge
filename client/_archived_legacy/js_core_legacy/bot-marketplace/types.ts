// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/TypesPanel.svelte
//              client/js/core/types-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/types.ts

export interface BotEntry {
  id: string;
  name: string;
  author: string;
  authorVerified: boolean;
  avatar: string;
  category: string;
  tags: string[];
  description: string;
  longDescription: string;
  verified: boolean;
  featured: boolean;
  installs: number;
  rating: number;
  ratingCount: number;
  commands: string[];
  permissions: string[];
  changelog?: string;
  supportUrl: string;
  sourceUrl: string;
}

export interface PluginEntry {
  id?: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
}

export type SortMode = 'installs' | 'rating' | 'name';
export type MarketplaceTab = 'featured' | 'all' | 'installed' | 'plugins';
