import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: (...args: unknown[]) => apiMock(...args) }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'https://bridge.test' }));

import {
  BotConsentOutdatedError,
  fetchInstallState,
  fetchLoadedPlugins,
  getLoadedPlugins,
  installBotOnServer,
  uninstallBotFromServer,
} from '../js/core/bot-marketplace/bot-api.ts';

function response(body: unknown, status = 200): Response {
  const make = (): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body, clone: () => make() }) as unknown as Response;
  return make();
}

beforeEach(() => { apiMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('bot-api plugin listing', () => {
  it('normalises the plugin payload and rejects rows without an id or a name', async () => {
    apiMock.mockResolvedValue(response([
      null,
      'string-row',
      42,
      {},
      { id: '', name: '' },
      { id: 'timer', name: 'Timer', description: 'schedules', author: 'Bridge' },
      { id: 'only-id' },
      { name: 'only-name' },
      { id: 'wrong-types', name: 'Wrong Types', description: 12, author: { evil: true }, category: 'admin', tags: ['x'], rating: 9 },
    ]));

    const result = await fetchLoadedPlugins();

    expect(apiMock).toHaveBeenCalledWith('https://bridge.test/api/plugins');
    expect(result).toEqual([
      { id: 'timer', name: 'Timer', description: 'schedules', category: 'plugin', tags: [], rating: 0, author: 'Bridge', avatar: '🔌' },
      { id: 'only-id', name: 'only-id', description: '', category: 'plugin', tags: [], rating: 0, author: '', avatar: '🔌' },
      { id: 'only-name', name: 'only-name', description: '', category: 'plugin', tags: [], rating: 0, author: '', avatar: '🔌' },
      // Sunucudan gelen kategori/etiket/puan alanlari GUVENILMEZ: hepsi
      // yerelde sabit "plugin" degerine indirgenir.
      { id: 'wrong-types', name: 'Wrong Types', description: '', category: 'plugin', tags: [], rating: 0, author: '', avatar: '🔌' },
    ]);
  });

  it('a non-array payload empties the cached list instead of leaking the previous one', async () => {
    apiMock.mockResolvedValueOnce(response([{ id: 'timer', name: 'Timer' }]));
    await fetchLoadedPlugins();
    expect(getLoadedPlugins()).toHaveLength(1);

    apiMock.mockResolvedValueOnce(response({ plugins: [{ id: 'sneaky', name: 'Sneaky' }] }));
    const result = await fetchLoadedPlugins();

    expect(result).toEqual([]);
    expect(getLoadedPlugins()).toEqual([]);
  });

  it('the cached list is the same array instance, so late readers observe the refresh', async () => {
    apiMock.mockResolvedValueOnce(response([{ id: 'a', name: 'A' }]));
    const first = await fetchLoadedPlugins();
    const cached = getLoadedPlugins();
    expect(cached).toBe(first);

    apiMock.mockResolvedValueOnce(response([{ id: 'b', name: 'B' }]));
    await fetchLoadedPlugins();
    expect(cached.map(entry => entry.id)).toEqual(['b']);
  });

  it('a non-2xx plugin list surfaces the status and does not touch the cache', async () => {
    apiMock.mockResolvedValueOnce(response([{ id: 'keep', name: 'Keep' }]));
    await fetchLoadedPlugins();

    apiMock.mockResolvedValueOnce(response({ error: 'boom' }, 503));
    await expect(fetchLoadedPlugins()).rejects.toThrow('Plugin list HTTP 503');
    expect(getLoadedPlugins().map(entry => entry.id)).toEqual(['keep']);
  });
});

describe('bot-api marketplace installation', () => {
  it('installed ids are read per server, url-encoded, and filtered to strings', async () => {
    apiMock.mockResolvedValueOnce(response({ installed: ['a', 7, null, 'b', { id: 'c' }, 'a'] }));

    const { installed: ids } = await fetchInstallState('server/1 & 2');

    expect(apiMock).toHaveBeenCalledWith(
      'https://bridge.test/api/bots/marketplace/installed?serverId=server%2F1%20%26%202',
    );
    expect([...ids]).toEqual(['a', 'b']);
  });

  it('a missing or malformed installed field yields an empty set, never a crash', async () => {
    for (const payload of [{}, { installed: null }, { installed: 'a,b' }, { installed: 3 }]) {
      apiMock.mockResolvedValueOnce(response(payload));
      expect([...(await fetchInstallState('s-1')).installed]).toEqual([]);
    }
  });

  it('a failed installed-list read rejects with the response so callers can branch on status', async () => {
    const failure = response({ error: 'forbidden' }, 403);
    apiMock.mockResolvedValueOnce(failure);

    await expect(fetchInstallState('s-1')).rejects.toBe(failure);
  });

  it('grants are read per installed listing, keeping only string scopes', async () => {
    apiMock.mockResolvedValueOnce(response({
      installed: ['a', 'b'],
      grants: { a: ['commands', 'messages:reply', 7], b: 'commands', c: ['commands'] },
    }));
    const { grants } = await fetchInstallState('s-1');
    expect([...grants.entries()]).toEqual([['a', ['commands', 'messages:reply']], ['c', ['commands']]]);

    for (const payload of [{ installed: [] }, { installed: [], grants: null }, { installed: [], grants: [['a', ['commands']]] }]) {
      apiMock.mockResolvedValueOnce(response(payload));
      expect((await fetchInstallState('s-1')).grants.size).toBe(0);
    }
  });

  it('install posts the server id in the body and encodes the bot id in the path', async () => {
    apiMock.mockResolvedValueOnce(response({ ok: true }, 201));

    await installBotOnServer('bot/with space', 's-1', ['commands', 'messages:reply']);

    expect(apiMock).toHaveBeenCalledWith(
      'https://bridge.test/api/bots/marketplace/bot%2Fwith%20space/install',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: 's-1', acceptedPermissions: ['commands', 'messages:reply'] }),
      },
    );
  });

  it('a consent mismatch becomes a typed error; any other 400 rejects with the response', async () => {
    apiMock.mockResolvedValueOnce(response({ error: 'consent_required', permissions: ['commands', 'messages:reply'] }, 400));
    await expect(installBotOnServer('b', 's', ['commands'])).rejects.toBeInstanceOf(BotConsentOutdatedError);

    const invalid = response({ error: 'serverId required' }, 400);
    apiMock.mockResolvedValueOnce(invalid);
    await expect(installBotOnServer('b', '', ['commands'])).rejects.toBe(invalid);

    const unreadable = { ok: false, status: 400, json: async () => { throw new SyntaxError('html'); }, clone() { return this; } } as unknown as Response;
    apiMock.mockResolvedValueOnce(unreadable);
    await expect(installBotOnServer('b', 's', ['commands'])).rejects.toBe(unreadable);
  });

  it('uninstall deletes the server-scoped resource with both ids encoded', async () => {
    apiMock.mockResolvedValueOnce(response(null, 204));

    await uninstallBotFromServer('bot#1', 'server?2');

    expect(apiMock).toHaveBeenCalledWith(
      'https://bridge.test/api/bots/marketplace/bot%231/install/server%3F2',
      { method: 'DELETE' },
    );
  });

  it('install and uninstall failures reject with the response, not a generic error', async () => {
    const conflict = response({ error: 'already installed' }, 409);
    apiMock.mockResolvedValueOnce(conflict);
    await expect(installBotOnServer('b', 's', ['commands'])).rejects.toBe(conflict);

    const missing = response({ error: 'not installed' }, 404);
    apiMock.mockResolvedValueOnce(missing);
    await expect(uninstallBotFromServer('b', 's')).rejects.toBe(missing);
  });
});
