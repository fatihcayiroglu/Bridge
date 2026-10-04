import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import RemoteDmPanel from '../js/core/RemoteDmPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let apiFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiFetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      return jsonResponse({ ok: true, id: 'create-1', noteId: 'note-1' }, 202);
    }
    return jsonResponse({
      items: [{
        id: 'remote-1',
        apId: 'https://remote.test/notes/1',
        actorUrl: 'https://remote.test/users/bob',
        content: 'hello from remote',
        published: Date.parse('2026-10-04T12:00:00Z'),
      }],
      total: 1,
      page: 1,
      limit: 100,
      pages: 1,
    });
  });
  BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
});

afterEach(() => {
  cleanup();
  for (const key of ['apiFetch', 'showRemoteDmPanel', 'hideRemoteDmPanel']) {
    BridgeRegistry.unregister(key);
  }
});

describe('RemoteDmPanel', () => {
  it('is hidden by default and loads the authenticated remote-DM feed when opened', async () => {
    const { queryByRole, getByText } = render(RemoteDmPanel);
    expect(queryByRole('dialog')).toBeNull();

    BridgeRegistry.call('showRemoteDmPanel');
    await tick();

    await waitFor(() => expect(queryByRole('dialog')).toBeTruthy());
    await waitFor(() => expect(getByText('hello from remote')).toBeTruthy());
    expect(getByText('bob@remote.test')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/federation/remote-dms?limit=100&page=1'), undefined);
  });

  it('posts a bounded direct message to the selected ActivityPub actor', async () => {
    const { getByLabelText, getByRole } = render(RemoteDmPanel);
    BridgeRegistry.call('showRemoteDmPanel');
    await tick();
    await waitFor(() => expect(getByRole('dialog')).toBeTruthy());

    const actor = getByLabelText('Uzak aktör adresi') as HTMLInputElement;
    const message = getByLabelText('DM mesajı') as HTMLTextAreaElement;
    await fireEvent.input(actor, { target: { value: 'https://remote.test/users/bob' } });
    await fireEvent.input(message, { target: { value: 'private hello' } });
    await fireEvent.click(getByRole('button', { name: 'Gönder' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const [, options] = apiFetch.mock.calls[1] as [string, RequestInit];
    expect(options.method).toBe('POST');
    expect(JSON.parse(String(options.body))).toEqual({
      actorUrl: 'https://remote.test/users/bob',
      content: 'private hello',
    });
    await waitFor(() => expect(getByRole('status').textContent).toContain('teslimat kuyruğuna alındı'));
  });

  it('Escape closes the dialog without deleting the loaded feed', async () => {
    const { queryByRole } = render(RemoteDmPanel);
    BridgeRegistry.call('showRemoteDmPanel');
    await tick();
    await waitFor(() => expect(queryByRole('dialog')).toBeTruthy());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(queryByRole('dialog')).toBeNull();
  });
});
