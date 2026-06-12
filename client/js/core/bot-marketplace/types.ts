export interface BotEntry {
  id: string;
  _id?: string;
  name: string;
  username?: string;
  description?: string;
  tags: string[];
  category: string;
  installed?: boolean;
  featured?: boolean;
  rating: number;
  installs?: number;
  avatar?: string;
  author?: string;
  commands?: string[];
  [key: string]: unknown;
}
export type MarketplaceTab = 'featured' | 'all' | 'bots' | 'plugins' | 'installed' | string;
export type SortMode = 'installs' | 'rating' | 'popular' | 'new' | 'name' | string;
