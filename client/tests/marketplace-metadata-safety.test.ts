import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'https://bridge.test' }));

import { getCatalog, loadCatalog } from '../js/core/bot-marketplace/bot-catalog.ts';

beforeEach(() => {
  apiFetchMock.mockReset();
  getCatalog().splice(0);
});

describe('canonical bot marketplace metadata boundary', () => {
  it('rejects malformed rows and clamps numeric metadata without interpreting strings as markup', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        bots: [
          null,
          { id: '', name: 'missing id', category: 'utility' },
          { id: 'hostile', name: '<img src=x onerror=1>', category: '<svg onload=1>',
            description: '<script>bad()</script>', avatar: 'javascript:alert(1)',
            rating: -4, installs: -100, tags: ['<b>tool</b>', 42], commands: ['/safe', null] },
          { id: 'high', name: 'High', category: 'utility', rating: 99, installs: 7 },
        ],
      }),
    });

    const bots = await loadCatalog();
    expect(bots).toHaveLength(2);
    expect(bots[0]).toMatchObject({
      id: 'hostile',
      name: '<img src=x onerror=1>',
      category: '<svg onload=1>',
      description: '<script>bad()</script>',
      avatar: 'javascript:alert(1)',
      rating: 0,
      installs: 0,
      tags: ['<b>tool</b>'],
      commands: ['/safe'],
    });
    expect(bots[1]).toMatchObject({ rating: 5, installs: 7 });
    expect(getCatalog()).toEqual(bots);
  });

  it('fails boundedly when the authoritative catalog endpoint rejects', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 503, json: vi.fn() });
    await expect(loadCatalog()).rejects.toThrow('Marketplace catalog HTTP 503');
    expect(getCatalog()).toEqual([]);
  });
});
