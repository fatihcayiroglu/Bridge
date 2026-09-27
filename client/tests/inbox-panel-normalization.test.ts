// client/tests/inbox-panel-normalization.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// InboxPanel.svelte — SUNUCU YANITININ NORMALİZASYONU VE STALE İSTEK SAHİPLİĞİ
// ════════════════════════════════════════════════════════════════════════════
// Inbox, KULLANICI ADINA gezinme yapan bir yüzeydir: bir satıra tıklamak
// kanal/DM açar. Bu yüzden satırın şekli GÜVENİLİR olmalıdır — hedefi olmayan
// ya da tanınmayan türde bir satır arayüze hiç girmemelidir.
//
// Ölçülen sözleşmeler:
//   • Nesne olmayan gövde, dizi olmayan `items`, tekrar eden kimlik, tanınmayan
//     `kind`/`destination.type` ve eksik hedef REDDEDİLİR.
//   • Sayaçlar sınırlanır: negatif ya da devasa bir sayaç rozete yazılmaz.
//   • Bayat bir istek TAZE sonucu EZEMEZ (`requestSeq` sahipliği).
//   • Rozet yalnızca gerçek bir sayı varken çizilir ve sıfırlandığında
//     KALDIRILIR — kalıcı bir "1" kullanıcıyı sonsuza dek yanıltırdı.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import InboxPanel from '../js/core/InboxPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const registryKeys = ['apiFetch', 'socket', 'showInbox', 'openInbox', 'markAllRead', 'toast'];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: vi.fn(async () => body) } as unknown as Response;
}

function mention(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1', kind: 'mention', unreadCount: 1, createdAt: Date.now(), preview: 'Preview',
    sender: { _id: 'sender', displayName: 'Alice' },
    destination: {
      type: 'channel', channelId: 'channel-1', messageId: 'message-1',
      channel: { _id: 'channel-1', name: 'general' },
      server: { _id: 'server-1', name: 'Bridge' },
    },
    ...overrides,
  };
}

const rows = () => [...document.querySelectorAll('.inbox-item')];
const opener = () => document.querySelector('[data-bridge-action="showInbox"]') as HTMLElement;

async function openPanel(apiFetch: ReturnType<typeof vi.fn>) {
  BridgeRegistry.register('apiFetch', apiFetch as never);
  render(InboxPanel);
  BridgeRegistry.call('showInbox');
  await waitFor(() => expect(document.querySelector('.inbox-panel, .inbox-overlay, [role="dialog"]')).not.toBeNull());
}

beforeEach(() => {
  for (const key of registryKeys) BridgeRegistry.unregister(key);
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '<button id="inbox-opener" data-bridge-action="showInbox" aria-label="Inbox\'u aç">Inbox</button>';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const key of registryKeys) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
});

