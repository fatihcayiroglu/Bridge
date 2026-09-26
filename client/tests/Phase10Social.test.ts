import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DmPanel from '../js/core/DmPanel.svelte';
import FriendsPanel from '../js/core/FriendsPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry';

afterEach(() => {
  cleanup();
  for (const key of ['apiFetch', 'socket', 'getMe', 'recordNavigationLocation', 'showDmPanel', 'openDmPanel', 'openDm', 'closeDmPanel', 'showFriendsPanel', 'openFriendsPanel', 'hideFriendsPanel']) BridgeRegistry.unregister(key);
});

describe('Phase 10 social owners', () => {
  let apiFetch: ReturnType<typeof vi.fn>;
  let socket: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    apiFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/api/dm')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/api/dm/') && url.includes('/messages')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith('/api/friends')) return new Response(JSON.stringify([{ _id: 'u2', username: 'ada', displayName: 'Ada', status: 'online' }]), { status: 200 });
      if (url.endsWith('/api/friends/pending')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ _id: 'dm-1', dmId: 'dm-1', other: { _id: 'u2', username: 'ada', displayName: 'Ada' } }), { status: 200 });
    });
    socket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    BridgeRegistry.register('apiFetch', apiFetch);
    BridgeRegistry.register('socket', socket);
    BridgeRegistry.register('getMe', () => ({ id: 'u1', displayName: 'Me' }));
    BridgeRegistry.register('recordNavigationLocation', vi.fn());
  });

  it('mounts a real DM owner and opens a server-backed conversation', async () => {
    const view = render(DmPanel);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/dm'), undefined));
    const opened = await BridgeRegistry.call<Promise<boolean>>('openDm', 'u2', 'Ada');
    await waitFor(() => expect(view.container.querySelector('textarea')).toBeTruthy());
    expect(opened).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/dm/u2'), { method: 'POST' });
    const input = view.container.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: 'Merhaba Ada' } });
    await fireEvent.submit(view.container.querySelector('form')!);
    // Gonderim artik idempotent eslestirme icin bir `clientNonce` tasir.
    expect(socket.emit).toHaveBeenCalledWith('dm:send', expect.objectContaining({
      toUserId: 'u2', content: 'Merhaba Ada', clientNonce: expect.any(String),
    }));
    expect(BridgeRegistry.get<ReturnType<typeof vi.fn>>('recordNavigationLocation')).toHaveBeenCalledWith({
      type: 'dm', user: { _id: 'u2', displayName: 'Ada', avatarColor: undefined },
    });
  });

  it('revoked DM history target returns false and does not restore the private shell', async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/dm')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/messages')) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
      return new Response(JSON.stringify({
        _id: 'dm-1', dmId: 'dm-1', other: { _id: 'u2', displayName: 'Ada' },
      }), { status: 200 });
    });
    const record = BridgeRegistry.get<ReturnType<typeof vi.fn>>('recordNavigationLocation')!;
    const view = render(DmPanel);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/dm'), undefined));

    const opened = await BridgeRegistry.call<Promise<boolean>>('openDm', 'u2', 'Ada');

    expect(opened).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(view.container.textContent).toContain('Bu konuşma artık kullanılamıyor.');
  });

  it('loads friends and sends a friend request through the real API owner', async () => {
    const view = render(FriendsPanel);
    BridgeRegistry.call('showFriendsPanel');
    await waitFor(() => expect(view.container.textContent).toContain('Ada'));
    // Filtre serisi `<nav>` degil, `role="tablist"` tasiyan bir kapsayicidir
    // (bir yer isareti ogesine 'tablist' rolu vermek a11y ihlaliydi).
    const add = view.container.querySelectorAll('[role="tablist"] button')[3] as HTMLButtonElement;
    await fireEvent.click(add);
    const input = view.container.querySelector('#friend-username') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'bea' } });
    await fireEvent.submit(view.container.querySelector('form')!);
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/friends/request'), expect.objectContaining({ method: 'POST' }));
  });

  it('replaces legacy social planes with canonical mount points', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('id="dm-root"');
    expect(html).toContain('id="friends-root"');
    expect(html).toContain('data-bridge-action="openServerStart"');
    expect(html).not.toContain('id="server-list" aria-disabled="true"');
    expect(html).not.toContain('onclick="switchDmTab');
    expect(html).not.toContain('onclick="switchFriendsTab');
  });
});
