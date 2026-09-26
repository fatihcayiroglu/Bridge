import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import InboxPanel from '../js/core/InboxPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const registryKeys = [
  'apiFetch', 'socket', 'showInbox', 'openInbox', 'markAllRead',
  'navigateToChannel', 'openDm', 'groupDmPanel:openGroupDm', 'toast',
];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: vi.fn(async () => body) } as unknown as Response;
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1', kind: 'mention', unreadCount: 1, createdAt: Date.now(), preview: 'Preview',
    sender: { _id: 'sender', displayName: 'Alice', avatarColor: '#123456' },
    destination: {
      type: 'channel', channelId: 'channel-1', messageId: 'message-1',
      channel: { _id: 'channel-1', name: 'general' },
      server: { _id: 'server-1', name: 'Bridge' },
    },
    ...overrides,
  };
}

function body(items = [item()], counts = { all: 1, mentions: 1, replies: 0, dms: 0 }) {
  return { items, counts };
}

function createSocket() {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    on: vi.fn((event: string, fn: () => void) => { handlers.set(event, fn); }),
    off: vi.fn((event: string, fn: () => void) => {
      if (handlers.get(event) === fn) handlers.delete(event);
    }),
  };
}

beforeEach(() => {
  for (const key of registryKeys) BridgeRegistry.unregister(key);
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
  document.body.innerHTML = '<button id="inbox-opener" data-bridge-action="showInbox" aria-label="Inbox\'u aç">Inbox</button>';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const key of registryKeys) BridgeRegistry.unregister(key);
  delete (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
  document.body.innerHTML = '';
});

