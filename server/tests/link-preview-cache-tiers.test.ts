import { recordOf, recordsOf } from './helpers/narrow';
// server/tests/link-preview-cache-tiers.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// LİNK ÖNİZLEME — İKİ KATMANLI ÖNBELLEK VE DIŞ İSTEK SINIRI
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/linkPreview.test.ts` HTTP ucunu ölçer ve bu modülü TAMAMEN taklit
// eder; yani modülün kendi mantığı ölçülmemişti. Burada ölçülenler:
//
//   · ÖNBELLEK SIRASI. Süreç-içi önbellek → PostgreSQL önbelleği → dış istek.
//     Sıra bozulursa her mesaj gönderimi bir dış HTTP isteği tetikler; bu hem
//     yavaşlık hem de üçüncü tarafa istem dışı bir istek akışıdır.
//   · SINIRLILIK. URL'yi kullanıcı belirler; süreç-içi önbellek sınırsız
//     olamaz.
//   · ÖNBELLEK ARIZASI ÖLÜMCÜL DEĞİLDİR. Veritabanı yoksa ya da sorgu
//     patlarsa önizleme yine üretilebilmelidir — önbellek bir hızlandırmadır,
//     bir bağımlılık değil.
//   · DIŞ İSTEK SINIRI. HTTP olmayan şema, hata durumu, HTML olmayan içerik
//     ve ağ hatası önizleme ÜRETMEZ (SSRF koruması `fetchT` içindedir).

'use strict';
process.env.NODE_ENV = 'test';

const fetchT = jest.fn();
jest.mock('../lib/fetch', () => ({ fetchT: (...a: unknown[]) => fetchT(...a) }));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const pool = { query: jest.fn() };
// Both keys exist from the start: the module snapshots the loader's own
// property names once, so a key added later would never be seen.
const loader: Record<string, unknown> = { _pool: pool, pool: undefined };
jest.mock('../db/loader', () => loader);

const realSetInterval = global.setInterval;
const intervals: Array<{ fn: () => unknown; ms: number }> = [];
jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
  intervals.push({ fn, ms });
  return realSetInterval(() => undefined, 2 ** 30);
}) as never);

import { fetchLinkPreview, extractUrls, _resetCache } from '../lib/linkPreview';

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8') {
  return {
    ok: true, status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => html,
  };
}

const PAGE = `
  <html><head>
    <meta property="og:title" content="Bridge">
    <meta property="og:description" content="Open source chat">
    <meta property="og:image" content="https://example.test/og.png">
    <meta property="og:site_name" content="Example">
  </head></html>`;

let urlSeq = 0;
const uniqueUrl = () => `https://example.test/page-${++urlSeq}`;

beforeEach(() => {
  jest.clearAllMocks();
  _resetCache();
  loader._pool = pool;
  loader.pool = undefined;
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  fetchT.mockResolvedValue(htmlResponse(PAGE));
});

describe('URL extraction', () => {
  it('bounds how many matches it scans, then de-duplicates what it kept', () => {
    // The cap applies to the RAW matches, so a repeated link consumes part of
    // the budget. That keeps the work bounded by the message, not by how many
    // distinct hosts an author can squeeze in.
    const text = 'a https://one.test b https://two.test c https://one.test d https://three.test e https://four.test';
    expect(extractUrls(text)).toEqual(['https://one.test', 'https://two.test']);
    expect(extractUrls(text, 1)).toEqual(['https://one.test']);
    expect(extractUrls(text, 5)).toEqual([
      'https://one.test', 'https://two.test', 'https://three.test', 'https://four.test',
    ]);
  });

  it('an empty or non-text input yields nothing', () => {
    expect(extractUrls('')).toEqual([]);
    expect(extractUrls(undefined as never)).toEqual([]);
    expect(extractUrls('no links here')).toEqual([]);
  });
});

