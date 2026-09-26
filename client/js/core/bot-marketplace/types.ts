export interface BotEntry {
  id: string;
  _id?: string;
  name: string;
  username?: string;
  description?: string;
  tags: string[];
  category: string;
  installed?: boolean;
  installable?: boolean;
  featured?: boolean;
  rating: number;
  installs?: number;
  avatar?: string;
  author?: string;
  commands?: string[];
  /** Scopes installing asks the admin to consent to (server-canonical; echoed back on install). */
  requestedScopes?: string[];
  /** Declared permissions Bridge does not enforce; such a listing is not installable. */
  unsupportedPermissions?: string[];
  authorVerified?: boolean;
  [key: string]: unknown;
}
export type MarketplaceTab = 'featured' | 'all' | 'bots' | 'plugins' | 'installed' | string;
export type SortMode = 'installs' | 'rating' | 'popular' | 'new' | 'name' | string;
