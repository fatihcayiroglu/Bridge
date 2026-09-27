process.env.NODE_ENV = 'test';
process.env.TENOR_API_KEY = 'secret key/+?';

const fetchT = jest.fn();
const warn = jest.fn();
jest.mock('../lib/fetch', () => ({ fetchT }));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn, debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { activeGifProvider, clampGifLimit, GIF_MAX_LIMIT } from '../lib/gifProvider';

describe('GIF provider production behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TENOR_API_KEY = 'secret key/+?';
  });

  it('reports configuration only when an API key is present', () => {
    const provider = activeGifProvider();
    expect(provider.name).toBe('tenor');
    expect(provider.isConfigured()).toBe(true);
    delete process.env.TENOR_API_KEY;
    expect(provider.isConfigured()).toBe(false);
  });

  it('normalizes search results, strips unknown fields and rejects unsafe media URLs', async () => {
    fetchT.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        results: [
          null,
          'garbage',
          42,
          { media_formats: null },
          {
            id: 'gif-1',
            content_description: 'x'.repeat(240),
            media_formats: {
              gif: { url: 'https://media.tenor.com/a.gif?x=1', dims: [320, 180] },
              tinygif: { url: 'https://media1.tenor.com/a-tiny.gif' },
            },
            unexpectedSecret: 'must-not-leak',
          },
          {
            id: 'unsafe-host',
            media_formats: {
              gif: { url: 'https://evil.example/a.gif', dims: [1, 2] },
              tinygif: { url: 'https://media.tenor.com/preview.gif' },
            },
          },
          {
            id: 'unsafe-protocol',
            media_formats: {
              gif: { url: 'http://media.tenor.com/a.gif', dims: [1, 2] },
              tinygif: { url: 'https://media.tenor.com/preview.gif' },
            },
          },
          {
            id: 123,
            content_description: 99,
            media_formats: {
              mediumgif: { url: 'https://media2.tenor.com/fallback.gif', dims: ['bad', Infinity] },
            },
          },
        ],
      }),
    });

    const provider = activeGifProvider();
    const items = await provider.search('cats & dogs', 7);

    expect(fetchT).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchT.mock.calls[0];
    expect(url).toContain('https://tenor.googleapis.com/v2/search?');
    expect(url).toContain('key=secret%20key%2F%2B%3F');
    expect(url).toContain('q=cats%20%26%20dogs');
    expect(url).toContain('limit=7');
    expect(opts).toEqual({ timeoutMs: 8000 });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: 'gif-1',
      url: 'https://media.tenor.com/a.gif?x=1',
      previewUrl: 'https://media1.tenor.com/a-tiny.gif',
      width: 320,
      height: 180,
      description: 'x'.repeat(200),
    });
    expect(items[1]).toEqual({
      id: 'https://media2.tenor.com/fallback.gif',
      url: 'https://media2.tenor.com/fallback.gif',
      previewUrl: 'https://media2.tenor.com/fallback.gif',
      width: 0,
      height: 0,
      description: '',
    });
    expect(JSON.stringify(items)).not.toContain('must-not-leak');
  });

  it('normalizes missing/non-array provider payloads to no results', async () => {
    const provider = activeGifProvider();
    for (const payload of [null, {}, { results: 'not-an-array' }]) {
      fetchT.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue(payload) });
      await expect(provider.trending(4)).resolves.toEqual([]);
    }
  });

  it('uses the featured endpoint for trending requests', async () => {
    fetchT.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ results: [] }) });
    await activeGifProvider().trending(12);
    expect(fetchT.mock.calls[0][0]).toContain('/v2/featured?');
    expect(fetchT.mock.calls[0][0]).toContain('limit=12');
  });

  it('turns upstream HTTP and JSON failures into bounded empty results', async () => {
    const provider = activeGifProvider();
    fetchT.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(provider.search('x', 1)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'gif.upstream_error', provider: 'tenor', status: 429 }),
      expect.any(String),
    );

    fetchT.mockResolvedValueOnce({ ok: true, json: jest.fn().mockRejectedValue(new Error('bad json')) });
    await expect(provider.trending(1)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'gif.upstream_bad_json', provider: 'tenor' }),
      expect.any(String),
    );
  });

  it('clamps fractional, zero, infinite and oversized limits deterministically', () => {
    expect(clampGifLimit(3.9)).toBe(3);
    expect(clampGifLimit('6')).toBe(6);
    expect(clampGifLimit(0)).toBe(20);
    expect(clampGifLimit(Infinity)).toBe(20);
    expect(clampGifLimit(GIF_MAX_LIMIT + 100)).toBe(GIF_MAX_LIMIT);
  });
});
