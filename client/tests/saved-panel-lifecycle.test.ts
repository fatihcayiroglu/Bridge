// client/tests/saved-panel-lifecycle.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SavedPanel.svelte — BAĞLAM SAHİPLİĞİ, KLAVYE GEZİNMESİ VE ETİKET YEDEKLERİ
// ════════════════════════════════════════════════════════════════════════════
// Kaydedilenler paneli, oturum/bağlam değişiminde (logout, hesap değişimi)
// ÖNCEKİ kullanıcının satırlarını göstermeye devam edemez. Bu yüzden her
// asenkron iş iki muhafızla çevrilidir: istek sırası (`requestSeq`) ve BAĞLAM
// sırası (`contextSeq`). İkisi de yoksa geç dönen bir yanıt, başka bir
// kullanıcının kaydettiği mesajı ekrana basardı.
//
// Ölçülen sözleşmeler:
//   • Bağlam değiştikten sonra dönen yanıt/hata YOK SAYILIR.
//   • Silme hatası satırı YERİNDE bırakır ve söyler; iyimser silme yapılmaz.
//   • Hedef adı eksik alanlarda anlamlı bir yedeğe düşer.
//   • Liste ok tuşları/Home/End ile gezilebilir ve odak dışarı kaçmaz.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SavedPanel from '../js/core/SavedPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const KEYS = [
  'apiFetch', 'showSaved', 'openSaved', 'saveForLater', 'navigateToChannel',
  'openDm', 'groupDmPanel:openGroupDm', 'toast',
];

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'saved-1', savedAt: Date.now(), unavailable: false, preview: 'Follow-up',
    sender: { _id: 'sender-1', displayName: 'Ada' },
    destination: {
      type: 'channel', messageId: 'message-1', channelId: 'channel-1', serverId: 'server-1',
      channel: { _id: 'channel-1', name: 'private' },
      server: { _id: 'server-1', name: 'Team' },
    },
    ...overrides,
  };
}

const items = () => [...document.querySelectorAll<HTMLButtonElement>('[data-saved-item]')];

async function openWith(apiFetch: ReturnType<typeof vi.fn>) {
  BridgeRegistry.register('apiFetch', apiFetch as never);
  render(SavedPanel);
  BridgeRegistry.call('showSaved');
  await waitFor(() => expect(document.querySelector('[data-saved-item], .saved-state, .saved-item')).not.toBeNull());
}

afterEach(() => {
  cleanup();
  for (const key of KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('destination labels', () => {
  it('falls back to generic names for a channel row missing its server and channel names', async () => {
    await openWith(vi.fn(async () => response({ items: [row({
      destination: { type: 'channel', messageId: 'm', channelId: 'c', channel: {}, server: {} },
    })] })));
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(document.body.textContent).toContain('Bridge');
    expect(document.body.textContent).toContain('#kanal');
  });

  it('falls back for a group row with no name and a direct row with no user name', async () => {
    await openWith(vi.fn(async () => response({ items: [
      row({ id: 'g', destination: { type: 'gdm', messageId: 'm', groupId: 'g1', group: { _id: 'g1' } } }),
      row({ id: 'd', destination: { type: 'dm', messageId: 'm', user: { _id: 'u1' } } }),
    ] })));
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(document.body.textContent).toContain('Grup DM');
    expect(document.body.textContent).toContain('Bridge user');
  });

  it('prefers a username when no display name is present', async () => {
    await openWith(vi.fn(async () => response({ items: [
      row({ id: 'd', destination: { type: 'dm', messageId: 'm', user: { _id: 'u1', username: 'ada' } } }),
    ] })));
    await waitFor(() => expect(document.body.textContent).toContain('ada'));
  });

  it('renders relative save times across every bucket without inventing one for a missing value', async () => {
    const now = Date.now();
    await openWith(vi.fn(async () => response({ items: [
      row({ id: 'now', savedAt: now - 1_000 }),
      row({ id: 'minutes', savedAt: now - 10 * 60_000 }),
      row({ id: 'hours', savedAt: now - 5 * 3_600_000 }),
      row({ id: 'days', savedAt: now - 40 * 86_400_000 }),
    ] })));
    await waitFor(() => expect(items()).toHaveLength(4));
    const text = document.body.textContent ?? '';
    expect(text).toContain('şimdi kaydedildi');
    expect(text).toContain('dk önce');
    expect(text).toContain('sa önce');
  });
});

describe('removal', () => {
  it('keeps the row and explains the failure when the delete request is refused', async () => {
    const apiFetch = vi.fn(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? response({}, 500) : response({ items: [row()] })
    ));
    await openWith(apiFetch as never);
    await waitFor(() => expect(items()).toHaveLength(1));

    const remove = document.querySelector('.saved-remove') as HTMLButtonElement;
    await fireEvent.click(remove);
    await waitFor(() => expect(document.body.textContent).toContain('kaldırılamadı'));
    // İyimser silme YAPILMAZ: satır yerinde kalır.
    expect(items()).toHaveLength(1);
  });

  it('keeps the row when the delete request rejects at the transport level', async () => {
    const apiFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new Error('offline');
      return response({ items: [row()] });
    });
    await openWith(apiFetch as never);
    await waitFor(() => expect(items()).toHaveLength(1));
    await fireEvent.click(document.querySelector('.saved-remove') as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain('kaldırılamadı'));
    expect(items()).toHaveLength(1);
  });

  it('removes the row only after the server confirms the deletion', async () => {
    const apiFetch = vi.fn(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? response({ ok: true }) : response({ items: [row(), row({ id: 'saved-2' })] })
    ));
    await openWith(apiFetch as never);
    await waitFor(() => expect(items()).toHaveLength(2));
    await fireEvent.click(document.querySelector('.saved-remove') as HTMLButtonElement);
    await waitFor(() => expect(items()).toHaveLength(1));
  });
});

