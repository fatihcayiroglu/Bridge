// client/tests/unified-search-client.test.ts
//
// FAZ K/1 — BIRLESIK ARAMANIN ISTEMCI VERI KATMANI.
//
// Bu paketin korudugu iki gercek karar:
//   1. Sunucunun `highlight` HTML'i KULLANILMAZ. Vurgulama istemcide, metin
//      parcalari olarak yapilir; `{@html}` ile mesaj icerigi cizmek tek bir
//      kacirma hatasini dogrudan XSS'e cevirirdi.
//   2. Hata SESSIZCE bos sonuca donusturulmez — kullanici "sonuc yok" ile
//      "arama bozuk"u ayirt edebilmelidir.

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeHit, fetchUnifiedSearch, groupHits, flattenGroups,
  highlightSegments, snippetAround, SOURCE_ORDER, MIN_QUERY_LENGTH,
  type SearchHit,
} from '../js/core/search/unified-search-client.ts';

const row = (over: Record<string, unknown> = {}) => ({
  _id: 'm1', source: 'channel', content: 'merhaba dunya',
  displayName: 'Ayse', userId: 'u1', createdAt: 1000, score: 1,
  ...over,
});

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'm1', source: 'channel', content: 'x', highlight: '', authorName: 'A',
  authorId: 'u1', createdAt: 1, score: 1, ...over,
});

const response = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);

