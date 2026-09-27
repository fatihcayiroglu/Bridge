import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SavedPanel from '../js/core/SavedPanel.svelte';
import MessageRenderer from '../js/core/MessageRenderer.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const savedResponse = {
  count: 3,
  items: [
    {
      id: 'saved-channel', savedAt: Date.now(), unavailable: false,
      preview: 'Review the launch checklist', sender: { _id: 'sender', displayName: 'Alice', avatarColor: '#123456' },
      destination: {
        type: 'channel', messageId: 'message-1', channelId: 'channel-1', serverId: 'server-1',
        channel: { _id: 'channel-1', name: 'launch' }, server: { _id: 'server-1', name: 'Bridge Team' },
      },
    },
    {
      id: 'saved-dm', savedAt: Date.now() - 1000, unavailable: false,
      preview: 'Direct follow-up', sender: { _id: 'peer', displayName: 'Mehmet' },
      destination: { type: 'dm', messageId: 'dm-message-1', dmId: 'dm-1', user: { _id: 'peer', displayName: 'Mehmet', avatarColor: '#654321' } },
    },
    { id: 'saved-unavailable', savedAt: Date.now() - 2000, unavailable: true },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  for (const key of ['apiFetch', 'showSaved', 'openSaved', 'saveForLater', 'navigateToChannel', 'openDm', 'groupDmPanel:openGroupDm', 'toast']) {
    BridgeRegistry.unregister(key);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Saved / Follow-up panel', () => {
  it('renders personal message context, safe unavailable state and keyboard navigation', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(savedResponse)));
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await view.findByRole('dialog', { name: t('saved_title') });
    expect(view.getByText('Bridge Team · #launch')).toBeTruthy();
    expect(view.getAllByText('Mehmet')).toHaveLength(2);
    expect(view.getByText('Mesaj artık kullanılamıyor')).toBeTruthy();

    const first = view.getByText('Review the launch checklist').closest('button')!;
    const second = view.getByText('Direct follow-up').closest('button')!;
    first.focus();
    await fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
  });

  it('delegates canonical channel and DM message destinations including target ids', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(savedResponse)));
    const navigate = vi.fn();
    const openDm = vi.fn();
    BridgeRegistry.register('navigateToChannel', navigate);
    BridgeRegistry.register('openDm', openDm);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await fireEvent.click((await view.findByText('Review the launch checklist')).closest('button')!);
    expect(navigate).toHaveBeenCalledWith('channel-1', 'message-1', { _id: 'server-1', name: 'Bridge Team' });

    BridgeRegistry.call('showSaved');
    await fireEvent.click((await view.findByText('Direct follow-up')).closest('button')!);
    expect(openDm).toHaveBeenCalledWith('peer', 'Mehmet', '#654321', 'dm-message-1');
  });

  it('saves identifiers only and unsaves only the selected personal row', async () => {
    const api = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return jsonResponse({ saved: true, created: true }, 201);
      if (options?.method === 'DELETE') return jsonResponse({}, 204);
      return jsonResponse(savedResponse);
    });
    BridgeRegistry.register('apiFetch', api);
    BridgeRegistry.register('toast', vi.fn());
    const view = render(SavedPanel);

    const result = await BridgeRegistry.call<Promise<boolean>>('saveForLater', {
      destinationType: 'channel', destinationId: 'channel-1', messageId: 'message-1',
    });
    expect(result).toBe(true);
    const post = api.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      destinationType: 'channel', destinationId: 'channel-1', messageId: 'message-1',
    });
    expect(String(post?.[1]?.body)).not.toContain('Review the launch checklist');

    BridgeRegistry.call('showSaved');
    const removeButtons = await view.findAllByRole('button', { name: 'Saved listesinden kaldır' });
    await fireEvent.click(removeButtons[0]!);
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining('/api/saved/saved-channel'), { method: 'DELETE' }));
  });

  it('renders untrusted snippets as text and exposes Save for Later on messages', async () => {
    const malicious = structuredClone(savedResponse);
    malicious.items[0].preview = '<img src=x onerror="globalThis.__savedXss=1">';
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(malicious)));
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await view.findByText(malicious.items[0].preview);
    expect(view.container.querySelector('.saved-preview img')).toBeNull();
    expect((globalThis as { __savedXss?: number }).__savedXss).toBeUndefined();

    cleanup();
    const onSave = vi.fn();
    const message = render(MessageRenderer, {
      props: { message: { _id: 'm1', content: 'follow up', userId: 'u1' }, currentUserId: 'u2', onSave },
    });
    await fireEvent.click(message.getByRole('button', { name: t('msg_action_save') }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm1' }));
  });
});
