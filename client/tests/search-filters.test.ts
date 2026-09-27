// client/tests/search-filters.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// FAZ 8/3 — ARAMA FİLTRELERİ.
//
// ════════════════════════════════════════════════════════════════════════════
// TASARIM KARARI
// ════════════════════════════════════════════════════════════════════════════
// Filtreler SUNUCUDA uygulanır (`routes/search.ts:applySearchFilters`).
// İstemcide süzmek iki ayrı şekilde yanlış olurdu:
//   1. `hasMore` ve sayfalama sayıları yanlış çıkardı,
//   2. kaç sonucun elendiği, görünmeyen içeriğin VARLIĞINI ele verirdi —
//      Search'te bir kez kapatılmış olan sızıntının aynısı.
//
// Filtreler YALNIZCA DARALTIR. Yetki elemesi (VIEW_CHANNELS + SQL'deki
// DM/grup üyeliği) filtrelerden ÖNCE yapılır; hiçbir filtre sonuç kümesine
// satır EKLEYEMEZ.

import { describe, it, expect, vi } from 'vitest';
import {
  parseFilterSyntax, hasActiveFilters, fetchUnifiedSearch, HAS_OPTIONS,
} from '../js/core/search/unified-search-client.ts';

const okResponse = (body: unknown = { results: [] }) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);

/** Son isteğin sorgu dizesi. */
const paramsOf = (api: ReturnType<typeof okResponse>) =>
  new URL('http://x' + String(api.mock.calls.at(-1)?.[0])).searchParams;

// ════════════════════════════════════════════════════════════════════════════
describe('sohbet sözdizimi ayrıştırma', () => {
  it('`from:` ayıklanır, kalan metin arama terimi olur', () => {
    expect(parseFilterSyntax('from:ayse merhaba dünya'))
      .toEqual({ text: 'merhaba dünya', filters: { from: 'ayse' } });
  });

  it('üç filtre birlikte kullanılabilir', () => {
    const { text, filters } = parseFilterSyntax('from:ayse in:genel has:file rapor');
    expect(text).toBe('rapor');
    expect(filters).toEqual({ from: 'ayse', in: 'genel', has: 'file' });
  });

  it('büyük/küçük harf duyarsızdır', () => {
    expect(parseFilterSyntax('FROM:ayse x').filters.from).toBe('ayse');
  });

  it('filtre YOKSA metin bozulmaz', () => {
    expect(parseFilterSyntax('merhaba dünya'))
      .toEqual({ text: 'merhaba dünya', filters: {} });
  });

  it('iki nokta içeren ama filtre OLMAYAN kelime metinde kalır', () => {
    // "saat:" bir filtre değildir; kullanıcının yazdığı metnin parçasıdır.
    const { text, filters } = parseFilterSyntax('toplantı saat:15 notları');
    expect(text).toBe('toplantı saat:15 notları');
    expect(filters).toEqual({});
  });

  it('değeri olmayan filtre yok sayılır', () => {
    expect(parseFilterSyntax('from: merhaba').filters).toEqual({});
  });

  it('filtre yalnız yazıldığında arama terimi BOŞ kalır', () => {
    // Panel bu durumda istek atmaz (2 karakter kuralı) — sessiz boş sonuç
    // yerine ipucu gösterilir.
    expect(parseFilterSyntax('has:file').text).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('hasActiveFilters', () => {
  it('boş nesne etkin değildir', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters(undefined)).toBe(false);
  });

  it('boş dizgi etkin SAYILMAZ', () => {
    expect(hasActiveFilters({ from: '   ' })).toBe(false);
  });

  it('dolu değer etkindir', () => {
    expect(hasActiveFilters({ has: 'file' })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('istek — filtreler SUNUCUYA gider', () => {
  it('filtreler sorgu parametresi olarak gönderilir', async () => {
    const api = okResponse();
    await fetchUnifiedSearch(api, 'rapor', { filters: { from: 'ayse', in: 'genel', channelId: 'c-exact', has: 'file' } });

    const params = paramsOf(api);
    expect(params.get('q')).toBe('rapor');
    expect(params.get('from')).toBe('ayse');
    expect(params.get('in')).toBe('genel');
    expect(params.get('channelId')).toBe('c-exact');
    expect(params.get('has')).toBe('file');
  });

  it('BOŞ filtre gönderilmez', () => {
    // Boş bir `from=` sunucuda hiçbir şeyle eşleşmeyen bir daraltma olurdu.
    const api = okResponse();
    return fetchUnifiedSearch(api, 'rapor', { filters: { from: '  ', has: 'file' } })
      .then(() => {
        const params = paramsOf(api);
        expect(params.has('from')).toBe(false);
        expect(params.get('has')).toBe('file');
      });
  });

  it('değerler kırpılır', async () => {
    const api = okResponse();
    await fetchUnifiedSearch(api, 'rapor', { filters: { from: '  ayse  ' } });
    expect(paramsOf(api).get('from')).toBe('ayse');
  });

  it('filtre yokken hiçbir ek parametre eklenmez', async () => {
    const api = okResponse();
    await fetchUnifiedSearch(api, 'rapor');
    const params = paramsOf(api);
    for (const key of ['from', 'in', 'has']) expect(params.has(key)).toBe(false);
  });

  it('İSTEMCİ sonuçları kendisi SÜZMEZ', async () => {
    // Sunucu ne döndürdüyse o gösterilir; istemci süzgeci sayfalama
    // sayılarını yanlış yapardı ve elenen sonuç sayısını ele verirdi.
    const api = okResponse({
      results: [
        { _id: 'm1', source: 'channel', content: 'a', createdAt: 1 },
        { _id: 'm2', source: 'channel', content: 'b', createdAt: 2 },
      ],
    });
    const res = await fetchUnifiedSearch(api, 'rapor', { filters: { has: 'file' } });
    expect(res.hits).toHaveLength(2);
  });

  it('kaynak filtresiyle birlikte çalışır', async () => {
    const api = okResponse();
    await fetchUnifiedSearch(api, 'rapor', { sources: ['dm'], filters: { has: 'link' } });
    const params = paramsOf(api);
    expect(params.get('sources')).toBe('dm');
    expect(params.get('has')).toBe('link');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sunulan seçenekler', () => {
  it('`has` seçenekleri sunucunun tanıdıklarıyla aynıdır', () => {
    // routes/search.ts:applySearchFilters — link | image | file
    expect(HAS_OPTIONS.map(o => o.id).sort()).toEqual(['file', 'image', 'link']);
  });

  it('her seçeneğin görünür etiketi vardır', () => {
    // Secenekler artik SABIT etiket degil, i18n ANAHTARI tasir (`labelKey`).
    for (const option of HAS_OPTIONS) {
      expect(option.labelKey.length).toBeGreaterThan(0);
      expect(t(option.labelKey)).not.toBe(option.labelKey);
    }
  });
});
