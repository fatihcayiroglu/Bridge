// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BotCatalogPanel.svelte
//              client/js/core/bot-catalog-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/bot-catalog.ts

import { getAPI } from '../globals.js';
import { apiFetch } from '../api-fetch.js';
import { BOT_CATALOG } from './catalog-data.js';
import type { BotEntry } from './types.js';

let _catalog: BotEntry[] | null = null;

export async function loadCatalog(): Promise<BotEntry[]> {
  if (_catalog) return _catalog;
  try {
    const res = await apiFetch(`${getAPI() ?? ''}/api/bots/marketplace?limit=100`);
    if (res.ok) {
      // Server returns {bots: [...], total: N, limit, offset}
      const payload = await res.json() as { bots?: Array<Record<string, unknown>> };
      const data = Array.isArray(payload.bots) ? payload.bots : [];
      if (data.length > 0) {
        _catalog = data.map(b => ({
          id:              String(b.id ?? b._id ?? ''),
          name:            String(b.name ?? b.username ?? 'Unknown Bot'),
          author:          String(b.author ?? 'Community'),
          authorVerified:  Boolean(b.authorVerified ?? b.verified),
          avatar:          String(b.avatar ?? b.icon ?? '🤖'),
          category:        String(b.category ?? 'utility'),
          tags:            Array.isArray(b.tags) ? b.tags as string[] : [String(b.category ?? 'utility')],
          description:     String(b.description ?? ''),
          longDescription: String(b.longDescription ?? b.description ?? ''),
          verified:        Boolean(b.verified),
          featured:        Boolean(b.featured),
          installs:        Number(b.installs ?? b.serverCount ?? 0),
          rating:          Number(b.rating ?? 0),
          ratingCount:     Number(b.ratingCount ?? 0),
          commands:        Array.isArray(b.commands) ? b.commands as string[] : [],
          permissions:     Array.isArray(b.permissions) ? b.permissions as string[] : [],
          changelog:       String(b.changelog ?? ''),
          supportUrl:      String(b.supportUrl ?? '#'),
          sourceUrl:       String(b.sourceUrl ?? '#'),
        }));
        return _catalog;
      }
    }
  } catch { /* fallback */ }
  _catalog = BOT_CATALOG;
  return _catalog;
}

export function getCatalog(): BotEntry[] {
  return _catalog ?? BOT_CATALOG;
}

export function clearCatalogCache(): void {
  _catalog = null;
}
