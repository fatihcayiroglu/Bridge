import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';

const registry = new Map<string, unknown>();
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: (key: string, value: unknown) => registry.set(key, value),
    unregister: (key: string) => registry.delete(key),
    get: (key: string) => registry.get(key) ?? null,
    has: (key: string) => registry.has(key),
    call: (key: string, ...args: unknown[]) => {
      const value = registry.get(key);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value;
    },
  },
}));

import UnreadBadge from '../js/core/UnreadBadge.svelte';

const call = (key: string, ...args: unknown[]) => {
  const value = registry.get(key) as ((...a: unknown[]) => unknown) | undefined;
  if (!value) throw new Error(`missing registry owner: ${key}`);
  return value(...args);
};

beforeEach(() => {
  registry.clear();
  document.head.innerHTML = '<link rel="icon" href="/favicon.ico">';
  document.body.innerHTML = '';
  document.title = 'stale title';
});
afterEach(() => { cleanup(); registry.clear(); });

describe('UnreadBadge component owner', () => {
  it('publishes registry owners and keeps aggregate badge/title/favicon in sync', async () => {
    const view = render(UnreadBadge);
    expect(document.title).toBe('Bridge');
    call('setChannelUnread', 'c-1', 3, false);
    await Promise.resolve();
    expect(view.getByRole('status')).toHaveTextContent('3');
    expect(call('getUnreadCount')).toBe(3);
    expect(document.title).toBe('(3) Bridge');
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toContain('/favicon-unread.ico');

    call('setDmUnread', 2);
    await Promise.resolve();
    expect(view.getByRole('status')).toHaveTextContent('5');
    expect(document.title).toBe('(5) Bridge');

    call('clearChannelUnread', 'c-1');
    await Promise.resolve();
    expect(view.getByRole('status')).toHaveTextContent('2');
  });

  it('prioritizes mention-channel state and caps visible counts without losing exact aggregate state', async () => {
    const view = render(UnreadBadge);
    call('setChannelUnread', 'c-1', 80, true);
    call('setChannelUnread', 'c-2', 40, true);
    call('setDmUnread', 30);
    await Promise.resolve();
    expect(view.getByRole('status')).toHaveClass('mention');
    expect(view.getByRole('status')).toHaveTextContent('2');
    expect(call('getMentionCount')).toBe(2);
    expect(call('getUnreadCount')).toBe(150);
    expect(document.title).toBe('(99+) Bridge');
  });

  it('fails closed on malformed counts and still updates the title when no favicon link exists', async () => {
    const view = render(UnreadBadge);
    document.querySelector('link[rel="icon"]')?.remove();
    call('setChannelUnread', 'bad', Number.NaN, true);
    call('setDmUnread', -4);
    await Promise.resolve();
    expect(view.queryByRole('status')).toBeNull();
    expect(call('getUnreadCount')).toBe(0);
    expect(document.title).toBe('Bridge');

    call('setChannelUnread', 'c-1', 1, false);
    await Promise.resolve();
    expect(document.title).toBe('(1) Bridge');
  });

  it('unregisters only the registry functions it still owns on destroy', async () => {
    const first = render(UnreadBadge);
    const original = registry.get('setDmUnread');
    const replacement = vi.fn();
    registry.set('setDmUnread', replacement);
    first.unmount();
    await Promise.resolve();
    expect(registry.get('setDmUnread')).toBe(replacement);
    expect(registry.has('setChannelUnread')).toBe(false);
    expect(original).not.toBe(replacement);
  });
});