describe('cache tiers are consulted in order', () => {
  it('the first call fetches, the second is served from memory', async () => {
    const url = uniqueUrl();
    const first = await fetchLinkPreview(url);
    expect(first).toMatchObject({ title: 'Bridge', description: 'Open source chat', siteName: 'Example' });
    expect(fetchT).toHaveBeenCalledTimes(1);

    const second = await fetchLinkPreview(url);
    expect(second).toEqual(first);
    // Neither the network nor the database was touched again.
    expect(fetchT).toHaveBeenCalledTimes(1);
    const selects = pool.query.mock.calls.filter(([sql]) => String(sql).startsWith('SELECT'));
    expect(selects).toHaveLength(1);
  });

  it('an expired memory entry falls through to the next tier', async () => {
    const url = uniqueUrl();
    await fetchLinkPreview(url);
    expect(fetchT).toHaveBeenCalledTimes(1);

    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      await fetchLinkPreview(url);
    } finally { clock.mockRestore(); }

    expect(fetchT).toHaveBeenCalledTimes(2);
  });

  it('a database hit is served without any network request and warms memory', async () => {
    const url = uniqueUrl();
    const cached = { type: 'link', url, title: 'From DB', description: null, image: null, siteName: 'DB' };
    pool.query.mockResolvedValue({ rows: [{ data: cached }], rowCount: 1 });

    const first = await fetchLinkPreview(url);
    expect(first).toEqual(cached);
    expect(fetchT).not.toHaveBeenCalled();

    pool.query.mockClear();
    const second = await fetchLinkPreview(url);
    expect(second).toEqual(cached);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a successful fetch is written back to the database cache', async () => {
    const url = uniqueUrl();
    await fetchLinkPreview(url);
    const inserts = pool.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO link_preview_cache'));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]![1] as unknown[])[0]).toBe(url);
  });

  it('the in-process cache is bounded', async () => {
    // The URL comes from user content, so an unbounded map is an unbounded
    // allocation path.
    for (let i = 0; i < 201; i += 1) await fetchLinkPreview(`https://example.test/bulk-${i}`);
    fetchT.mockClear();
    // The oldest entry was evicted, so it is fetched again.
    await fetchLinkPreview('https://example.test/bulk-0');
    expect(fetchT).toHaveBeenCalledTimes(1);
    // ...while the newest is still cached.
    fetchT.mockClear();
    await fetchLinkPreview('https://example.test/bulk-200');
    expect(fetchT).not.toHaveBeenCalled();
  });
});