describe('Unified Inbox security, reconnect, and lifecycle behavior', () => {
  it('normalizes malformed and duplicated response entries and bounds display counters', async () => {
    const longPreview = 'x'.repeat(700);
    const valid = item({
      id: 'same', unreadCount: 50_000, preview: longPreview,
      sender: { _id: 'sender', username: 'alice', avatarColor: 'red;background:url(javascript:1)' },
    });
    const api = vi.fn(async () => jsonResponse({
      items: [null, [], 'bad', {}, valid, { ...valid, preview: 'duplicate' }, { ...item(), id: 'bad-kind', kind: 'other' }],
      counts: { all: '10000000', mentions: -4, replies: Number.POSITIVE_INFINITY, dms: 2.9 },
    }));
    BridgeRegistry.register('apiFetch', api);
    const view = render(InboxPanel);

    await waitFor(() => expect(document.querySelector('.h-unread')).toHaveTextContent('99+'));
    expect(document.getElementById('inbox-opener'))
      .toHaveAttribute('aria-label', t('inbox_open_pending', undefined, { count: 999999 }));
    BridgeRegistry.call('showInbox');
    await view.findByRole('dialog', { name: t('markup_inbox_44caf74') });

    expect(view.container.querySelectorAll('.inbox-item')).toHaveLength(1);
    expect(view.container.querySelector('.item-preview')?.textContent).toHaveLength(500);
    expect(view.container.querySelector('.item-avatar')?.getAttribute('style')).toContain('var(--brand)');
    expect(view.getByLabelText('50000 okunmamış')).toHaveTextContent('99+');
    expect(view.getByRole('button', { name: /^Bahsetmeler 0$/ })).toBeInTheDocument();
    expect(view.getByRole('button', { name: /^DM'ler 2$/ })).toBeInTheDocument();
  });

  it('renders safe API-owner, malformed-body, and HTTP error states and can retry', async () => {
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');
    // API sahibi yoksa istek hic gonderilmez; siniflandirilamayan bu durumda
    // cagiranin kanonik yedek metni gosterilir.
    expect(await view.findByRole('alert')).toHaveTextContent(t('inb_failed'));

    const api = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn(async () => { throw new SyntaxError('bad json'); }) })
      .mockResolvedValueOnce(jsonResponse({ error: 'Yetki sona erdi' }, 401))
      .mockResolvedValueOnce(jsonResponse(null, 503))
      .mockResolvedValueOnce(jsonResponse(body([])));
    BridgeRegistry.register('apiFetch', api);
    await fireEvent.click(view.getByRole('button', { name: t('retry') }));
    expect(await view.findByRole('alert')).toHaveTextContent(t('inb_failed'));
    await fireEvent.click(view.getByRole('button', { name: t('retry') }));
    // 401 kanonik metne eslenir; sunucu govdesi SIZMAZ.
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(t('error_unauthorized')));
    expect(view.getByRole('alert').textContent).not.toContain('Yetki sona erdi');
    await fireEvent.click(view.getByRole('button', { name: t('retry') }));
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(t('error_server')));
    await fireEvent.click(view.getByRole('button', { name: t('retry') }));
    await waitFor(() => expect(view.getByText('Hepsi tamam')).toBeInTheDocument());
  });

  it('keeps the latest filter request authoritative and avoids reloading an active filter', async () => {
    let resolveMentions!: (value: Response) => void;
    let resolveReplies!: (value: Response) => void;
    const api = vi.fn(async (url: string) => {
      if (url.includes('filter=mentions')) return new Promise<Response>((resolve) => { resolveMentions = resolve; });
      if (url.includes('filter=replies')) return new Promise<Response>((resolve) => { resolveReplies = resolve; });
      return jsonResponse(body([]));
    });
    BridgeRegistry.register('apiFetch', api);
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');
    await view.findByRole('dialog', { name: t('markup_inbox_44caf74') });

    const allCalls = api.mock.calls.length;
    await fireEvent.click(view.getByRole('button', { name: /^Tümü 1$/ }));
    expect(api).toHaveBeenCalledTimes(allCalls);
    await fireEvent.click(view.getByRole('button', { name: /^Bahsetmeler 1$/ }));
    await fireEvent.click(view.getByRole('button', { name: /^Yanıtlar 0$/ }));
    resolveReplies(jsonResponse(body([item({ id: 'new', kind: 'reply', preview: 'Newest' })])));
    await view.findByText('Newest');
    resolveMentions(jsonResponse(body([item({ id: 'old', preview: 'Stale' })])));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByText('Stale')).not.toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: /^DM'ler/ }));
    await fireEvent.click(view.getByRole('button', { name: /^Tümü 1$/ }));
  });

  it('contains mark-all-read failures, preserves items, then clears an authoritative success', async () => {
    let patchMode: 'status' | 'throw' | 'ok' = 'status';
    const api = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') {
        if (patchMode === 'status') return jsonResponse({ error: 'nope' }, 503);
        if (patchMode === 'throw') throw new Error('offline');
        return jsonResponse({ read: true });
      }
      return jsonResponse(body());
    });
    BridgeRegistry.register('apiFetch', api);
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');
    const mark = await view.findByRole('button', { name: 'Tümünü okundu yap' });

    await fireEvent.click(mark);
    expect(await view.findByRole('alert')).toHaveTextContent('Okundu bilgisi kaydedilemedi.');
    expect(document.querySelector('.h-unread')).toHaveTextContent('1');
    expect(view.getByRole('button', { name: 'Tümünü okundu yap' })).toBeInTheDocument();

    patchMode = 'throw';
    await fireEvent.click(view.getByRole('button', { name: 'Tümünü okundu yap' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Okundu bilgisi kaydedilemedi.');

    patchMode = 'ok';
    await fireEvent.click(view.getByRole('button', { name: 'Tümünü okundu yap' }));
    await waitFor(() => expect(document.querySelector('.h-unread')).toBeNull());
    expect(view.getByText('Hepsi tamam')).toBeInTheDocument();
  });

  it('binds one listener set, replaces sockets cleanly, and debounces realtime reloads', async () => {
    vi.useFakeTimers();
    const first = createSocket();
    const second = createSocket();
    const api = vi.fn(async () => jsonResponse(body([])));
    BridgeRegistry.register('apiFetch', api);
    BridgeRegistry.register('socket', first as never);
    render(InboxPanel);
    await Promise.resolve();
    expect(first.on).toHaveBeenCalledTimes(3);

    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(first.on).toHaveBeenCalledTimes(3);
    BridgeRegistry.register('socket', second as never);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(first.off).toHaveBeenCalledTimes(3);
    expect(second.on).toHaveBeenCalledTimes(3);

    const before = api.mock.calls.length;
    second.handlers.get('inbox:changed')?.();
    second.handlers.get('dm:message')?.();
    second.handlers.get('gdm:message')?.();
    await vi.advanceTimersByTimeAsync(89);
    expect(api).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(before + 1);
  });

  it('cancels scheduled and in-flight reloads on logout', async () => {
    vi.useFakeTimers();
    let resolvePending!: (value: Response) => void;
    let pending = false;
    const api = vi.fn(async () => {
      if (pending) return new Promise<Response>((resolve) => { resolvePending = resolve; });
      return jsonResponse(body());
    });
    BridgeRegistry.register('apiFetch', api);
    const view = render(InboxPanel);
    await Promise.resolve();
    BridgeRegistry.call('showInbox');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    pending = true;
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await vi.advanceTimersByTimeAsync(90);
    const calls = api.mock.calls.length;
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();
    expect(view.queryByRole('dialog', { name: 'Gelen kutusu' })).not.toBeInTheDocument();
    expect(document.querySelector('.h-unread')).toBeNull();
    resolvePending(jsonResponse(body([item({ id: 'stale', preview: 'Stale after logout' })])));
    await Promise.resolve();
    await vi.runAllTimersAsync();
    expect(api).toHaveBeenCalledTimes(calls);
    expect(document.querySelector('.h-unread')).toBeNull();
  });

  it('delegates GDM and unavailable destinations and cancels navigation reload after teardown', async () => {
    vi.useFakeTimers();
    const group = { _id: 'group-1', name: 'Core Team', ownerId: 'owner' };
    const payload = body([
      item({ id: 'gdm', kind: 'gdm', preview: 'Group item', destination: { type: 'gdm', group } }),
      item({ id: 'gone', kind: 'dm', preview: 'Gone item', destination: { type: 'dm' } }),
    ], { all: 2, mentions: 0, replies: 0, dms: 2 });
    const api = vi.fn(async () => jsonResponse(payload));
    const openGroup = vi.fn();
    const toast = vi.fn();
    BridgeRegistry.register('apiFetch', api);
    BridgeRegistry.register('groupDmPanel:openGroupDm', openGroup);
    BridgeRegistry.register('toast', toast);
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');
    await fireEvent.click(await view.findByText('Group item'));
    expect(openGroup).toHaveBeenCalledWith(group);

    BridgeRegistry.call('showInbox');
    await fireEvent.click(await view.findByText('Gone item'));
    expect(toast).toHaveBeenCalledWith('Bu konuşma artık kullanılamıyor.', 'warning');
    const calls = api.mock.calls.length;
    cleanup();
    await vi.runAllTimersAsync();
    expect(api).toHaveBeenCalledTimes(calls);
  });

  it('restores focus on Escape and does not close for clicks inside the dialog', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(body([]))));
    const opener = document.getElementById('inbox-opener')!;
    opener.focus();
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');
    const first = await view.findByRole('dialog', { name: t('markup_inbox_44caf74') });

    // Final21 UX: bu satır eskiden Esc'e panelin İÇİNDE basınca panelin AÇIK KALDIĞINI
    // doğruluyordu — yani kusurun kendisini. Diğer tüm yüzeyler (ve WAI-ARIA diyalog
    // deseni) odak içerideyken Esc ile kapanır; Inbox da artık öyle, odak açana döner.
    await fireEvent.keyDown(first, { key: 'Escape' });
    await Promise.resolve();
    expect(view.queryByRole('dialog', { name: 'Gelen kutusu' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);

    opener.focus();
    BridgeRegistry.call('showInbox');
    const dialog = await view.findByRole('dialog', { name: t('markup_inbox_44caf74') });
    await fireEvent.click(dialog);
    expect(view.getByRole('dialog', { name: 'Gelen kutusu' })).toBeInTheDocument();
    await fireEvent.click(view.container.querySelector('.inbox-backdrop')!);
    await Promise.resolve();
    expect(view.queryByRole('dialog', { name: 'Gelen kutusu' })).not.toBeInTheDocument();

    opener.focus();
    BridgeRegistry.call('showInbox');
    await view.findByRole('dialog', { name: t('markup_inbox_44caf74') });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await Promise.resolve();
    expect(view.queryByRole('dialog', { name: 'Gelen kutusu' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('renders every item kind, destination fallback, and relative-time bucket', async () => {
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    const now = Date.now();
    const payload = body([
      item({ id: 'mention', kind: 'mention', createdAt: now, destination: { type: 'channel', channelId: 'c' } }),
      item({ id: 'reply', kind: 'reply', createdAt: now - 120_000, destination: { type: 'channel', channelId: 'c', channel: { _id: 'c', name: 'replies' } } }),
      item({ id: 'gdm', kind: 'gdm', createdAt: now - 7_200_000, destination: { type: 'gdm', group: { _id: 'g', name: '' } } }),
      item({ id: 'dm', kind: 'dm', createdAt: now - 172_800_000, sender: null, destination: { type: 'dm' }, preview: '' }),
    ], { all: 4, mentions: 1, replies: 1, dms: 2 });
    BridgeRegistry.register('apiFetch', vi.fn(async () => jsonResponse(payload)));
    const view = render(InboxPanel);
    BridgeRegistry.call('showInbox');
    await view.findByRole('dialog', { name: t('markup_inbox_44caf74') });

    expect([...view.container.querySelectorAll('.item-topline strong')].map(node => node.textContent)).toEqual([
      'Bahsetme', 'Yanıt', 'Grup DM', 'DM',
    ]);
    expect(view.getByText('Bridge · #kanal')).toBeInTheDocument();
    expect(view.getByText('Grup DM', { selector: '.item-title' })).toBeInTheDocument();
    expect(view.getByText('Bridge user')).toBeInTheDocument();
    expect(view.getByText('Yeni mesaj')).toBeInTheDocument();
    expect(view.getByText('şimdi')).toBeInTheDocument();
    expect(view.getByText('2 dk')).toBeInTheDocument();
    expect(view.getByText('2 sa')).toBeInTheDocument();
  });
});
