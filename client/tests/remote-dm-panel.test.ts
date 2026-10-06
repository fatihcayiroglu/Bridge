import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import RemoteDmPanel from '../js/core/RemoteDmPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

const actorUrl = 'https://remote.example/users/bob';
const threadId = Buffer.from(actorUrl).toString('base64url');
const conversation = {
  _id: `ap:${threadId}`, dmId: `ap:${threadId}`, threadId, federated: true as const, actorUrl,
  other: { _id: `ap:${threadId}`, username: 'bob@remote.example', displayName: '@bob@remote.example' },
  lastMessage: { _id: 'in-1', dmId: `ap:${threadId}`, userId: `ap:${threadId}`, content: 'hello', direction: 'in' as const, createdAt: 1000 },
};

type ApiFetch = (url: unknown, options?: RequestInit) => Promise<Response>;
let apiFetch: ReturnType<typeof vi.fn<ApiFetch>>;
async function flush(rounds = 6) { for (let i = 0; i < rounds; i += 1) { await tick(); await Promise.resolve(); } }

async function openPanel(): Promise<void> {
  render(RemoteDmPanel);
  await waitFor(() => expect(BridgeRegistry.get('showRemoteDmPanel')).toBeTruthy());
  BridgeRegistry.call('showRemoteDmPanel');
}

async function openThread(): Promise<void> {
  await openPanel();
  await waitFor(() => expect(document.querySelector('.remote-dm-conversation')).not.toBeNull());
  (document.querySelector<HTMLButtonElement>('.remote-dm-conversation'))!.click();
  await waitFor(() => expect(document.querySelector('.remote-dm-chat-header')).not.toBeNull());
}

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
  BridgeRegistry.register('apiFetch', apiFetch);
});

