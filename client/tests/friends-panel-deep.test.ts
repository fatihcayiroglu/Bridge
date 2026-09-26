import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FriendsPanel from '../js/core/FriendsPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { friendsCache } from '../js/core/globals.ts';

const registryKeys = [
  'apiFetch', 'showFriendsPanel', 'openFriendsPanel', 'hideFriendsPanel',
  'openDm', 'showGroupDmPanel',
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function registerApi(handler: (url: string, options?: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(handler);
  BridgeRegistry.register('apiFetch', mock as unknown as AnyFn);
  return mock;
}

function defaultHandler(url: string): Promise<Response> {
  if (url.endsWith('/api/friends/pending')) return Promise.resolve(json([]));
  if (url.endsWith('/api/friends')) return Promise.resolve(json([]));
  return Promise.resolve(json({ ok: true }));
}

async function renderOpen(): Promise<ReturnType<typeof render>> {
  const view = render(FriendsPanel);
  await waitFor(() => expect(BridgeRegistry.get('showFriendsPanel')).toBeTypeOf('function'));
  BridgeRegistry.call('showFriendsPanel');
  await waitFor(() => expect(view.container.querySelector('.friends-panel')).not.toBeNull());
  return view;
}

beforeEach(() => {
  friendsCache.clear();
  registerApi(defaultHandler);
});

afterEach(() => {
  cleanup();
  for (const key of registryKeys) BridgeRegistry.unregister(key);
  friendsCache.clear();
  vi.restoreAllMocks();
});

describe('FriendsPanel defensive normalization and filtering', () => {
  it('rejects malformed identities, deduplicates canonical IDs, and sanitizes user fields', async () => {
    const openDm = vi.fn();
    BridgeRegistry.register('openDm', openDm);
    registerApi(async (url) => {
      if (url.endsWith('/pending')) return json([
        null, {}, { _id: ' ', userId: 'u0' },
        { _id: ' r1 ', userId: ' u9 ', sender: { displayName: 42, avatarColor: 'red' } },
        { _id: 'r1', userId: 'duplicate' },
      ]);
      return json([
        null, [], {}, { _id: ' ' },
        { _id: ' u1 ', username: ' offline-user ', displayName: 42, avatarColor: '#12345', status: 'bogus' },
        { _id: 'u1', username: 'duplicate', status: 'online' },
        { _id: 'u2', displayName: ' Online Ada ', username: 'ada', avatarColor: '#aabbcc', status: 'online' },
      ]);
    });

    const view = await renderOpen();
    await waitFor(() => expect(view.container.textContent).toContain('Online Ada'));
    expect(view.container.textContent).not.toContain('offline-user');

    const nav = view.container.querySelectorAll('[role="tablist"] button');
    await fireEvent.click(nav[1]!);
    expect(view.container.querySelectorAll('.friend-row')).toHaveLength(2);
    expect(view.container.textContent).toContain('offline-user');
    expect(friendsCache.size).toBe(2);
    expect(friendsCache.get('u1')).toMatchObject({
      _id: 'u1', username: 'offline-user', avatarColor: undefined, status: 'offline',
    });

    const adaRow = [...view.container.querySelectorAll('.friend-row')].find((row) => row.textContent?.includes('Online Ada'))!;
    await fireEvent.click(adaRow.querySelector('button')!);
    expect(openDm).toHaveBeenCalledWith('u2', 'Online Ada', '#aabbcc');

    await fireEvent.click(nav[2]!);
    expect(view.container.querySelectorAll('.friend-row')).toHaveLength(1);
    expect(view.container.textContent).toContain('Bridge user');
  });

  it('shows the online empty state when only offline friends exist, while All still exposes them', async () => {
    registerApi(async (url) => url.endsWith('/pending')
      ? json([])
      : json([{ _id: 'u1', username: 'offline-only', status: 'offline' }]));
    const view = await renderOpen();
    await waitFor(() => expect(friendsCache.size).toBe(1));
    expect(view.container.querySelectorAll('.friend-row')).toHaveLength(0);
    expect(view.container.querySelector('.empty')).not.toBeNull();

    await fireEvent.click(view.container.querySelectorAll('[role="tablist"] button')[1]!);
    expect(view.container.textContent).toContain('offline-only');
  });

  it('treats non-array responses as empty lists without leaking stale cache entries', async () => {
    friendsCache.set('stale', { _id: 'stale' });
    registerApi(async (url) => url.endsWith('/pending') ? json({ rows: [] }) : json({ users: [] }));
    const view = await renderOpen();
    await waitFor(() => expect(friendsCache.size).toBe(0));
    expect(view.container.querySelector('.empty')).not.toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('FriendsPanel load ordering and session isolation', () => {
  it('commits only the newest overlapping load', async () => {
    const friends = [deferred<Response>(), deferred<Response>()];
    const pending = [deferred<Response>(), deferred<Response>()];
    let friendCall = 0;
    let pendingCall = 0;
    registerApi((url) => url.endsWith('/pending') ? pending[pendingCall++]!.promise : friends[friendCall++]!.promise);
    const view = render(FriendsPanel);
    await waitFor(() => expect(friendCall).toBe(1));
    BridgeRegistry.call('showFriendsPanel');
    await waitFor(() => expect(friendCall).toBe(2));

    friends[1]!.resolve(json([{ _id: 'new', username: 'new', status: 'online' }]));
    pending[1]!.resolve(json([]));
    await waitFor(() => expect(view.container.textContent).toContain('new'));
    friends[0]!.resolve(json([{ _id: 'old', username: 'old', status: 'online' }]));
    pending[0]!.resolve(json([]));
    await Promise.resolve();
    await Promise.resolve();
    expect(friendsCache.has('new')).toBe(true);
    expect(friendsCache.has('old')).toBe(false);
  });

  it('contains missing API, HTTP, and malformed-JSON failures and recovers on retry', async () => {
    BridgeRegistry.unregister('apiFetch');
    const view = await renderOpen();
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('yüklenemedi'));

    registerApi(async (url) => url.endsWith('/pending') ? json([]) : new Response('no', { status: 503 }));
    BridgeRegistry.call('showFriendsPanel');
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('yüklenemedi'));

    registerApi(async (url) => url.endsWith('/pending') ? json([]) : new Response('{', { status: 200 }));
    BridgeRegistry.call('showFriendsPanel');
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('yüklenemedi'));

    registerApi(async (url) => url.endsWith('/pending') ? json([]) : json([{ _id: 'ok', username: 'recovered', status: 'online' }]));
    BridgeRegistry.call('showFriendsPanel');
    await waitFor(() => expect(view.container.textContent).toContain('recovered'));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('ignores an in-flight load after logout', async () => {
    const waitingFriends = deferred<Response>();
    const waitingPending = deferred<Response>();
    registerApi((url) => url.endsWith('/pending') ? waitingPending.promise : waitingFriends.promise);
    const view = render(FriendsPanel);
    await waitFor(() => expect(BridgeRegistry.get('showFriendsPanel')).toBeTypeOf('function'));
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    waitingFriends.resolve(json([{ _id: 'private', username: 'private', status: 'online' }]));
    waitingPending.resolve(json([]));
    await Promise.resolve();
    await Promise.resolve();
    expect(friendsCache.size).toBe(0);
    expect(view.container.querySelector('.friends-panel')).toBeNull();
  });
});

describe('FriendsPanel mutations', () => {
  it('ignores blank adds, locks double submission, and does not expose raw server error text', async () => {
    const post = deferred<Response>();
    const api = registerApi(async (url, options) => {
      if (options?.method === 'POST') return post.promise;
      return defaultHandler(url);
    });
    const view = await renderOpen();
    await fireEvent.click(view.container.querySelectorAll('[role="tablist"] button')[3]!);
    const form = view.container.querySelector('form')!;
    await fireEvent.submit(form);
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);

    const input = view.container.querySelector('#friend-username')!;
    await fireEvent.input(input, { target: { value: '  bea  ' } });
    await fireEvent.submit(form);
    await fireEvent.submit(form);
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(view.container.querySelector('button[type="submit"]')).toBeDisabled();
    post.resolve(json({ error: 'Blocked by policy' }, 403));
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('yetkin yok'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).not.toContain('Blocked by policy');
    expect(view.container.querySelector('button[type="submit"]')).not.toBeDisabled();
  });

  it('uses a safe fallback for malformed error bodies and contains network rejection', async () => {
    let attempt = 0;
    registerApi(async (url, options) => {
      if (!options?.method) return defaultHandler(url);
      attempt += 1;
      if (attempt === 1) return new Response('{', { status: 400 });
      throw new Error('offline');
    });
    const view = await renderOpen();
    await fireEvent.click(view.container.querySelectorAll('[role="tablist"] button')[3]!);
    const input = view.container.querySelector('#friend-username')!;
    await fireEvent.input(input, { target: { value: 'bea' } });
    await fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('İstek geçersiz'));
    await fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(attempt).toBe(2));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('gönderilemedi');
  });

  it('clears the input, switches to Pending, and reloads after a successful add', async () => {
    let added = false;
    const api = registerApi(async (url, options) => {
      if (options?.method === 'POST') { added = true; return json({ ok: true }, 201); }
      if (url.endsWith('/pending')) return json(added ? [{ _id: 'r1', userId: 'bea' }] : []);
      return json([]);
    });
    const view = await renderOpen();
    await fireEvent.click(view.container.querySelectorAll('[role="tablist"] button')[3]!);
    const input = view.container.querySelector('#friend-username') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'bea' } });
    await fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.textContent).toContain('Bekleyen (1)'));
    expect(view.container.querySelector('#friend-username')).toBeNull();
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/friends/request'), expect.objectContaining({
      method: 'POST', body: JSON.stringify({ username: 'bea' }),
    }));
  });

  it('handles accept success and decline HTTP/network failures without duplicate mutation', async () => {
    let requests = [
      { _id: 'r/1', userId: 'u1', sender: { _id: 'u1', displayName: 'Ada' } },
      { _id: 'r2', userId: 'u2', sender: { _id: 'u2', username: 'Bea' } },
    ];
    let actionMode: 'success' | 'http' | 'network' = 'success';
    const api = registerApi(async (url, options) => {
      if (url.endsWith('/pending')) return json(requests);
      if (!options?.method) return json([]);
      if (actionMode === 'http') return json({}, 500);
      if (actionMode === 'network') throw new Error('offline');
      requests = requests.filter((request) => request._id !== 'r/1');
      return json({ ok: true });
    });
    const view = await renderOpen();
    await fireEvent.click(view.container.querySelectorAll('[role="tablist"] button')[2]!);
    await waitFor(() => expect(view.container.textContent).toContain('Ada'));
    await fireEvent.click([...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Kabul')!);
    await waitFor(() => expect(view.container.textContent).not.toContain('Ada'));
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/friends/r%2F1/accept'), { method: 'POST' });

    actionMode = 'http';
    await fireEvent.click([...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Reddet')!);
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('güncellenemedi'));
    expect(view.container.textContent).toContain('Bea');

    actionMode = 'network';
    await fireEvent.click([...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Reddet')!);
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('güncellenemedi'));
  });

  it('does not let a pre-logout mutation reload or unlock the next session', async () => {
    const oldPost = deferred<Response>();
    let postCalls = 0;
    const api = registerApi(async (url, options) => {
      if (options?.method === 'POST') { postCalls += 1; return oldPost.promise; }
      return defaultHandler(url);
    });
    const view = await renderOpen();
    await fireEvent.click(view.container.querySelectorAll('[role="tablist"] button')[3]!);
    await fireEvent.input(view.container.querySelector('#friend-username')!, { target: { value: 'old-user-request' } });
    await fireEvent.submit(view.container.querySelector('form')!);
    expect(postCalls).toBe(1);
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));

    BridgeRegistry.call('showFriendsPanel');
    await waitFor(() => expect(view.container.querySelector('.friends-panel')).not.toBeNull());
    oldPost.resolve(json({ ok: true }, 201));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.container.textContent).not.toContain('Bekleyen (1)');
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
});

describe('FriendsPanel shell contracts', () => {
  it('delegates Group DM, supports registered hide/open aliases, and closes on Escape', async () => {
    const showGroupDm = vi.fn();
    BridgeRegistry.register('showGroupDmPanel', showGroupDm);
    const view = await renderOpen();
    await fireEvent.click(view.container.querySelector('.gdm-entry')!);
    expect(showGroupDm).toHaveBeenCalledOnce();

    BridgeRegistry.call('hideFriendsPanel');
    await waitFor(() => expect(view.container.querySelector('.friends-panel')).toBeNull());
    BridgeRegistry.call('openFriendsPanel');
    await waitFor(() => expect(view.container.querySelector('.friends-panel')).not.toBeNull());
    await fireEvent.keyDown(window, { key: 'Enter' });
    expect(view.container.querySelector('.friends-panel')).not.toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.container.querySelector('.friends-panel')).toBeNull();
  });

  it('unregisters all owners and ignores lifecycle events after teardown', async () => {
    const api = BridgeRegistry.get<ReturnType<typeof vi.fn>>('apiFetch')!;
    const view = await renderOpen();
    const callsBefore = api.mock.calls.length;
    view.unmount();
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    await Promise.resolve();
    expect(api.mock.calls).toHaveLength(callsBefore);
    expect(BridgeRegistry.get('showFriendsPanel')).toBeNull();
    expect(BridgeRegistry.get('openFriendsPanel')).toBeNull();
    expect(BridgeRegistry.get('hideFriendsPanel')).toBeNull();
  });
});
