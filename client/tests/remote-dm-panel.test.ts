import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import RemoteDmPanel from '../js/core/RemoteDmPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

const actorUrl = 'https://remote.example/users/bob';
const threadId = Buffer.from(actorUrl).toString('base64url');
const conversation = {
  _id: `ap:${threadId}`, dmId: `ap:${threadId}`, threadId, federated: true as const, actorUrl,
  other: { _id: `ap:${threadId}`, username: 'bob@remote.example', displayName: '@bob@remote.example' },
  lastMessage: { _id: 'in-1', dmId: `ap:${threadId}`, userId: `ap:${threadId}`, content: 'hello', direction: 'in' as const, createdAt: 1000 },
};

let apiFetch: ReturnType<typeof vi.fn>;
async function flush(rounds = 6) { for (let i = 0; i < rounds; i += 1) { await tick(); await Promise.resolve(); } }

beforeEach(() => {
  document.body.innerHTML = '<button data-bridge-action="showDmPanel" class="shell-dm">DM</button>';
  apiFetch = vi.fn(async (urlValue: unknown, options?: RequestInit) => {
    const url = String(urlValue);
    if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
    if (options?.method === 'POST') return new Response(JSON.stringify({
      _id: 'out-1', dmId: `ap:${threadId}`, userId: 'me', displayName: 'Alice', content: 'reply', direction: 'out', createdAt: 2000,
    }), { status: 201 });
    if (url.includes(`/api/federation/remote-dms/${threadId}/messages`)) return new Response(JSON.stringify([conversation.lastMessage]), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
});

afterEach(() => {
  cleanup();
  for (const key of ['apiFetch', 'showRemoteDmPanel']) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('RemoteDmPanel', () => {
  it('loads a recipient-scoped thread, sends a reply, and blocks over-limit content client-side', async () => {
    render(RemoteDmPanel);
    await waitFor(() => expect(BridgeRegistry.get('showRemoteDmPanel')).toBeTruthy());
    BridgeRegistry.call('showRemoteDmPanel');
    await waitFor(() => expect(document.querySelector('.remote-dm-conversation')).not.toBeNull());
    (document.querySelector<HTMLButtonElement>('.remote-dm-conversation'))!.click();
    await waitFor(() => expect(document.querySelector('.remote-dm-message')?.textContent).toContain('hello'));

    const box = document.querySelector<HTMLTextAreaElement>('.remote-dm-composer textarea')!;
    await fireEvent.input(box, { target: { value: 'reply' } });
    await flush(2);
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await waitFor(() => expect([...document.querySelectorAll('.remote-dm-message')].some(n => n.textContent?.includes('reply'))).toBe(true));
    expect(apiFetch.mock.calls.some(([, options]) => (options as RequestInit | undefined)?.method === 'POST')).toBe(true);

    apiFetch.mockClear();
    await fireEvent.input(box, { target: { value: 'x'.repeat(2001) } });
    await flush(2);
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await flush();
    expect(apiFetch.mock.calls.some(([, options]) => (options as RequestInit | undefined)?.method === 'POST')).toBe(false);
    expect(document.querySelector('.remote-dm-error')?.textContent).toContain('2000');
  });
});