// ════════════════════════════════════════════════════════════════════════════
describe('normalizeHit', () => {
  it('sunucu satirini alan alan cozer', () => {
    const h = normalizeHit(row({ channelId: 'c1', serverId: 's1', dmId: 'd1', threadId: 't1' }));
    expect(h).toMatchObject({
      id: 'm1', source: 'channel', authorName: 'Ayse', authorId: 'u1',
      channelId: 'c1', serverId: 's1', conversationId: 'd1', threadId: 't1',
    });
  });

  it('dort kaynagi da tanir', () => {
    for (const source of SOURCE_ORDER)
      expect(normalizeHit(row({ source }))?.source).toBe(source);
  });

  it('TANINMAYAN kaynak ATILIR — olu satir cizilmez', () => {
    // Bilinmeyen tur icin gezinme hedefi de yoktur; gosterilirse tiklandiginda
    // hicbir sey yapmayan bir satir olurdu.
    expect(normalizeHit(row({ source: 'voice' }))).toBeNull();
    expect(normalizeHit(row({ source: '' }))).toBeNull();
  });

  it('kimliksiz satir ATILIR', () => {
    expect(normalizeHit(row({ _id: '' }))).toBeNull();
  });

  it('sunucunun `_source`/`_score` biciminden de okur', () => {
    const h = normalizeHit({ _id: 'm2', _source: 'dm', _score: 4, content: 'a', createdAt: 2 });
    expect(h).toMatchObject({ id: 'm2', source: 'dm', score: 4 });
  });

  it('nesne olmayan girdi cokmeye yol acmaz', () => {
    for (const bad of [null, undefined, 42, 'x', []])
      expect(normalizeHit(bad)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('fetchUnifiedSearch', () => {
  it('kanonik ucu cagirir ve satirlari normalize eder', async () => {
    const api = response({ results: [row()], hasMore: false });
    const res = await fetchUnifiedSearch(api, 'merhaba');

    expect(api.mock.calls[0]![0]).toContain('/api/search/unified?');
    expect(api.mock.calls[0]![0]).toContain('q=merhaba');
    expect(res.hits).toHaveLength(1);
  });

  it('kaynak ve limit parametreleri gecirilir', async () => {
    const api = response({ results: [] });
    await fetchUnifiedSearch(api, 'merhaba', { sources: ['dm', 'gdm'], limit: 10 });

    const url = String(api.mock.calls[0]![0]);
    expect(url).toContain('sources=dm%2Cgdm');
    expect(url).toContain('limit=10');
  });

  it('cok kisa sorgu ISTEK ATMAZ', async () => {
    const api = response({ results: [] });
    const res = await fetchUnifiedSearch(api, 'a');

    expect(api).not.toHaveBeenCalled();
    expect(res.hits).toEqual([]);
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  it('HTTP hatasi FIRLATIR — bos sonuc gibi gorunmez', async () => {
    // "Sonuc yok" ile "arama calismiyor" ayni gorunurse kullanici bozuk
    // aramayi bos sonuc sanar.
    const api = response({}, false, 503);
    await expect(fetchUnifiedSearch(api, 'merhaba')).rejects.toThrow('HTTP 503');
  });

  it('firlatilan hata durum kodunu tasir', async () => {
    const api = response({}, false, 429);
    await expect(fetchUnifiedSearch(api, 'merhaba'))
      .rejects.toMatchObject({ status: 429 });
  });

  it('beklenmedik govde cokmeye yol acmaz', async () => {
    const api = response({ results: 'bozuk' });
    expect((await fetchUnifiedSearch(api, 'merhaba')).hits).toEqual([]);
  });

  it('abort sinyali istege gecirilir', async () => {
    const api = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }) as unknown as Response);
    const controller = new AbortController();
    await fetchUnifiedSearch(api, 'merhaba', { signal: controller.signal });

    expect(api.mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('groupHits / flattenGroups', () => {
  const hits = [
    hit({ id: 'a', source: 'thread' }),
    hit({ id: 'b', source: 'dm' }),
    hit({ id: 'c', source: 'channel' }),
    hit({ id: 'd', source: 'dm' }),
  ];

  it('sabit sunum sirasina gore gruplar', () => {
    expect(groupHits(hits).map(g => g.source)).toEqual(['channel', 'dm', 'thread']);
  });

  it('BOS grup cizilmez', () => {
    // Bos bir "Grup mesajlari" basligi bilgi vermez, yalnizca yer kaplar.
    expect(groupHits(hits).some(g => g.source === 'gdm')).toBe(false);
    expect(groupHits([])).toEqual([]);
  });

  it('grup ICI sira sunucudan geldigi gibi korunur (relevans)', () => {
    const dm = groupHits(hits).find(g => g.source === 'dm')!;
    expect(dm.hits.map(h => h.id)).toEqual(['b', 'd']);
  });

  it('duz sira SUNUM sirasiyla ayni — klavye secimi ziplamaz', () => {
    expect(flattenGroups(groupHits(hits)).map(h => h.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('her grup insan okunur bir etiket tasir', () => {
    for (const group of groupHits(hits)) expect(group.label.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('highlightSegments', () => {
  const joined = (segs: { text: string }[]) => segs.map(s => s.text).join('');

  it('eslesen parcayi isaretler', () => {
    const segs = highlightSegments('merhaba dunya', 'dunya');
    expect(segs.filter(s => s.match).map(s => s.text)).toEqual(['dunya']);
  });

  it('METNI ASLA DEGISTIRMEZ — parcalar birlestiginde orijinali verir', () => {
    // Bu, `{@html}` yerine parcalama secilmesinin can alici ozelligi:
    // hicbir sey eklenmez, kacirilmaz, kaybolmaz.
    for (const text of ['<script>alert(1)</script> merhaba', 'a & b "c"', 'merhaba']) {
      expect(joined(highlightSegments(text, 'merhaba'))).toBe(text);
    }
  });

  it('HTML metni VERI olarak kalir — isaretleme uretmez', () => {
    const segs = highlightSegments('<img src=x onerror=alert(1)>', 'img');
    expect(joined(segs)).toBe('<img src=x onerror=alert(1)>');
    expect(segs.some(s => s.text.includes('<mark>'))).toBe(false);
  });

  it('buyuk/kucuk harf duyarsiz eslesir', () => {
    expect(highlightSegments('Merhaba', 'merhaba').filter(s => s.match)).toHaveLength(1);
  });

  it('CAKISAN eslesmeler TEK araliga iner', () => {
    // Sunucunun ardisik `replace` dongusu burada bozuk isaretleme uretiyordu.
    const segs = highlightSegments('abcdef', 'abc bcd');
    expect(segs.filter(s => s.match).map(s => s.text)).toEqual(['abcd']);
    expect(joined(segs)).toBe('abcdef');
  });

  it('coklu eslesmelerin hepsi isaretlenir', () => {
    const segs = highlightSegments('kedi ve kedi', 'kedi');
    expect(segs.filter(s => s.match)).toHaveLength(2);
  });

  it('tek harflik kelimeler vurgulanmaz (gurultu)', () => {
    expect(highlightSegments('a b c', 'a').every(s => !s.match)).toBe(true);
  });

  it('bos metin / bos sorgu guvenli', () => {
    expect(highlightSegments('', 'x')).toEqual([]);
    expect(highlightSegments('abc', '  ')).toEqual([{ text: 'abc', match: false }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('snippetAround', () => {
  it('kisa metin oldugu gibi kalir', () => {
    expect(snippetAround('kisa metin', 'metin')).toBe('kisa metin');
  });

  it('uzun metinde ESLESMENIN cevresi gosterilir', () => {
    // Metnin basini gostermek kullaniciya NEDEN eslestigini anlatmaz.
    const text = `${'x'.repeat(400)} bulundu ${'y'.repeat(400)}`;
    const snippet = snippetAround(text, 'bulundu');
    expect(snippet).toContain('bulundu');
    expect(snippet.length).toBeLessThan(text.length);
  });

  it('eslesme yoksa bastan kirpilir', () => {
    const snippet = snippetAround('z'.repeat(500), 'bulunamaz');
    expect(snippet.endsWith('…')).toBe(true);
  });
});
