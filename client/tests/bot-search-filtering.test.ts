// client/tests/bot-search-filtering.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// bot-marketplace/bot-search.ts — FİLTRELEME VE SIRALAMA SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
// Katalog satırları kısmi olabilir: bir bot yalnızca `username` taşıyabilir,
// açıklaması veya etiketi hiç olmayabilir, kurulum sayısı dizge gelebilir.
//
// Ölçülen üç sözleşme:
//   1. ARAMA hiçbir zaman `"undefined"` metni üzerinden eşleşmemelidir. Eksik
//      alanlar birleştirilirken `undefined` dizgeye dönerse `?q=undefined`
//      TÜM katalogu getirirdi.
//   2. "Kurulu" sekmesi, kimlik kümesi VERİLMEDEN daraltma yapmaz — küme henüz
//      yüklenmemişken kullanıcıya yanlışlıkla "hiç kurulu bot yok" denmez.
//   3. SIRALAMA girdiyi DEĞİŞTİRMEZ: katalog paylaşılan bir dizidir ve
//      yerinde sıralanırsa diğer görünümlerin sırası sessizce bozulurdu.
import { describe, it, expect, vi } from 'vitest';

const catalog = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../js/core/bot-marketplace/bot-catalog.js', () => ({ getCatalog: () => catalog.rows }));

import { filterBots } from '../js/core/bot-marketplace/bot-search.ts';
import type { BotEntry } from '../js/core/bot-marketplace/types.ts';

const bot = (overrides: Record<string, unknown> & { id: string; name: string }): BotEntry =>
  ({ category: 'utility', ...overrides }) as unknown as BotEntry;

const ROWS: BotEntry[] = [
  bot({ id: 'a', name: 'Alpha', description: 'moderation helper', tags: ['mod', 'safety'], rating: 4.5, installs: 10 }),
  bot({ id: 'b', name: 'Beta', username: 'beta-bot', rating: 3, installs: '200' }),
  bot({ id: 'c', name: 'Gamma', description: 'music', tags: [], category: 'fun', installs: 5 }),
  bot({ id: 'd', name: 'Delta' }),
];

function withCatalog<T>(rows: BotEntry[], run: () => T): T {
  catalog.rows = rows;
  try { return run(); } finally { catalog.rows = []; }
}

const ids = (items: BotEntry[]) => items.map(item => item.id);

describe('search matching', () => {
  it('accepts both the legacy array+query signature and the options object', () => {
    expect(ids(filterBots(ROWS, 'moderation'))).toEqual(['a']);
    expect(withCatalog(ROWS, () => ids(filterBots({ searchQuery: 'moderation' })))).toEqual(['a']);
  });

  it('never matches a row through an absent field rendered as text', () => {
    expect(filterBots(ROWS, 'undefined')).toEqual([]);
    expect(filterBots(ROWS, 'null')).toEqual([]);
  });

  it('searches the name, the fallback username, the description and the tags', () => {
    expect(ids(filterBots(ROWS, 'alpha'))).toEqual(['a']);
    // `name` YOKSA `username` yedeğe düşer; adı olan satır için düşmez.
    const nameless = [bot({ id: 'e', username: 'solo-bot', installs: 1 } as never)];
    expect(ids(filterBots(nameless, 'SOLO-BOT'))).toEqual(['e']);
    expect(filterBots(ROWS, 'beta-bot')).toEqual([]);
    expect(ids(filterBots(ROWS, 'music'))).toEqual(['c']);
    expect(ids(filterBots(ROWS, 'safety'))).toEqual(['a']);
  });

  it('treats an empty or absent query as no filter at all', () => {
    expect(filterBots(ROWS, '')).toHaveLength(ROWS.length);
    expect(withCatalog(ROWS, () => filterBots({}))).toHaveLength(ROWS.length);
  });
});

describe('category and installed-tab narrowing', () => {
  it('filters by category independently of the query', () => {
    expect(withCatalog(ROWS, () => ids(filterBots({ category: 'fun' })))).toEqual(['c']);
    expect(withCatalog(ROWS, () => ids(filterBots({ category: 'utility', searchQuery: 'delta' })))).toEqual(['d']);
    expect(withCatalog(ROWS, () => filterBots({ category: 'nonexistent' }))).toEqual([]);
  });

  it('restricts the installed tab to the supplied id set', () => {
    const installed = new Set(['b', 'd']);
    expect(withCatalog(ROWS, () => ids(filterBots({ tab: 'installed', installedIds: installed, sortBy: 'name' }))))
      .toEqual(['Beta', 'Delta'].map(name => ROWS.find(row => row.name === name)!.id));
  });

  it('does not narrow the installed tab before the id set has loaded', () => {
    // Küme yokken daraltmak, veri gelene kadar "hiç kurulu bot yok" derdi.
    expect(withCatalog(ROWS, () => ids(filterBots({ tab: 'installed', sortBy: 'name' })))).toHaveLength(ROWS.length);
  });

  it('does not apply the installed id set on any other tab', () => {
    expect(withCatalog(ROWS, () => ids(filterBots({ tab: 'all', installedIds: new Set(['b']), sortBy: 'name' }))))
      .toHaveLength(ROWS.length);
  });
});

describe('ordering', () => {
  it('orders by installs by default and coerces a string install count', () => {
    expect(ids(filterBots(ROWS, ''))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('orders alphabetically by name on request', () => {
    expect(withCatalog(ROWS, () => ids(filterBots({ sortBy: 'name' })))).toEqual(['a', 'b', 'd', 'c']);
  });

  it('orders by rating and treats a missing rating as the lowest', () => {
    expect(withCatalog(ROWS, () => ids(filterBots({ sortBy: 'rating' })))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts a copy so the shared catalog array is never reordered in place', () => {
    const snapshot = ROWS.map(row => row.id);
    const sorted = filterBots(ROWS, '');
    expect(ROWS.map(row => row.id)).toEqual(snapshot);
    expect(sorted).not.toBe(ROWS);
  });
});
