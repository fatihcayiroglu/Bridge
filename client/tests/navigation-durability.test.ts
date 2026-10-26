// #490: Android navigation preferences are durable only after a native commit
// acknowledgment, and the durable copy wins over a rolled-back localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetNavigationOwner, inspectChannelDurability, inspectServerDurability, lastServer, lastTextChannel,
  navigationDurabilityStatus, navigationPreferencesReady, rememberServer, rememberTextChannel,
  resetNavigationSelectionForTests,
} from '../js/core/navigation-selection.ts';
import { markLocalAccountErased, resetErasedLocalAccountsForTests } from '../js/core/local-first/erased-accounts.ts';

const P = 'bridge:last-navigation:v1';
const channelKey = (u: string, s: string) => `${P}:channel:${u}:${s}`;
const serverKey = (u: string) => `${P}:server:${u}`;

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake native store: `disk` changes only when a commit is acknowledged. */
function installNative(options: { manual?: boolean; failWith?: string; readAll?: () => Promise<unknown> } = {}) {
  const disk = new Map<string, string>();
  const pending: Array<{ key: string; value: string | null; done: Deferred<{ committed: boolean }> }> = [];
  let concurrent = 0; let maxConcurrent = 0;
  const calls: Array<{ key: string; value: string | null }> = [];
  const commit = (key: string, value: string | null) => { if (value === null) disk.delete(key); else disk.set(key, value); };
  const plugin = {
    write: vi.fn(async ({ key, value }: { key: string; value: string | null }) => {
      calls.push({ key, value });
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (options.failWith) throw Object.assign(new Error('native'), { code: options.failWith });
        if (options.manual) {
          const done = deferred<{ committed: boolean }>();
          pending.push({ key, value, done });
          return await done.promise;
        }
        commit(key, value);
        return { committed: true };
      } finally { concurrent--; }
    }),
    readAll: vi.fn(options.readAll ?? (async () => ({ entries: Object.fromEntries(disk), processFirstRead: true }))),
    forgetOwner: vi.fn(async ({ owner }: { owner: string }) => {
      for (const k of [...disk.keys()]) {
        if (k === serverKey(owner) || k.startsWith(`${P}:channel:${owner}:`)) disk.delete(k);
      }
      return { committed: true };
    }),
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    getPlatform: () => 'android', isPluginAvailable: (n: string) => n === 'BridgeNavigationStore',
    Plugins: { BridgeNavigationStore: plugin },
  };
  return {
    plugin, disk, calls, get maxConcurrent() { return maxConcurrent; },
    /** Acknowledge (or fail) the oldest pending native commit. */
    async settle(ok = true) {
      const next = pending.shift();
      if (!next) throw new Error('no pending native write');
      if (ok) { commit(next.key, next.value); next.done.resolve({ committed: true }); } else {
        next.done.reject(Object.assign(new Error('native'), { code: 'commit_failed' }));
      }
      await flush();
    },
    pendingCount: () => pending.length,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  resetNavigationSelectionForTests();
  resetErasedLocalAccountsForTests();
});
afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.useRealTimers();
});

describe('#490 browser and Electron keep localStorage-only behaviour', () => {
  it('never claims native durability without the Android plugin', async () => {
    rememberTextChannel('u1', 's1', 'c1');
    await navigationPreferencesReady();
    expect(localStorage.getItem(channelKey('u1', 's1'))).toBe('c1');
    expect(lastTextChannel('u1', 's1')).toBe('c1');
    expect(inspectChannelDurability('u1', 's1', 'c1')).toBe('unavailable');
    expect(navigationDurabilityStatus()).toMatchObject({ native: 'unavailable', requested: 0, boot: { state: 'unavailable' } });
  });

  it('treats an iOS Capacitor runtime as WebView-only (no Android plugin)', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'ios', Plugins: {} };
    rememberServer('u1', 's1');
    expect(inspectServerDurability('u1', 's1')).toBe('unavailable');
  });
});

