import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_LOOKUP_SERVER_LIMIT,
  _resetDesktopDeepLinksForTest,
  initDesktopDeepLinks,
  parseDesktopDeepLink,
  routeDesktopDeepLink,
  type DeepLinkDeps,
} from '../js/core/desktop-deeplink.ts';

const json = (ok: boolean, body: unknown) => ({ ok, json: async () => body });

function deps(overrides: Partial<DeepLinkDeps> = {}): DeepLinkDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ready: () => true,
    servers: () => [{ _id: 's1' }, { _id: 's2' }],
    selectServer: vi.fn((server) => { calls.push(`select:${server._id}`); }),
    loadServers: vi.fn(async () => { calls.push('loadServers'); }),
    navigateToChannel: vi.fn(async (channelId: string, _m?: string, server?: { _id?: string }) => {
      calls.push(`navigate:${channelId}:${server?._id ?? 'current'}`);
      return Boolean(server);
    }),
    post: vi.fn(async () => json(true, { _id: 's9' })),
    get: vi.fn(async () => json(true, [])),
    toast: vi.fn((message: string, level: string) => { calls.push(`toast:${level}`); }),
    ...overrides,
  };
}

describe('parseDesktopDeepLink — same allow-list as the desktop shell', () => {
  it.each([
    ['bridge://invite/CODE_99', { kind: 'invite', code: 'CODE_99' }],
    ['bridge://servers/abc-123', { kind: 'server', id: 'abc-123' }],
    ['bridge://channels/ch_1', { kind: 'channel', id: 'ch_1' }],
  ])('accepts %s', (url, parsed) => {
    expect(parseDesktopDeepLink(url)).toEqual(parsed);
  });

  it.each([
    'bridge://admin/exec',
    'bridge://invite/../../etc',
    `bridge://invite/${'a'.repeat(33)}`,
    'bridge://servers/<script>',
    'https://evil.example.com/invite/x',
    '',
    42,
  ])('rejects %p', (url) => {
    expect(parseDesktopDeepLink(url)).toBeNull();
  });
});

describe('routeDesktopDeepLink', () => {
  it('joins an invite through the invite API, reloads servers and opens the joined server', async () => {
    const d = deps({ servers: () => [{ _id: 's1' }, { _id: 's9' }] });
    await expect(routeDesktopDeepLink({ kind: 'invite', code: 'A B' }, d)).resolves.toBe(true);
    expect(d.post).toHaveBeenCalledWith('/api/servers/invites/A%20B/use');
    expect(d.calls).toEqual(['loadServers', 'select:s9']);
  });

  it('reports a failed invite instead of doing nothing', async () => {
    const d = deps({ post: vi.fn(async () => json(false, { error: 'Invalid invite code' })) });
    await expect(routeDesktopDeepLink({ kind: 'invite', code: 'BAD' }, d)).resolves.toBe(false);
    expect(d.calls).toEqual(['toast:error']);
  });

  it('opens a known server and warns about an unknown one', async () => {
    const d = deps();
    await expect(routeDesktopDeepLink({ kind: 'server', id: 's2' }, d)).resolves.toBe(true);
    await expect(routeDesktopDeepLink({ kind: 'server', id: 'nope' }, d)).resolves.toBe(false);
    expect(d.calls).toEqual(['select:s2', 'toast:warning']);
  });

  it('finds a channel in another server through that server\'s channel list', async () => {
    const d = deps({
      get: vi.fn(async (url: string) => json(true, url.includes('/s2/') ? [{ _id: 'c7' }] : [{ _id: 'other' }])),
    });
    await expect(routeDesktopDeepLink({ kind: 'channel', id: 'c7' }, d)).resolves.toBe(true);
    expect(d.calls).toEqual(['navigate:c7:current', 'navigate:c7:s2']);
  });

  it('bounds the cross-server channel lookup', async () => {
    const many = Array.from({ length: CHANNEL_LOOKUP_SERVER_LIMIT + 10 }, (_, i) => ({ _id: `s${i}` }));
    const d = deps({ servers: () => many });
    await expect(routeDesktopDeepLink({ kind: 'channel', id: 'missing' }, d)).resolves.toBe(false);
    expect(d.get).toHaveBeenCalledTimes(CHANNEL_LOOKUP_SERVER_LIMIT);
    expect(d.calls.at(-1)).toBe('toast:warning');
  });

  it('waits for the app shell and gives up without side effects when it never becomes ready', async () => {
    const d = deps({ ready: () => false });
    await expect(routeDesktopDeepLink({ kind: 'server', id: 's1' }, d, 10)).resolves.toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe('initDesktopDeepLinks', () => {
  afterEach(() => {
    delete (window as unknown as { electronBridge?: unknown }).electronBridge;
    _resetDesktopDeepLinksForTest();
  });

  it('does nothing in a plain browser (no desktop bridge)', () => {
    expect(() => initDesktopDeepLinks(deps())).not.toThrow();
  });

  it('subscribes once to the desktop bridge and routes allowed links only', async () => {
    let deliver: ((url: string) => void) | undefined;
    const onDeepLink = vi.fn((cb: (url: string) => void) => { deliver = cb; return () => undefined; });
    (window as unknown as { electronBridge: unknown }).electronBridge = { onDeepLink };
    const d = deps();

    initDesktopDeepLinks(d);
    initDesktopDeepLinks(d);
    expect(onDeepLink).toHaveBeenCalledTimes(1);

    deliver!('bridge://admin/exec');
    deliver!('bridge://servers/s1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.calls).toEqual(['select:s1']);
  });
});
