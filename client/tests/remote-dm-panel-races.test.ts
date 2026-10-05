import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import RemoteDmPanel from '../js/core/RemoteDmPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { mountShellActions, unmountShellActions } from '../js/core/shell-actions.ts';

const conversationA = {
  _id: 'ap:alpha',
  dmId: 'ap:alpha',
  threadId: 'alpha',
  federated: true as const,
  actorUrl: 'https://remote.example/users/alice',
  other: { _id: 'ap:alpha', username: 'alice@remote.example', displayName: 'Alice' },
  lastMessage: {
    _id: 'a-in-1', dmId: 'ap:alpha', userId: 'ap:alpha', content: 'alpha history',
    direction: 'in' as const, createdAt: 1000,
  },
};

const conversationB = {
  _id: 'ap:beta',
  dmId: 'ap:beta',
  threadId: 'beta',
  federated: true as const,
  actorUrl: 'https://remote.example/users/bob',
  other: { _id: 'ap:beta', username: 'bob@remote.example', displayName: 'Bob' },
  lastMessage: {
    _id: 'b-in-1', dmId: 'ap:beta', userId: 'ap:beta', content: 'beta history',
    direction: 'in' as const, createdAt: 2000,
  },
};

let apiFetch: ReturnType<typeof vi.fn>;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function renderAndOpen(): Promise<void> {
  render(RemoteDmPanel);
  await waitFor(() => expect(BridgeRegistry.get('showRemoteDmPanel')).toBeTruthy());
  BridgeRegistry.call('showRemoteDmPanel');
  await waitFor(() => expect(document.querySelectorAll('.remote-dm-conversation')).toHaveLength(2));
}

beforeEach(() => {
  document.body.innerHTML = '<button data-bridge-action="showDmPanel" class="shell-dm">DM</button>';
  mountShellActions();
});

afterEach(() => {
  cleanup();
  unmountShellActions();
  for (const key of ['apiFetch', 'showRemoteDmPanel']) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('RemoteDmPanel async isolation', () => {
  it('dispatches one list request for one click on its component-bound shell button', async () => {
    apiFetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);

    render(RemoteDmPanel);
    await waitFor(() => expect(BridgeRegistry.get('showRemoteDmPanel')).toBeTruthy());
    const shellButton = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-bridge-action="showRemoteDmPanel"]');
      expect(button).not.toBeNull();
      return button!;
    });

    apiFetch.mockClear();
    await fireEvent.click(shellButton);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(String(apiFetch.mock.calls[0]?.[0])).toMatch(/\/api\/federation\/remote-dms$/);
  });

  it('does not let a delayed send response overwrite another conversation draft or history', async () => {
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => { resolvePost = resolve; });

    apiFetch = vi.fn(async (urlValue: unknown, options?: RequestInit) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) {
        return new Response(JSON.stringify([conversationA, conversationB]), { status: 200 });
      }
      if (options?.method === 'POST') return pendingPost;
      if (url.includes('/alpha/messages')) {
        return new Response(JSON.stringify([conversationA.lastMessage]), { status: 200 });
      }
      if (url.includes('/beta/messages')) {
        return new Response(JSON.stringify([conversationB.lastMessage]), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);

    await renderAndOpen();
    const conversations = document.querySelectorAll<HTMLButtonElement>('.remote-dm-conversation');
    await fireEvent.click(conversations[0]);
    await waitFor(() => expect(document.querySelector('.remote-dm-message')?.textContent).toContain('alpha history'));

    let box = document.querySelector<HTMLTextAreaElement>('.remote-dm-composer textarea')!;
    await fireEvent.input(box, { target: { value: 'send to alpha' } });
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await waitFor(() => expect(apiFetch.mock.calls.some(([, options]) => (options as RequestInit | undefined)?.method === 'POST')).toBe(true));

    await fireEvent.click(conversations[1]);
    await waitFor(() => expect(document.querySelector('.remote-dm-message')?.textContent).toContain('beta history'));
    box = document.querySelector<HTMLTextAreaElement>('.remote-dm-composer textarea')!;
    await fireEvent.input(box, { target: { value: 'keep beta draft' } });

    resolvePost(new Response(JSON.stringify({
      _id: 'a-out-1', dmId: 'ap:alpha', userId: 'me', displayName: 'Me',
      content: 'sent alpha', direction: 'out', createdAt: 3000,
    }), { status: 201 }));
    await flush();

    expect(box.value).toBe('keep beta draft');
    const visibleMessages = [...document.querySelectorAll('.remote-dm-message')].map((node) => node.textContent || '');
    expect(visibleMessages.some((text) => text.includes('sent alpha'))).toBe(false);
    expect(visibleMessages.some((text) => text.includes('beta history'))).toBe(true);
  });

  it('keeps text typed after submit when the same send resolves', async () => {
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => { resolvePost = resolve; });

    apiFetch = vi.fn(async (urlValue: unknown, options?: RequestInit) => {
      const url = String(urlValue);
      if (url.endsWith('/api/federation/remote-dms')) {
        return new Response(JSON.stringify([conversationA, conversationB]), { status: 200 });
      }
      if (options?.method === 'POST') return pendingPost;
      if (url.includes('/alpha/messages')) {
        return new Response(JSON.stringify([conversationA.lastMessage]), { status: 200 });
      }
      return new Response(JSON.stringify([conversationB.lastMessage]), { status: 200 });
    });
    BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);

    await renderAndOpen();
    await fireEvent.click(document.querySelectorAll<HTMLButtonElement>('.remote-dm-conversation')[0]);
    await waitFor(() => expect(document.querySelector('.remote-dm-composer textarea')).not.toBeNull());

    const box = document.querySelector<HTMLTextAreaElement>('.remote-dm-composer textarea')!;
    await fireEvent.input(box, { target: { value: 'submitted text' } });
    document.querySelector<HTMLFormElement>('.remote-dm-composer')!.requestSubmit();
    await waitFor(() => expect(apiFetch.mock.calls.some(([, options]) => (options as RequestInit | undefined)?.method === 'POST')).toBe(true));
    await fireEvent.input(box, { target: { value: 'new draft while pending' } });

    resolvePost(new Response(JSON.stringify({
      _id: 'a-out-2', dmId: 'ap:alpha', userId: 'me', displayName: 'Me',
      content: 'submitted text', direction: 'out', createdAt: 4000,
    }), { status: 201 }));
    await flush();

    expect(box.value).toBe('new draft while pending');
    expect([...document.querySelectorAll('.remote-dm-message')].some((node) => node.textContent?.includes('submitted text'))).toBe(true);
  });
});