describe('#490 acknowledged native persistence', () => {
  it('is pending until the native commit returns, then acknowledged', async () => {
    const native = installNative({ manual: true });
    rememberTextChannel('u1', 's1', 'c1');
    await flush();
    // Negative control: a returned setItem() and a sent native call are NOT durability.
    expect(localStorage.getItem(channelKey('u1', 's1'))).toBe('c1');
    expect(inspectChannelDurability('u1', 's1', 'c1')).toBe('pending');
    expect(native.disk.size).toBe(0);
    await native.settle();
    expect(inspectChannelDurability('u1', 's1', 'c1')).toBe('acknowledged');
    expect(native.disk.get(channelKey('u1', 's1'))).toBe('c1');
    expect(navigationDurabilityStatus()).toMatchObject({ native: 'available', requested: 1, acknowledged: 1, failed: 0 });
  });

  it('reports a native commit failure explicitly and never acknowledges it', async () => {
    const native = installNative({ manual: true });
    rememberTextChannel('u1', 's1', 'c1');
    await flush();
    await native.settle(false);
    expect(inspectChannelDurability('u1', 's1', 'c1')).toBe('failed');
    expect(navigationDurabilityStatus()).toMatchObject({ acknowledged: 0, failed: 1, lastFailureCode: 'commit_failed' });
    // The next selection retries and can succeed.
    rememberTextChannel('u1', 's1', 'c2');
    await flush();
    await native.settle();
    expect(inspectChannelDurability('u1', 's1', 'c2')).toBe('acknowledged');
  });

  it('does not accept a resolved call without an explicit commit acknowledgment', async () => {
    const native = installNative();
    native.plugin.write.mockResolvedValueOnce({ committed: false } as never);
    rememberServer('u1', 's1');
    await flush();
    expect(inspectServerDurability('u1', 's1')).toBe('failed');
    expect(navigationDurabilityStatus().lastFailureCode).toBe('unverified');
  });

  it('serializes rapid consecutive selections and coalesces to the newest value', async () => {
    const native = installNative({ manual: true });
    for (let i = 0; i < 20; i++) rememberTextChannel('u1', 's1', `c${i}`);
    await flush();
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0]?.value).toBe('c0');
    await native.settle();
    expect(native.calls).toHaveLength(2);
    expect(native.calls[1]?.value).toBe('c19');
    expect(inspectChannelDurability('u1', 's1', 'c19')).toBe('pending');
    // c0 is durable right now; c19 is not yet.
    expect(inspectChannelDurability('u1', 's1', 'c0')).toBe('acknowledged');
    await native.settle();
    expect(native.maxConcurrent).toBe(1);
    expect(native.disk.get(channelKey('u1', 's1'))).toBe('c19');
    expect(inspectChannelDurability('u1', 's1', 'c19')).toBe('acknowledged');
    expect(lastTextChannel('u1', 's1')).toBe('c19');
  });

  it('never sends unsupported identifiers to native storage', async () => {
    const native = installNative();
    rememberTextChannel('user:with:colons', 's1', 'c1');
    rememberTextChannel('u1', 'server:with:colons', 'c1');
    rememberTextChannel('u1', 's1', 'c 1');
    await flush();
    expect(native.plugin.write).not.toHaveBeenCalled();
    expect(navigationDurabilityStatus().rejected).toBe(3);
    expect(inspectChannelDurability('u1', 's1', 'c 1')).toBe('failed');
  });
});

