// server/tests/link-preview-cache-layers.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/linkPreview — UC KATMANLI ONBELLEK VE DIS ICERIGIN SINIRLARI
// ════════════════════════════════════════════════════════════════════════════
// Link onizleme, KULLANICININ yapistirdigi bir adrese DIS bir HTTP istegi
// yapar. Bu yuzden iki ayri sozlesme ayni anda tutmalidir:
//
//   1. MALIYET: ayni adres icin ikinci kez dis istek YAPILMAZ. Onbellek uc
//      katmanlidir (surec ici LRU → PostgreSQL → ag) ve her katmanin
//      atlanmasi olculmelidir. Aksi hâlde bir kanaldaki tek bir populer
//      baglanti, her mesaj render'inda disariya istek uretirdi.
//
//   2. GUVEN: uzak icerik DUSMANDIR. HTML olmayan bir yanit, basligi olmayan
//      bir sayfa ya da bir ag hatasi "onizleme yok" demektir — uydurma bir
//      baslik uretilmez. Metin alanlari SINIRLIDIR; uzak sunucu 10 MB'lik bir
//      baslik gondererek istemci arayuzunu bozamaz.
//
// Bellek onbellegi SINIRLIDIR (LRU). Sinirsiz olsaydi, farkli adresler iceren
// mesaj akisi surecin bellegini sinirsiz buyuturdu.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

const fetchT = jest.fn();
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { _resetCache, extractUrls, fetchLinkPreview } from '../lib/linkPreview';

/** HTML yaniti uretir; `contentType` acikca verilebilir. */
function htmlResponse(body: string, contentType = 'text/html; charset=utf-8', ok = true): Response {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  _resetCache();
  fetchT.mockReset();
});

describe('URL extraction is bounded and de-duplicated', () => {
  test('returns nothing for empty input', () => {
    expect(extractUrls('')).toEqual([]);
    expect(extractUrls(undefined as unknown as string)).toEqual([]);
  });

  test('returns nothing when the text carries no link at all', () => {
    expect(extractUrls('sadece duz metin, baglanti yok')).toEqual([]);
  });

  test('de-duplicates and honours the limit', () => {
    const text = 'a https://x.test/1 b https://x.test/1 c https://x.test/2 d https://x.test/3 e https://x.test/4';
    // Sinir ONCE uygulanir: ilk 3 eslesme alinir, sonra tekillestirilir.
    expect(extractUrls(text, 3)).toEqual(['https://x.test/1', 'https://x.test/2']);
    expect(extractUrls(text, 5)).toEqual(['https://x.test/1', 'https://x.test/2', 'https://x.test/3', 'https://x.test/4']);
  });
});

describe('non-web and unusable targets never produce a preview', () => {
  test.each([
    ['a javascript: url', 'javascript:alert(1)'],
    ['a data: url', 'data:text/html,<h1>x</h1>'],
    ['a file: url', 'file:///etc/passwd'],
    ['a malformed url', 'not a url at all'],
  ])('refuses %s without touching the network', async (_label, url) => {
    await expect(fetchLinkPreview(url)).resolves.toBeNull();
    expect(fetchT).not.toHaveBeenCalled();
  });

  test('returns nothing when the network layer refuses the request', async () => {
    // `fetchT` SSRF korumasini uygular; reddi bir onizleme YOKLUGU'dur.
    fetchT.mockRejectedValueOnce(new Error('SSRFError: private address'));
    await expect(fetchLinkPreview('https://internal.test/')).resolves.toBeNull();
  });

  test('returns nothing for a non-2xx response', async () => {
    fetchT.mockResolvedValueOnce(htmlResponse('<title>x</title>', 'text/html', false));
    await expect(fetchLinkPreview('https://x.test/404')).resolves.toBeNull();
  });

  test.each([
    ['application/pdf'],
    ['image/png'],
    [''],
  ])('returns nothing when the content type is %s rather than HTML', async (contentType) => {
    fetchT.mockResolvedValueOnce(htmlResponse('%PDF-1.7', contentType));
    await expect(fetchLinkPreview('https://x.test/file')).resolves.toBeNull();
  });

  test('returns nothing when the page has no title in any form', async () => {
    fetchT.mockResolvedValueOnce(htmlResponse('<html><body>gövde</body></html>'));
    await expect(fetchLinkPreview('https://x.test/untitled')).resolves.toBeNull();
  });
});