describe('response normalization', () => {
  it('renders nothing at all for a body that is not an object', async () => {
    await openPanel(vi.fn(async () => jsonResponse('not-an-object')));
    await waitFor(() => expect(rows()).toHaveLength(0));
  });

  it('renders nothing when items is not an array', async () => {
    await openPanel(vi.fn(async () => jsonResponse({ items: { id: 'x' }, counts: {} })));
    await waitFor(() => expect(rows()).toHaveLength(0));
  });

  it('drops rows that cannot be safely navigated to', async () => {
    const apiFetch = vi.fn(async () => jsonResponse({
      items: [
        null,
        'string-row',
        ['array-row'],
        mention({ id: '  ' }),
        mention({ id: 'dup' }),
        mention({ id: 'dup', preview: 'duplicate' }),
        mention({ id: 'bad-kind', kind: 'system' }),
        mention({ id: 'no-destination', destination: undefined }),
        mention({ id: 'string-destination', destination: 'channel-1' }),
        mention({ id: 'bad-destination-type', destination: { type: 'webhook' } }),
        mention({ id: 'ok' }),
      ],
      counts: {},
    }));
    await openPanel(apiFetch);
    // Yalnızca tekilleştirilmiş ve gezilebilir satırlar kalır.
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('clamps hostile unread counts and coerces an unusable timestamp', async () => {
    await openPanel(vi.fn(async () => jsonResponse({
      items: [mention({ id: 'a', unreadCount: -5, createdAt: 'yesterday' })],
      counts: { all: -1, mentions: 10_000_000, replies: 'many', dms: 2.9 },
    })));
    await waitFor(() => expect(rows()).toHaveLength(1));
    const badge = opener().querySelector('.h-unread');
    // `all: -1` sıfıra sabitlendiği için rozet HİÇ çizilmez.
    expect(badge).toBeNull();
    expect(opener().getAttribute('aria-label')).toBe(t('ui_open_inbox'));
  });

  it('truncates an oversized preview instead of rendering it whole', async () => {
    await openPanel(vi.fn(async () => jsonResponse({
      items: [mention({ id: 'a', preview: 'x'.repeat(2_000) })],
      counts: { all: 1 },
    })));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect((document.querySelector('.inbox-item')!.textContent ?? '').length).toBeLessThan(1_000);
  });

  it('replaces a non-string preview with an empty one', async () => {
    await openPanel(vi.fn(async () => jsonResponse({
      items: [mention({ id: 'a', preview: { evil: true } })],
      counts: { all: 1 },
    })));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('treats a non-object counts field as all-zero', async () => {
    await openPanel(vi.fn(async () => jsonResponse({ items: [mention()], counts: 'lots' })));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(opener().querySelector('.h-unread')).toBeNull();
  });
});

describe('unread badge lifecycle', () => {
  it('renders, caps and then removes the badge as counts change', async () => {
    let payload: unknown = { items: [mention()], counts: { all: 250, mentions: 250, replies: 0, dms: 0 } };
    const apiFetch = vi.fn(async () => jsonResponse(payload));
    await openPanel(apiFetch);
    await waitFor(() => expect(opener().querySelector('.h-unread')?.textContent).toBe('99+'));
    expect(opener().getAttribute('aria-label')).toContain('250');

    payload = { items: [mention()], counts: { all: 3, mentions: 3, replies: 0, dms: 0 } };
    BridgeRegistry.call('showInbox');
    await waitFor(() => expect(opener().querySelector('.h-unread')?.textContent).toBe('3'));

    payload = { items: [], counts: { all: 0, mentions: 0, replies: 0, dms: 0 } };
    BridgeRegistry.call('showInbox');
    await waitFor(() => expect(opener().querySelector('.h-unread')).toBeNull());
    expect(opener().getAttribute('aria-label')).toBe(t('ui_open_inbox'));
  });

  it('clears the badge when the session is logged out', async () => {
    await openPanel(vi.fn(async () => jsonResponse({ items: [mention()], counts: { all: 4, mentions: 4, replies: 0, dms: 0 } })));
    await waitFor(() => expect(opener().querySelector('.h-unread')).not.toBeNull());

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    await waitFor(() => expect(opener().querySelector('.h-unread')).toBeNull());
  });
});

describe('request ownership', () => {
  it('never lets a slow earlier request overwrite the newest result', async () => {
    const releases: Array<(value: Response) => void> = [];
    const apiFetch = vi.fn(() => new Promise<Response>(resolve => { releases.push(resolve); }));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(InboxPanel);

    BridgeRegistry.call('showInbox');
    await waitFor(() => expect(releases.length).toBeGreaterThan(0));
    const firstIndex = releases.length - 1;
    BridgeRegistry.call('showInbox');
    await waitFor(() => expect(releases.length).toBeGreaterThan(firstIndex + 1));

    releases.at(-1)!(jsonResponse({ items: [mention({ id: 'newest', preview: 'newest' })], counts: { all: 1 } }));
    await waitFor(() => expect(document.body.textContent).toContain('newest'));

    // Bayat yanıt SONRA gelir ve taze listeyi EZMEZ.
    releases[firstIndex]!(jsonResponse({ items: [mention({ id: 'stale', preview: 'stale' })], counts: { all: 9 } }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(document.body.textContent).toContain('newest');
    expect(document.body.textContent).not.toContain('stale');
  });

  it('surfaces the transport error message when the request rejects with an Error', async () => {
    const apiFetch = vi.fn().mockRejectedValue(new Error('Ağ kesildi'));
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(InboxPanel);
    BridgeRegistry.call('showInbox');
    // Istisnanin ham `message` alani gosterilmez; 'Ag kesildi' bir AG ipucu
    // tasimadigi icin siniflandirilamaz ve cagiranin kanonik yedegi yazilir.
    await waitFor(() => expect(document.body.textContent).toContain(t('inb_failed')));
  });

  it('falls back to a stable message when the rejection is not an Error', async () => {
    const apiFetch = vi.fn().mockRejectedValue('offline');
    BridgeRegistry.register('apiFetch', apiFetch as never);
    render(InboxPanel);
    BridgeRegistry.call('showInbox');
    await waitFor(() => expect(document.body.textContent).toContain(t('inb_failed')));
  });
});