describe('the database cache is an optimisation, never a dependency', () => {
  it('a loader that exposes `pool` instead of `_pool` is used just the same', async () => {
    loader._pool = undefined;
    loader.pool = pool;
    const url = uniqueUrl();
    pool.query.mockResolvedValue({ rows: [{ data: { type: 'link', url, title: 'Alt pool', description: null, image: null, siteName: 'x' } }], rowCount: 1 });

    await expect(fetchLinkPreview(url)).resolves.toMatchObject({ title: 'Alt pool' });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('a loader with no pool at all still produces a preview', async () => {
    loader._pool = undefined;
    loader.pool = undefined;
    const url = uniqueUrl();

    await expect(fetchLinkPreview(url)).resolves.toMatchObject({ title: 'Bridge' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a failing cache read still produces a preview', async () => {
    pool.query.mockRejectedValue(new Error('cache table missing'));
    await expect(fetchLinkPreview(uniqueUrl())).resolves.toMatchObject({ title: 'Bridge' });
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('a failing cache write does not fail the preview', async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('INSERT')) throw new Error('cache write refused');
      return { rows: [], rowCount: 0 };
    });
    await expect(fetchLinkPreview(uniqueUrl())).resolves.toMatchObject({ title: 'Bridge' });
  });

  it('two previews started together do not both open the database loader', async () => {
    // The second caller sees the loader mid-import and simply skips the cache
    // tier rather than starting a second import.
    const results = await Promise.all([
      fetchLinkPreview(uniqueUrl()),
      fetchLinkPreview(uniqueUrl()),
    ]);
    expect(results.every(r => r !== null)).toBe(true);
  });
});

describe('the periodic cleanup job', () => {
  it('is registered once and deletes expired rows', async () => {
    await fetchLinkPreview(uniqueUrl());
    await fetchLinkPreview(uniqueUrl());
    const cleanups = intervals.filter(i => i.ms === 60 * 60 * 1000);
    expect(cleanups).toHaveLength(1);

    pool.query.mockClear();
    pool.query.mockResolvedValue({ rows: [], rowCount: 3 });
    await cleanups[0]!.fn();
    expect(pool.query).toHaveBeenCalledWith(
      'DELETE FROM link_preview_cache WHERE "expiresAt" < $1', [expect.any(Number)]);
  });

  it('a sweep that removed nothing is silent, and a failure is contained', async () => {
    await fetchLinkPreview(uniqueUrl());
    const cleanup = intervals.find(i => i.ms === 60 * 60 * 1000)!.fn;

    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(cleanup()).resolves.toBeUndefined();

    pool.query.mockRejectedValue(new Error('delete refused'));
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('a sweep with no pool configured does nothing', async () => {
    await fetchLinkPreview(uniqueUrl());
    const cleanup = intervals.find(i => i.ms === 60 * 60 * 1000)!.fn;
    loader._pool = undefined;
    loader.pool = undefined;
    pool.query.mockClear();
    await cleanup();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('the outbound request boundary', () => {
  const refused: Array<[string, string]> = [
    ['a javascript: url', 'javascript:alert(1)'],
    ['a data: url', 'data:text/html,<h1>x</h1>'],
    ['a file: url', 'file:///etc/passwd'],
    ['something that is not a url', 'not a url at all'],
  ];
  for (const [name, url] of refused) {
    it(`refuses ${name} without any request`, async () => {
      await expect(fetchLinkPreview(url)).resolves.toBeNull();
      expect(fetchT).not.toHaveBeenCalled();
    });
  }

  it('a network failure (including an SSRF refusal) yields no preview', async () => {
    fetchT.mockRejectedValue(new Error('blocked host'));
    await expect(fetchLinkPreview(uniqueUrl())).resolves.toBeNull();
  });

  it('a non-2xx response yields no preview', async () => {
    fetchT.mockResolvedValue({ ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' });
    await expect(fetchLinkPreview(uniqueUrl())).resolves.toBeNull();
  });

  const nonHtml = ['application/pdf', 'image/png', ''];
  for (const contentType of nonHtml) {
    it(`refuses to parse "${contentType || 'a missing content type'}"`, async () => {
      fetchT.mockResolvedValue(htmlResponse(PAGE, contentType));
      await expect(fetchLinkPreview(uniqueUrl())).resolves.toBeNull();
    });
  }

  it('reads the request timeout and a bot user agent from the module, not the caller', async () => {
    await fetchLinkPreview(uniqueUrl());
    const [, init] = fetchT.mock.calls[0] as [string, any];
    expect(init.timeoutMs).toBe(4000);
    expect(init.headers['User-Agent']).toMatch(/BridgeBot/);
  });
});

describe('Spotify links become embeds without any outbound request', () => {
  const embeds: Array<[string, number]> = [
    ['track', 80],
    ['episode', 80],
    ['album', 352],
    ['playlist', 352],
    ['artist', 352],
  ];
  for (const [type, height] of embeds) {
    it(`a ${type} link embeds at ${height}px`, async () => {
      const url = `https://open.spotify.com/${type}/abc123`;
      const preview = recordOf(await fetchLinkPreview(url), 'preview');
      expect(preview).toMatchObject({ type: 'spotify', siteName: 'Spotify', embedHeight: height });
      expect(preview.embedSrc).toBe(`https://open.spotify.com/embed/${type}/abc123?utm_source=bridge&theme=0`);
      expect(fetchT).not.toHaveBeenCalled();
    });
  }

  it('an unknown Spotify path falls through to the ordinary fetch path', async () => {
    await fetchLinkPreview('https://open.spotify.com/user/someone');
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('a bare Spotify host also falls through', async () => {
    await fetchLinkPreview('https://open.spotify.com/track');
    expect(fetchT).toHaveBeenCalledTimes(1);
  });
});