describe('metadata extraction prefers Open Graph and stays bounded', () => {
  test('reads og tags in either attribute order and caps every field', async () => {
    const long = 'ç'.repeat(400);
    fetchT.mockResolvedValueOnce(htmlResponse(`
      <html><head>
        <meta property="og:title" content="${long}">
        <meta content="${long}" name="og:description">
        <meta property="og:image" content="https://cdn.test/i.png">
        <meta property="og:site_name" content="Örnek">
      </head></html>`));

    const preview = await fetchLinkPreview('https://x.test/a');
    expect(preview).not.toBeNull();
    expect(preview!.type).toBe('link');
    // Uzak sunucu sinirsiz metin dayatamaz.
    expect(preview!.title).toHaveLength(200);
    expect(preview!.description).toHaveLength(300);
    expect(preview!.image).toBe('https://cdn.test/i.png');
    expect(preview!.siteName).toBe('Örnek');
  });

  test('falls back to the document title and the hostname', async () => {
    fetchT.mockResolvedValueOnce(htmlResponse(
      '<html><head><title>  Basit Sayfa  </title></head></html>'));
    const preview = await fetchLinkPreview('https://fallback.test/page');
    expect(preview!.title).toBe('Basit Sayfa');
    expect(preview!.siteName).toBe('fallback.test');
    // Aciklama ve gorsel UYDURULMAZ; yoklari `null`dur.
    expect(preview!.description).toBeNull();
    expect(preview!.image).toBeNull();
  });

  test('falls back to the plain description meta when og:description is absent', async () => {
    fetchT.mockResolvedValueOnce(htmlResponse(
      '<html><head><title>T</title><meta name="description" content="düz açıklama"></head></html>'));
    const preview = await fetchLinkPreview('https://desc.test/');
    expect(preview!.description).toBe('düz açıklama');
  });
});

describe('the in-process cache prevents a second outbound request', () => {
  test('serves a repeated url from memory', async () => {
    fetchT.mockResolvedValueOnce(htmlResponse('<title>Bir</title>'));
    const first = await fetchLinkPreview('https://cache.test/x');
    const second = await fetchLinkPreview('https://cache.test/x');

    expect(second).toEqual(first);
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  test('normalises the cache key so equivalent urls share one entry', async () => {
    fetchT.mockResolvedValueOnce(htmlResponse('<title>Bir</title>'));
    await fetchLinkPreview('https://cache.test/y');
    await fetchLinkPreview('https://cache.test:443/y');   // ayni kaynak
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  test('evicts the oldest entry once the memory ceiling is reached', async () => {
    // Sinir 200'dur. 201 farkli adres yuklenince EN ESKI dusmelidir; aksi
    // hâlde surec bellegi mesaj akisiyla birlikte sinirsiz buyurdu.
    for (let i = 0; i < 201; i += 1) {
      fetchT.mockResolvedValueOnce(htmlResponse(`<title>S${i}</title>`));
      await fetchLinkPreview(`https://lru.test/${i}`);
    }
    expect(fetchT).toHaveBeenCalledTimes(201);

    // En yeni HÂLÂ bellektedir — ag'a gidilmez.
    await fetchLinkPreview('https://lru.test/200');
    expect(fetchT).toHaveBeenCalledTimes(201);

    // En eski DUSMUSTUR — yeniden getirilir.
    fetchT.mockResolvedValueOnce(htmlResponse('<title>tekrar</title>'));
    await fetchLinkPreview('https://lru.test/0');
    expect(fetchT).toHaveBeenCalledTimes(202);
  });

  test('a reset clears the memory layer and the next call goes out again', async () => {
    fetchT.mockResolvedValueOnce(htmlResponse('<title>Bir</title>'));
    await fetchLinkPreview('https://reset.test/');
    _resetCache();
    fetchT.mockResolvedValueOnce(htmlResponse('<title>Iki</title>'));
    const again = await fetchLinkPreview('https://reset.test/');
    expect(again!.title).toBe('Iki');
    expect(fetchT).toHaveBeenCalledTimes(2);
  });
});

describe('Spotify links are embedded without any outbound request', () => {
  test.each([
    ['track', 80],
    ['episode', 80],
    ['album', 352],
    ['playlist', 352],
    ['artist', 352],
  ])('builds a %s embed with height %i', async (kind, height) => {
    const preview = await fetchLinkPreview(`https://open.spotify.com/${kind}/abc123`) as
      (Record<string, unknown> | null);

    expect(preview).not.toBeNull();
    expect(preview!.type).toBe('spotify');
    expect(preview!.siteName).toBe('Spotify');
    expect(preview!.embedSrc).toBe(
      `https://open.spotify.com/embed/${kind}/abc123?utm_source=bridge&theme=0`);
    expect(preview!.embedHeight).toBe(height);
    // Embed OAuth gerektirmez ve DIS istek yapilmaz.
    expect(fetchT).not.toHaveBeenCalled();
  });

  test.each([
    ['an unknown resource kind', 'https://open.spotify.com/podcastx/abc'],
    ['a path with no id', 'https://open.spotify.com/track'],
    ['the bare host', 'https://open.spotify.com/'],
  ])('falls through to the normal fetch path for %s', async (_label, url) => {
    fetchT.mockResolvedValueOnce(htmlResponse('<title>Spotify</title>'));
    const preview = await fetchLinkPreview(url);
    expect(preview!.type).toBe('link');
    expect(fetchT).toHaveBeenCalledTimes(1);
  });
});
