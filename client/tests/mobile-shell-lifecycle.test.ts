import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: {
    register: (key: string, fn: (...args: unknown[]) => unknown) => { registry.set(key, fn); },
    unregister: (key: string) => { registry.delete(key); },
    has: (key: string) => registry.has(key),
    get: (key: string) => registry.get(key) ?? null,
    call: (key: string, ...args: unknown[]) => registry.get(key)?.(...args),
  },
}));

beforeEach(() => {
  registry.clear();
  document.body.innerHTML = `
    <div class="server-list"></div><div class="channel-sidebar"></div>
    <div class="member-list is-collapsed"></div>
    <div id="mobile-backdrop"></div>
  `;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
  Object.defineProperty(window, 'Capacitor', { configurable: true, writable: true, value: undefined });
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mobile shell module lifecycle', () => {
  it('loading belgede DOMContentLoaded, socket ve auth bariyerlerinde adapteri kurar', async () => {
    vi.useFakeTimers();
    const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');

    await import('../js/mobile.ts');
    expect(registry.has('toggleMemberList')).toBe(true);

    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    document.dispatchEvent(new Event('bridge:socket-ready'));
    await Promise.resolve();
    document.dispatchEvent(new Event('bridge:auth-success'));
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.has('toggleMemberList')).toBe(true);
    ready.mockRestore();
  });

  it('native Capacitor ortaminda web swipe dinleyicilerini kurmaz', async () => {
    const native = vi.fn(() => true);
    Object.defineProperty(window, 'Capacitor', {
      configurable: true, writable: true, value: { isNativePlatform: native },
    });
    const add = vi.spyOn(document, 'addEventListener');

    await import('../js/mobile.ts');

    expect(native).toHaveBeenCalledOnce();
    expect(add.mock.calls.some(([type]) => type === 'touchstart')).toBe(false);
    expect(add.mock.calls.some(([type]) => type === 'touchmove')).toBe(false);
  });
});