afterEach(() => {
  cleanup();
  for (const key of ['apiFetch', 'showRemoteDmPanel']) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RemoteDmPanel', () => {
  it('loads a recipient-scoped thread, sends a reply, and blocks over-limit content client-side', async () => {
    await openThread();
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

  it('renders the empty state and installs one ActivityPub shell button even across DOM mutations', async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 }));
    await openPanel();
    await waitFor(() => expect(document.querySelector('.remote-dm-muted')).not.toBeNull());
    expect(document.querySelectorAll('[data-bridge-action="showRemoteDmPanel"]')).toHaveLength(1);

    document.body.appendChild(document.createElement('div'));
    await flush();
    expect(document.querySelectorAll('[data-bridge-action="showRemoteDmPanel"]')).toHaveLength(1);
  });

  it('surfaces list request failures and malformed list payloads', async () => {
    apiFetch.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    await openPanel();
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
    cleanup();
    BridgeRegistry.unregister('showRemoteDmPanel');

    apiFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    render(RemoteDmPanel);
    await waitFor(() => expect(BridgeRegistry.get('showRemoteDmPanel')).toBeTruthy());
    BridgeRegistry.call('showRemoteDmPanel');
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
  });

  it('falls back from displayName to username and then actor URL', async () => {
    const usernameOnly = { ...conversation, threadId: 'username', other: { _id: 'u', username: 'carol@remote.example' }, actorUrl: 'https://remote.example/users/carol' };
    const actorOnly = { ...conversation, threadId: 'actor', other: { _id: 'a' }, actorUrl: 'https://remote.example/users/dave', lastMessage: null };
    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([usernameOnly, actorOnly]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await openPanel();
    await waitFor(() => expect(document.querySelectorAll('.remote-dm-conversation')).toHaveLength(2));
    const text = document.body.textContent || '';
    expect(text).toContain('carol@remote.example');
    expect(text).toContain('https://remote.example/users/dave');
    expect(text).toContain('CA');
    expect(text).toContain('HT');
  });

  it('supports back, Escape close, and reopening from the registered product action', async () => {
    await openThread();
    expect(document.querySelector('.remote-dm-panel')).not.toBeNull();
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.remote-dm-back')!);
    await flush();
    expect(document.querySelector('.remote-dm-chat-header')).toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(document.querySelector('.remote-dm-panel')).toBeNull();

    BridgeRegistry.call('showRemoteDmPanel');
    await waitFor(() => expect(document.querySelector('.remote-dm-panel')).not.toBeNull());
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.remote-dm-heading button')!);
    expect(document.querySelector('.remote-dm-panel')).toBeNull();
  });

  it('does not close for non-Escape keys', async () => {
    await openPanel();
    await waitFor(() => expect(document.querySelector('.remote-dm-panel')).not.toBeNull());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(document.querySelector('.remote-dm-panel')).not.toBeNull();
  });

  it('surfaces malformed and failed history responses', async () => {
    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
      return new Response(JSON.stringify({ nope: true }), { status: 200 });
    });
    await openThread();
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
    cleanup();
    BridgeRegistry.unregister('showRemoteDmPanel');

    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
      return new Response('{}', { status: 500 });
    });
    render(RemoteDmPanel);
    await waitFor(() => expect(BridgeRegistry.get('showRemoteDmPanel')).toBeTruthy());
    BridgeRegistry.call('showRemoteDmPanel');
    await waitFor(() => expect(document.querySelector('.remote-dm-conversation')).not.toBeNull());
    (document.querySelector<HTMLButtonElement>('.remote-dm-conversation'))!.click();
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
  });

  it('loads older messages, de-duplicates known ids, and disables further paging on a short page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      _id: `m-${index + 50}`, dmId: `ap:${threadId}`, userId: `ap:${threadId}`,
      content: `message-${index + 50}`, direction: 'in' as const, createdAt: 5000 + index,
    }));
    const olderPage = [
      { _id: 'm-1', dmId: `ap:${threadId}`, userId: `ap:${threadId}`, content: 'oldest', direction: 'in', createdAt: 1000 },
      firstPage[0],
    ];
    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
      if (url.includes('&before=')) return new Response(JSON.stringify(olderPage), { status: 200 });
      return new Response(JSON.stringify(firstPage), { status: 200 });
    });

    await openThread();
    await waitFor(() => expect(document.querySelector('.remote-dm-older')).not.toBeNull());
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.remote-dm-older')!);
    await waitFor(() => expect(document.body.textContent).toContain('oldest'));
    expect(document.querySelectorAll('.remote-dm-message')).toHaveLength(51);
    expect(document.querySelector('.remote-dm-older')).toBeNull();
  });

  it.each(['not-a-date', undefined])('disables older paging when the oldest message timestamp is %s', async (timestamp) => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      _id: `bad-${index}`, dmId: `ap:${threadId}`, userId: `ap:${threadId}`,
      content: `message-${index}`, direction: 'in' as const, createdAt: index === 0 ? timestamp : 5000 + index,
    }));
    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
      return new Response(JSON.stringify(firstPage), { status: 200 });
    });
    await openThread();
    await waitFor(() => expect(document.querySelector('.remote-dm-older')).not.toBeNull());
    apiFetch.mockClear();
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.remote-dm-older')!);
    await flush();
    expect(document.querySelector('.remote-dm-older')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.remote-dm-message')).toHaveLength(50);
  });

  it.each([['HTTP error', 500], ['malformed payload', 200]] as const)('shows an older-page %s without discarding current history', async (_label, status) => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      _id: `e-${index}`, dmId: `ap:${threadId}`, userId: `ap:${threadId}`,
      content: `message-${index}`, direction: 'in' as const, createdAt: 1000 + index,
    }));
    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
      if (url.includes('&before=')) return new Response('{}', { status });
      return new Response(JSON.stringify(firstPage), { status: 200 });
    });
    await openThread();
    await waitFor(() => expect(document.querySelector('.remote-dm-older')).not.toBeNull());
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.remote-dm-older')!);
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
    expect(document.querySelectorAll('.remote-dm-message')).toHaveLength(50);
    expect(document.querySelector('.remote-dm-older')).toBeEnabled();
  });

  it('renders an outgoing message with missing sender name and timestamp using the local user label', async () => {
    apiFetch.mockImplementation(async (urlValue: unknown) => new Response(JSON.stringify(
      String(urlValue).endsWith('/api/federation/remote-dms') ? [conversation] : [{
        _id: 'legacy-out', dmId: conversation.dmId, userId: 'me', content: 'legacy reply', direction: 'out',
      }],
    ), { status: 200 }));
    await openThread();
    await waitFor(() => expect(document.querySelector('.remote-dm-message')).toHaveTextContent('legacy reply'));
    expect(document.querySelector('.remote-dm-message')).toHaveClass('outgoing');
    expect(document.querySelector('.remote-dm-message strong')).toHaveTextContent(t('ui_bridge_user'));
    expect(document.querySelector('.remote-dm-message time')).toBeNull();
  });

  it('rejects whitespace submissions and prevents a second send while the first is pending', async () => {
    await openThread();
    await waitFor(() => expect(document.querySelector('.remote-dm-message')).toHaveTextContent('hello'));
    const form = document.querySelector<HTMLFormElement>('.remote-dm-composer')!;
    const box = form.querySelector('textarea')!;
    const button = form.querySelector('button')!;
    apiFetch.mockClear();
    await fireEvent.input(box, { target: { value: '   ' } });
    expect(button).toBeDisabled();
    form.requestSubmit();
    await flush();
    expect(apiFetch).not.toHaveBeenCalled();

    let resolveSend!: (response: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSend = resolve; }));
    await fireEvent.input(box, { target: { value: 'one reply' } });
    expect(button).toBeEnabled();
    form.requestSubmit();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(t('dm_sending'));
    form.requestSubmit();
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    resolveSend(new Response(JSON.stringify({ _id: 'out-once', content: 'one reply', direction: 'out' }), { status: 201 }));
    await waitFor(() => expect(document.querySelectorAll('.remote-dm-message')).toHaveLength(2));
    expect(box.value).toBe('');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(t('dm_send'));
  });

  it('sends a server-compatible client nonce when crypto.randomUUID is unavailable', async () => {
    await openThread();
    await waitFor(() => expect(document.querySelector('.remote-dm-message')).toHaveTextContent('hello'));
    vi.stubGlobal('crypto', undefined);
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>('.remote-dm-composer textarea')!, { target: { value: 'reply' } });
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await waitFor(() => expect(document.querySelectorAll('.remote-dm-message')).toHaveLength(2));
    const options = apiFetch.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === 'POST')?.[1] as RequestInit;
    const body = JSON.parse(String(options.body)) as { content: string; clientNonce: string };
    expect(body.content).toBe('reply');
    expect(body.clientNonce).toMatch(/^[A-Za-z0-9:_-]{1,100}$/);
    expect(document.querySelector('.remote-dm-error')).toBeNull();
  });

  it('does not append a duplicate send response and validates malformed send responses', async () => {
    apiFetch.mockImplementation(async (urlValue: unknown, options?: RequestInit) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
      if (options?.method === 'POST') return new Response(JSON.stringify(conversation.lastMessage), { status: 201 });
      return new Response(JSON.stringify([conversation.lastMessage]), { status: 200 });
    });
    await openThread();
    const box = document.querySelector<HTMLTextAreaElement>('.remote-dm-composer textarea')!;
    await fireEvent.input(box, { target: { value: 'duplicate reply' } });
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await flush();
    expect(document.querySelectorAll('.remote-dm-message')).toHaveLength(1);

    apiFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ content: 'missing id' }), { status: 201 }));
    await fireEvent.input(box, { target: { value: 'bad response' } });
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
  });

  it('surfaces failed send requests and keeps the draft for retry', async () => {
    await openThread();
    apiFetch.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    const box = document.querySelector<HTMLTextAreaElement>('.remote-dm-composer textarea')!;
    await fireEvent.input(box, { target: { value: 'retry me' } });
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
    expect(box.value).toBe('retry me');
  });

  it('renders invalid, negative and ISO message timestamps without crashing', async () => {
    const history = [
      { ...conversation.lastMessage, _id: 't-1', createdAt: 'not-a-date' },
      { ...conversation.lastMessage, _id: 't-2', createdAt: -1 },
      { ...conversation.lastMessage, _id: 't-3', createdAt: '2026-10-05T10:00:00.000Z' },
    ];
    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) return new Response(JSON.stringify([conversation]), { status: 200 });
      return new Response(JSON.stringify(history), { status: 200 });
    });
    await openThread();
    await waitFor(() => expect(document.querySelectorAll('.remote-dm-message')).toHaveLength(3));
    expect(document.querySelectorAll('.remote-dm-message time')).toHaveLength(3);
  });

  it('reports a missing secure API client rather than throwing', async () => {
    BridgeRegistry.unregister('apiFetch');
    await openPanel();
    await waitFor(() => expect(document.querySelector('.remote-dm-error')).not.toBeNull());
  });
});
