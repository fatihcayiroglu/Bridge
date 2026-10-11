import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  navigationOwner, rememberServer, lastServer, rememberTextChannel, lastTextChannel,
} from '../js/core/navigation-selection.ts';

beforeEach(() => localStorage.clear());

describe('WebView navigation restoration — user-scoped only', () => {
  it('keeps distinct server and channel selections for each account and server', () => {
    rememberServer('u1', 'server-a');
    rememberTextChannel('u1', 'server-a', 'general');
    rememberTextChannel('u1', 'server-b', 'design');
    rememberServer('u2', 'server-b');
    rememberTextChannel('u2', 'server-b', 'private');

    expect(lastServer('u1')).toBe('server-a');
    expect(lastServer('u2')).toBe('server-b');
    expect(lastTextChannel('u1', 'server-a')).toBe('general');
    expect(lastTextChannel('u1', 'server-b')).toBe('design');
    expect(lastTextChannel('u2', 'server-b')).toBe('private');
    expect(lastTextChannel('u2', 'server-a')).toBeNull();
    expect(lastTextChannel(null, 'server-a')).toBeNull();
  });

  it('does not store anything before the authenticated user is known', () => {
    expect(navigationOwner(null)).toBeNull();
    expect(navigationOwner({ username: 'user-without-id' })).toBeNull();
    expect(navigationOwner({ id: 'u1' })).toBe('u1');
    expect(navigationOwner({ _id: 'u2' })).toBe('u2');
    rememberServer(null, 'server-a');
    rememberTextChannel(null, 'server-a', 'general');
    expect(localStorage.length).toBe(0);
  });

  it('rejects malformed and oversized persisted IDs without crashing', () => {
    rememberServer('u1', 'x'.repeat(257));
    rememberTextChannel('u1', 'server-a', 'x'.repeat(257));
    expect(lastServer('u1')).toBeNull();
    expect(lastTextChannel('u1', 'server-a')).toBeNull();
    localStorage.setItem('bridge:last-navigation:v1:server:u1', 'x'.repeat(257));
    expect(lastServer('u1')).toBeNull();
  });

  it('tolerates blocked localStorage access', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    expect(() => rememberServer('u1', 'server-a')).not.toThrow();
    expect(() => rememberTextChannel('u1', 'server-a', 'c1')).not.toThrow();
    expect(lastServer('u1')).toBeNull();
    expect(lastTextChannel('u1', 'server-a')).toBeNull();
    get.mockRestore();
    set.mockRestore();
  });
});