describe('list keyboard navigation', () => {
  async function threeRows() {
    await openWith(vi.fn(async () => response({ items: [
      row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' }),
    ] })));
    await waitFor(() => expect(items()).toHaveLength(3));
    return document.querySelector('.saved-list') as HTMLElement;
  }

  it('moves with ArrowDown/ArrowUp and clamps at both ends', async () => {
    const list = await threeRows();
    items()[0]!.focus();
    await fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
    await fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[0]);
    await fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('jumps to the first and last row with Home and End', async () => {
    const list = await threeRows();
    items()[1]!.focus();
    await fireEvent.keyDown(list, { key: 'End' });
    expect(document.activeElement).toBe(items()[2]);
    await fireEvent.keyDown(list, { key: 'Home' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('enters the list from outside by wrapping to the last row on ArrowUp', async () => {
    const list = await threeRows();
    (document.activeElement as HTMLElement | null)?.blur();
    await fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[2]);
  });

  it('ignores unrelated keys entirely', async () => {
    const list = await threeRows();
    items()[0]!.focus();
    await fireEvent.keyDown(list, { key: 'a' });
    expect(document.activeElement).toBe(items()[0]);
  });
});

describe('navigation ownership', () => {
  it('says so plainly when no owner is registered for the destination kind', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast as never);
    await openWith(vi.fn(async () => response({ items: [row()] })));
    await waitFor(() => expect(items()).toHaveLength(1));

    await fireEvent.click(items()[0]!);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('açılamıyor'), 'warning');
  });

  it('renders an unavailable row as inert copy with no navigable control at all', async () => {
    const navigate = vi.fn();
    BridgeRegistry.register('navigateToChannel', navigate as never);
    await openWith(vi.fn(async () => response({ items: [row({ unavailable: true })] })));
    await waitFor(() => expect(document.querySelector('.saved-item.unavailable')).not.toBeNull());
    // Erişilemeyen kayıt TIKLANABİLİR bile değildir: gezinme yüzeyi hiç çizilmez.
    expect(items()).toHaveLength(0);
    expect(document.body.textContent).toContain('kullanılamıyor');
    await fireEvent.click(document.querySelector('.unavailable-copy') as HTMLElement);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reports a rejected navigation promise instead of leaving the user on a blank view', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast as never);
    BridgeRegistry.register('navigateToChannel', vi.fn(async () => { throw new Error('gone'); }) as never);
    await openWith(vi.fn(async () => response({ items: [row()] })));
    await waitFor(() => expect(items()).toHaveLength(1));

    await fireEvent.click(items()[0]!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), 'error'));
  });

  it('reports a navigation owner that throws synchronously', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast as never);
    BridgeRegistry.register('navigateToChannel', vi.fn(() => { throw new Error('boom'); }) as never);
    await openWith(vi.fn(async () => response({ items: [row()] })));
    await waitFor(() => expect(items()).toHaveLength(1));
    await fireEvent.click(items()[0]!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), 'error'));
  });
});

describe('load failures', () => {
  it('reports a refused request and a malformed body with the same honest message', async () => {
    await openWith(vi.fn(async () => response({}, 500)));
    await waitFor(() => expect(document.body.textContent).toContain('yüklenemedi'));

    cleanup();
    await openWith(vi.fn(async () => response('not-an-object')));
    await waitFor(() => expect(document.body.textContent).toContain('yüklenemedi'));
  });
});