describe('#490 boot read: the durable copy wins over a rolled-back WebView', () => {
  it('repairs a rolled-back localStorage channel value before it is used', async () => {
    const native = installNative();
    native.disk.set(channelKey('u1', 's1'), 'c-new');
    native.disk.set(serverKey('u1'), 's1');
    // What the API 34 emulator showed after force-stop: same key, older value.
    localStorage.setItem(channelKey('u1', 's1'), 'c-old');
    localStorage.setItem(serverKey('u1'), 's1');
    await navigationPreferencesReady();
    expect(lastTextChannel('u1', 's1')).toBe('c-new');
    expect(localStorage.getItem(channelKey('u1', 's1'))).toBe('c-new');
    expect(lastServer('u1')).toBe('s1');
    expect(navigationDurabilityStatus().boot).toMatchObject({ state: 'hydrated', processFirstRead: true, entries: 2, repaired: 1 });
    expect(inspectChannelDurability('u1', 's1', 'c-new')).toBe('acknowledged');
  });

  it('serves the durable value even when localStorage repair is impossible', async () => {
    const native = installNative();
    native.disk.set(channelKey('u1', 's1'), 'c-new');
    localStorage.setItem(channelKey('u1', 's1'), 'c-old');
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await navigationPreferencesReady();
    set.mockRestore();
    expect(lastTextChannel('u1', 's1')).toBe('c-new');
  });

  it('a late boot read never overrides a newer selection made during the read', async () => {
    const read = deferred<unknown>();
    const native = installNative({ readAll: () => read.promise });
    native.disk.set(channelKey('u1', 's1'), 'c-stale');
    const ready = navigationPreferencesReady();
    rememberTextChannel('u1', 's1', 'c-user');
    read.resolve({ entries: { [channelKey('u1', 's1')]: 'c-stale' }, processFirstRead: true });
    await ready;
    await flush();
    expect(lastTextChannel('u1', 's1')).toBe('c-user');
    expect(localStorage.getItem(channelKey('u1', 's1'))).toBe('c-user');
    expect(native.disk.get(channelKey('u1', 's1'))).toBe('c-user');
  });

  it('keeps users and servers isolated and ignores malformed or erased entries', async () => {
    markLocalAccountErased('gone');
    installNative({ readAll: async () => ({ entries: {
      [channelKey('u1', 's1')]: 'c1',
      [channelKey('u2', 's1')]: 'c2',
      [channelKey('gone', 's1')]: 'c3',
      [serverKey('u1')]: 'x'.repeat(300),
      access_token: 'secret',
      [`${P}:channel:u1`]: 'broken',
    } }) });
    await navigationPreferencesReady();
    expect(lastTextChannel('u1', 's1')).toBe('c1');
    expect(lastTextChannel('u2', 's1')).toBe('c2');
    expect(lastTextChannel('u1', 's2')).toBeNull();
    expect(lastTextChannel('gone', 's1')).toBeNull();
    expect(lastServer('u1')).toBeNull();
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(navigationDurabilityStatus().boot.entries).toBe(2);
  });

  it('a hung native read is bounded and falls back to WebView storage', async () => {
    vi.useFakeTimers();
    installNative({ readAll: () => new Promise(() => { /* never settles */ }) });
    localStorage.setItem(channelKey('u1', 's1'), 'c1');
    const ready = navigationPreferencesReady();
    await vi.advanceTimersByTimeAsync(3000);
    await ready;
    expect(navigationDurabilityStatus().boot.state).toBe('timeout');
    expect(lastTextChannel('u1', 's1')).toBe('c1');
  });

  it('a failed native read is reported and never throws', async () => {
    installNative({ readAll: async () => { throw Object.assign(new Error('x'), { code: 'main_thread' }); } });
    await expect(navigationPreferencesReady()).resolves.toBeUndefined();
    expect(navigationDurabilityStatus()).toMatchObject({ boot: { state: 'failed' }, lastFailureCode: 'main_thread' });
  });

  it('makes preferences saved before the native store existed durable', async () => {
    const native = installNative();
    localStorage.setItem(channelKey('u1', 's1'), 'c-legacy');
    // Ambiguous legacy key (colon owner or colon server): never migrated.
    localStorage.setItem(channelKey('user:x', 's1'), 'c-ambiguous');
    await navigationPreferencesReady();
    await flush();
    expect(native.disk.get(channelKey('u1', 's1'))).toBe('c-legacy');
    expect(navigationDurabilityStatus().boot.migrated).toBe(1);
  });
});

describe('#490 account erasure and diagnostics privacy', () => {
  it('forgets one account everywhere and keeps other accounts', async () => {
    const native = installNative();
    rememberServer('u1', 's1');
    rememberTextChannel('u1', 's1', 'c1');
    rememberTextChannel('u2', 's1', 'c2');
    await flush();
    expect(await forgetNavigationOwner('u1')).toBe(true);
    expect(lastServer('u1')).toBeNull();
    expect(lastTextChannel('u1', 's1')).toBeNull();
    expect(localStorage.getItem(channelKey('u1', 's1'))).toBeNull();
    expect([...native.disk.keys()]).toEqual([channelKey('u2', 's1')]);
    expect(lastTextChannel('u2', 's1')).toBe('c2');
  });

  it('reports a failed native removal so the erasure sweep repeats', async () => {
    const native = installNative();
    native.plugin.forgetOwner.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'commit_failed' }));
    expect(await forgetNavigationOwner('u1')).toBe(false);
  });

  it('diagnostics never contain identifiers or stored values', async () => {
    installNative();
    rememberServer('user-secret-id', 'server-secret-id');
    rememberTextChannel('user-secret-id', 'server-secret-id', 'channel-secret-id');
    await navigationPreferencesReady();
    await flush();
    const text = JSON.stringify(navigationDurabilityStatus()) +
      JSON.stringify((window as unknown as { __bridgeNavigationDurabilityV1: { status(): unknown } }).__bridgeNavigationDurabilityV1.status());
    expect(text).not.toMatch(/secret/);
    expect(text).not.toMatch(/bridge:last-navigation/);
  });
});
