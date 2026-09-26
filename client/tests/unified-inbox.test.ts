import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import InboxPanel from '../js/core/InboxPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const responseBody = {
  items: [
    {
      id: 'mention-1', kind: 'mention', unreadCount: 1, createdAt: Date.now(),
      preview: 'Please review this change', sender: { _id: 'sender', displayName: 'Alice', avatarColor: '#123456' },
      destination: {
        type: 'channel', messageId: 'message-1', channelId: 'channel-1', serverId: 'server-1',
        channel: { _id: 'channel-1', name: 'general', type: 'text' },
        server: { _id: 'server-1', name: 'Bridge Team' },
      },
    },
    {
      id: 'dm:dm-1', kind: 'dm', unreadCount: 2, createdAt: Date.now() - 1000,
      preview: 'Direct attention', sender: { _id: 'peer-1', displayName: 'Mehmet', avatarColor: '#654321' },
      destination: { type: 'dm', dmId: 'dm-1', user: { _id: 'peer-1', displayName: 'Mehmet', avatarColor: '#654321' } },
    },
  ],
  counts: { all: 3, mentions: 1, replies: 0, dms: 2 },
  filter: 'all',
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  document.body.innerHTML = '<button data-bridge-action="showInbox" aria-label="Inbox\'u aç"></button>';
});

afterEach(() => {
  cleanup();
  for (const key of ['apiFetch', 'socket', 'showInbox', 'openInbox', 'markAllRead', 'navigateToChannel', 'openDm', 'groupDmPanel:openGroupDm', 'toast']) {
    BridgeRegistry.unregister(key);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Unified Inbox panel', () => {
  it('derives the shell badge and compact filters from the canonical response', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(responseBody)));
    const view = render(InboxPanel);

    await waitFor(() => expect(document.querySelector('[data-bridge-action="showInbox"] .h-unread')?.textContent).toBe('3'));
    BridgeRegistry.call('showInbox');

    await waitFor(() => expect(view.getByRole('dialog', { name: 'Gelen kutusu' })).toBeTruthy());
    expect(view.getByRole('button', { name: /^Tümü 3$/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^Bahsetmeler 1$/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^Yanıtlar 0$/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^DM'ler 2$/ })).toBeTruthy();
    expect(view.getByText('Bridge Team · #general')).toBeTruthy();
    expect(view.getByText('Mehmet')).toBeTruthy();
  });

  it('delegates channel navigation with the canonical server/channel/message identities', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(responseBody)));
    const navigate = vi.fn();
    BridgeRegistry.register('navigateToChannel', navigate);
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');

    const item = await view.findByText('Bridge Team · #general');
    await fireEvent.click(item.closest('button')!);

    expect(navigate).toHaveBeenCalledWith(
      'channel-1', 'message-1', { _id: 'server-1', name: 'Bridge Team' },
    );
  });

  it('delegates DM navigation without creating a second conversation owner', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(responseBody)));
    const openDm = vi.fn();
    BridgeRegistry.register('openDm', openDm);
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');

    const item = await view.findByText('Direct attention');
    await fireEvent.click(item.closest('button')!);

    expect(openDm).toHaveBeenCalledWith('peer-1', 'Mehmet', '#654321');
  });

  it('mark-all-read uses the server mutation and clears the badge', async () => {
    const api = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/read-all') && options?.method === 'PATCH') return jsonResponse({ read: true });
      return jsonResponse(responseBody);
    });
    BridgeRegistry.register('apiFetch', api);
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');

    await fireEvent.click(await view.findByRole('button', { name: 'Tümünü okundu yap' }));

    await waitFor(() => expect(document.querySelector('[data-bridge-action="showInbox"] .h-unread')).toBeNull());
    expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/inbox/read-all'), { method: 'PATCH' });
  });

  it('renders snippets as text, never as executable markup', async () => {
    const malicious = structuredClone(responseBody);
    malicious.items[0].preview = '<img src=x onerror="globalThis.__inboxXss=1">';
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(malicious)));
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');

    await view.findByText(malicious.items[0].preview);
    expect(view.container.querySelector('.item-preview img')).toBeNull();
    expect((globalThis as { __inboxXss?: number }).__inboxXss).toBeUndefined();
  });
});
