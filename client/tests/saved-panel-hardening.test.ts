import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SavedPanel from '../js/core/SavedPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function savedChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'saved-1', savedAt: Date.now(), unavailable: false, preview: 'Private follow-up',
    sender: { _id: 'sender-1', displayName: 'Ada' },
    destination: {
      type: 'channel', messageId: 'message-1', channelId: 'channel-1', serverId: 'server-1',
      channel: { _id: 'channel-1', name: 'private' },
      server: { _id: 'server-1', name: 'Team' },
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  for (const key of [
    'apiFetch', 'showSaved', 'openSaved', 'saveForLater', 'navigateToChannel',
    'openDm', 'groupDmPanel:openGroupDm', 'toast',
  ]) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SavedPanel hardening', () => {
  it('malformed/duplicate rows are filtered and broken destinations become truthful unavailable rows', async () => {
    const navigate = vi.fn();
    const openGroup = vi.fn();
    BridgeRegistry.register('navigateToChannel', navigate);
    BridgeRegistry.register('groupDmPanel:openGroupDm', openGroup);
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [
      null,
      {},
      savedChannel({
        destination: {
          type: 'channel', messageId: 'message-1', channelId: 'channel-1',
          channel: { _id: 'channel-1', name: 'private' },
          server: { _id: 'server-1', name: 'Team', iconUrl: 'javascript:alert(1)' },
        },
      }),
      savedChannel({ preview: 'duplicate must not render' }),
      { id: 'broken', savedAt: 'yesterday', unavailable: false, preview: { html: '<img>' }, destination: { type: 'dm', messageId: 'm', user: null } },
      {
        id: 'group', savedAt: Date.now() - 90_000, unavailable: false, preview: 'Group follow-up',
        destination: {
          type: 'gdm', messageId: 'gm-1', groupId: 'g-1',
          group: { _id: 'g-1', name: 'Launch Crew', icon: 'javascript:alert(2)' },
        },
      },
    ] })) as AnyFn);
    const view = render(SavedPanel);

    BridgeRegistry.call('showSaved');
    await view.findByText('Private follow-up');
    expect(view.queryByText('duplicate must not render')).toBeNull();
    expect(view.getAllByText('Mesaj artık kullanılamıyor')).toHaveLength(1);

    await fireEvent.click(view.getByText('Private follow-up').closest('button')!);
    expect(navigate).toHaveBeenCalledWith('channel-1', 'message-1', {
      _id: 'server-1', name: 'Team',
    });

    BridgeRegistry.call('showSaved');
    await fireEvent.click((await view.findByText('Group follow-up')).closest('button')!);
    expect(openGroup).toHaveBeenCalledWith({ _id: 'g-1', name: 'Launch Crew', icon: null, ownerId: undefined }, 'gm-1');
  });

  it('malformed success JSON and backend details produce a stable generic load error', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('secret parser/backend detail'); } } as Response)
      .mockResolvedValueOnce(response({ error: 'internal SQL tenant-a detail' }, 500));
    BridgeRegistry.register('apiFetch', api as AnyFn);
    const view = render(SavedPanel);

    BridgeRegistry.call('showSaved');
    let alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('Kaydedilenler yüklenemedi. Lütfen tekrar deneyin.');
    expect(alert.textContent).not.toMatch(/secret|parser|SQL|tenant-a/i);

    await fireEvent.click(view.getByRole('button', { name: 'Yeniden dene' }));
    alert = await view.findByRole('alert');
    expect(alert.textContent).not.toMatch(/SQL|tenant-a/i);
  });

  it('saveForLater yalnız tanınan destination türü ve string kimliklerle ağ sınırına gider', async () => {
    const api = vi.fn(async () => response({ created: true }, 201));
    BridgeRegistry.register('apiFetch', api as AnyFn);
    render(SavedPanel);

    expect(await BridgeRegistry.call<Promise<boolean>>('saveForLater', {
      destinationType: 'admin', destinationId: 'x', messageId: 'm',
    })).toBe(false);
    expect(await BridgeRegistry.call<Promise<boolean>>('saveForLater', {
      destinationType: 'channel', destinationId: { value: 'x' }, messageId: 'm',
    })).toBe(false);
    expect(api).not.toHaveBeenCalled();

    expect(await BridgeRegistry.call<Promise<boolean>>('saveForLater', {
      destinationType: 'dm', destinationId: 'dm-1', messageId: 'm-1', extraPrivateBody: 'must-drop',
    })).toBe(true);
    const body = JSON.parse(String(api.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ destinationType: 'dm', destinationId: 'dm-1', messageId: 'm-1' });
  });

  it('logout invalidates an in-flight save so old-user success cannot toast or reload in the next session', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const api = vi.fn(() => pending);
    const toast = vi.fn();
    BridgeRegistry.register('apiFetch', api as AnyFn);
    BridgeRegistry.register('toast', toast);
    render(SavedPanel);

    const saving = BridgeRegistry.call<Promise<boolean>>('saveForLater', {
      destinationType: 'channel', destinationId: 'channel-a', messageId: 'message-a',
    })!;
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    resolve(response({ created: true }, 201));

    expect(await saving).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('DELETE network rejection is handled in-panel without leaking the thrown detail', async () => {
    const api = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') throw new Error('private network topology');
      return response({ items: [savedChannel()] });
    });
    BridgeRegistry.register('apiFetch', api as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await fireEvent.click(await view.findByRole('button', { name: 'Saved listesinden kaldır' }));
    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('Kayıt kaldırılamadı. Lütfen tekrar deneyin.');
    expect(alert.textContent).not.toContain('private network topology');
  });

  it('missing navigation owner keeps Saved open and tells the truth instead of silently closing', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [savedChannel()] })) as AnyFn);
    BridgeRegistry.register('toast', toast);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await fireEvent.click((await view.findByText('Private follow-up')).closest('button')!);

    expect(view.getByRole('dialog', { name: t('saved_title') })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith('Bu konuşma şu anda açılamıyor.', 'warning');
  });

  it('navigation rejection is caught and row navigation does not steal focus back from the destination', async () => {
    const trigger = document.createElement('button');
    const destinationFocus = document.createElement('button');
    document.body.append(trigger, destinationFocus);
    trigger.focus();
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [savedChannel()] })) as AnyFn);
    BridgeRegistry.register('navigateToChannel', (() => {
      destinationFocus.focus();
      return Promise.reject(new Error('navigation failed'));
    }) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await fireEvent.click((await view.findByText('Private follow-up')).closest('button')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('İşlem tamamlanamadı. Lütfen tekrar deneyin.', 'error'));
    expect(document.activeElement).toBe(destinationFocus);
  });

  it('closing cancels a pending load so hidden private rows cannot commit on reopen', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const api = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(response({ items: [] }));
    BridgeRegistry.register('apiFetch', api as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await view.findByRole('dialog', { name: t('saved_title') });

    await fireEvent.click(view.getByRole('button', { name: 'Kaydedilenler panelini kapat' }));
    resolve(response({ items: [savedChannel({ preview: 'stale tenant-a private' })] }));
    await Promise.resolve();
    BridgeRegistry.call('showSaved');

    await view.findByText('Henüz kayıt yok');
    expect(view.queryByText('stale tenant-a private')).toBeNull();
  });

  it('missing API ownership and malformed item shapes fail closed with the same truthful load error', async () => {
    const missingOwner = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    expect((await missingOwner.findByRole('alert')).textContent)
      .toContain('Kaydedilenler yüklenemedi. Lütfen tekrar deneyin.');
    missingOwner.unmount();

    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: { id: 'not-an-array' } })) as AnyFn);
    const malformed = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    expect((await malformed.findByRole('alert')).textContent)
      .toContain('Kaydedilenler yüklenemedi. Lütfen tekrar deneyin.');
    expect(malformed.queryByText('Henüz kayıt yok')).toBeNull();
  });

  it('renders safe identity, destination, preview, and relative-time fallbacks for partial live data', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [
      savedChannel({
        id: 'partial-channel', savedAt: now - 2 * 3_600_000, preview: '',
        sender: { username: 'username-only' },
        destination: {
          type: 'channel', messageId: 'm-channel', channelId: 'channel-fallback',
          channel: { _id: 'channel-fallback' }, server: { _id: 'server-fallback' },
        },
      }),
      savedChannel({
        id: 'partial-channel-without-summaries', savedAt: now - 5 * 60_000,
        preview: 'Channel summaries absent', sender: { displayName: 'Channel Sender' },
        destination: { type: 'channel', messageId: 'm-channel-2', channelId: 'channel-no-summary' },
      }),
      {
        id: 'partial-dm', savedAt: now - 30_000, preview: 'Direct fallback',
        destination: { type: 'dm', messageId: 'm-dm', user: { _id: 'user-2', username: 'dm-user' } },
      },
      {
        id: 'partial-gdm', savedAt: 0, preview: 'Group fallback',
        destination: { type: 'gdm', messageId: 'm-gdm', group: { _id: 'group-2' } },
      },
      {
        id: 'old-dm', savedAt: now - 3 * 86_400_000, preview: 'Old direct row',
        destination: { type: 'dm', messageId: 'm-old', user: { _id: 'user-old', displayName: 'Old User' } },
      },
    ] })) as AnyFn);
    const view = render(SavedPanel);

    BridgeRegistry.call('showSaved');
    await view.findByText('username-only');
    expect(view.getByText('Mesaj')).toBeTruthy();
    expect(view.getAllByText('Bridge · #kanal')).toHaveLength(2);
    expect(view.getByText('2 sa önce')).toBeTruthy();
    expect(view.getByText('dm-user')).toBeTruthy();
    expect(view.getByText('şimdi kaydedildi')).toBeTruthy();
    expect(view.getByText('Grup DM')).toBeTruthy();
    expect(view.getByText('Old direct row').closest('button')?.querySelector('small')?.textContent).not.toBe('');
  });

  it('malformed nested identities and destination IDs become unavailable instead of executable rows', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [
      { id: 'dm-no-id', savedAt: Date.now(), sender: {}, destination: { type: 'dm', messageId: 'm1', user: { username: 'name-without-id' } } },
      { id: 'channel-no-id', savedAt: Date.now(), destination: { type: 'channel', messageId: 'm2', channelId: '' } },
      { id: 'gdm-no-group', savedAt: Date.now(), destination: { type: 'gdm', messageId: 'm3', group: {} } },
      { id: 'bad-type', savedAt: Date.now(), destination: { type: 'external', messageId: 'm4' } },
    ] })) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    expect(await view.findAllByText('Mesaj artık kullanılamıyor')).toHaveLength(4);
    expect(view.container.querySelectorAll('[data-saved-item]')).toHaveLength(0);
    expect(view.getAllByRole('button', { name: 'Saved listesinden kaldır' })).toHaveLength(4);
  });

  it('duplicate saves refresh an open panel, while malformed or rejected saves disclose no backend detail', async () => {
    const toast = vi.fn();
    let getCount = 0;
    let postCount = 0;
    const api = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method !== 'POST') {
        getCount += 1;
        return response({ items: getCount === 1 ? [] : [savedChannel({ preview: 'refreshed saved row' })] });
      }
      postCount += 1;
      if (postCount === 1) return response({ created: false });
      if (postCount === 2) return response(null);
      return response({ error: 'private tenant SQL trace' }, 503);
    });
    BridgeRegistry.register('apiFetch', api as AnyFn);
    BridgeRegistry.register('toast', toast);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await view.findByText('Henüz kayıt yok');

    const target = { destinationType: 'channel', destinationId: 'channel-1', messageId: 'message-1' } as const;
    expect(await BridgeRegistry.call<Promise<boolean>>('saveForLater', target)).toBe(true);
    expect(toast).toHaveBeenCalledWith('Bu mesaj zaten Saved listende.', 'success');
    await view.findByText('refreshed saved row');

    expect(await BridgeRegistry.call<Promise<boolean>>('saveForLater', target)).toBe(false);
    expect(await BridgeRegistry.call<Promise<boolean>>('saveForLater', target)).toBe(false);
    const errorMessages = toast.mock.calls.filter(call => call[1] === 'error').map(call => String(call[0]));
    expect(errorMessages).toEqual([
      'Mesaj kaydedilemedi. Lütfen tekrar deneyin.',
      'Mesaj kaydedilemedi. Lütfen tekrar deneyin.',
    ]);
    expect(errorMessages.join(' ')).not.toMatch(/tenant|SQL|trace/i);
  });

  it('a rejected DELETE response stays generic and retains the row for a safe retry', async () => {
    const api = vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'DELETE'
      ? response({ error: 'private authorization detail' }, 403)
      : response({ items: [savedChannel()] }));
    BridgeRegistry.register('apiFetch', api as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await fireEvent.click(await view.findByRole('button', { name: 'Saved listesinden kaldır' }));
    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('Kayıt kaldırılamadı. Lütfen tekrar deneyin.');
    expect(alert.textContent).not.toMatch(/private|authorization/i);
    expect(view.getByText('Private follow-up')).toBeTruthy();
  });

  it('logout invalidates an in-flight delete so tenant A completion cannot mutate tenant B rows', async () => {
    let resolveDelete!: (value: Response) => void;
    const pendingDelete = new Promise<Response>(done => { resolveDelete = done; });
    let getCount = 0;
    const api = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') return pendingDelete;
      getCount += 1;
      return Promise.resolve(response({ items: [savedChannel({
        id: getCount === 1 ? 'tenant-a' : 'tenant-b',
        preview: getCount === 1 ? 'tenant A private row' : 'tenant B safe row',
      })] }));
    });
    BridgeRegistry.register('apiFetch', api as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await fireEvent.click(await view.findByRole('button', { name: 'Saved listesinden kaldır' }));
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    resolveDelete(response({ removed: true }));
    await Promise.resolve();
    BridgeRegistry.call('showSaved');

    await view.findByText('tenant B safe row');
    expect(view.queryByText('tenant A private row')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('catches synchronous navigation owner failures after closing without restoring stale focus', async () => {
    const trigger = document.createElement('button');
    const destinationFocus = document.createElement('button');
    document.body.append(trigger, destinationFocus);
    trigger.focus();
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [savedChannel()] })) as AnyFn);
    BridgeRegistry.register('navigateToChannel', (() => {
      destinationFocus.focus();
      throw new Error('synchronous private navigation detail');
    }) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');

    await fireEvent.click((await view.findByText('Private follow-up')).closest('button')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('İşlem tamamlanamadı. Lütfen tekrar deneyin.', 'error'));
    expect(view.queryByRole('dialog', { name: t('saved_title') })).toBeNull();
    expect(document.activeElement).toBe(destinationFocus);
  });

  it('logout during the navigation handoff prevents an old-tenant owner invocation', async () => {
    const navigate = vi.fn();
    BridgeRegistry.register('navigateToChannel', navigate);
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [savedChannel()] })) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    const row = (await view.findByText('Private follow-up')).closest('button')!;

    row.click();
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    await Promise.resolve();
    await Promise.resolve();

    expect(navigate).not.toHaveBeenCalled();
    expect(view.queryByRole('dialog', { name: t('saved_title') })).toBeNull();
  });

  it('closing while response JSON is pending prevents the decoded old-tenant list from committing', async () => {
    let resolveJson!: (value: unknown) => void;
    const pendingJson = new Promise<unknown>(done => { resolveJson = done; });
    const json = vi.fn(() => pendingJson);
    const api = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json } as unknown as Response)
      .mockResolvedValueOnce(response({ items: [savedChannel({ id: 'tenant-b', preview: 'tenant B current row' })] }));
    BridgeRegistry.register('apiFetch', api as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await waitFor(() => expect(json).toHaveBeenCalledOnce());

    await fireEvent.click(view.getByRole('button', { name: 'Kaydedilenler panelini kapat' }));
    resolveJson({ items: [savedChannel({ id: 'tenant-a', preview: 'tenant A decoded row' })] });
    await Promise.resolve();
    BridgeRegistry.call('showSaved');

    await view.findByText('tenant B current row');
    expect(view.queryByText('tenant A decoded row')).toBeNull();
  });

  it('logout during save JSON decoding or rejection suppresses stale success and error toasts', async () => {
    let resolveJson!: (value: unknown) => void;
    let rejectRequest!: (reason?: unknown) => void;
    const pendingJson = new Promise<unknown>(done => { resolveJson = done; });
    const pendingReject = new Promise<Response>((_done, reject) => { rejectRequest = reject; });
    const json = vi.fn(() => pendingJson);
    const api = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json } as unknown as Response)
      .mockReturnValueOnce(pendingReject);
    const toast = vi.fn();
    BridgeRegistry.register('apiFetch', api as AnyFn);
    BridgeRegistry.register('toast', toast);
    render(SavedPanel);
    const target = { destinationType: 'dm', destinationId: 'dm-a', messageId: 'message-a' } as const;

    const decoding = BridgeRegistry.call<Promise<boolean>>('saveForLater', target)!;
    await waitFor(() => expect(json).toHaveBeenCalledOnce());
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    resolveJson({ created: true });
    expect(await decoding).toBe(false);

    const rejecting = BridgeRegistry.call<Promise<boolean>>('saveForLater', target)!;
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    rejectRequest(new Error('old tenant private network detail'));
    expect(await rejecting).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('supports bounded list keyboard navigation and Escape closes back to the original trigger', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [
      savedChannel({ id: 'first', preview: 'first row' }),
      savedChannel({ id: 'second', preview: 'second row' }),
      savedChannel({ id: 'third', preview: 'third row' }),
      { id: 'disabled', unavailable: true, savedAt: Date.now(), preview: 'not focusable' },
    ] })) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await view.findByText('third row');
    const rows = [...view.container.querySelectorAll<HTMLButtonElement>('[data-saved-item]')];

    rows[1]!.focus();
    await fireEvent.keyDown(rows[1]!, { key: 'End' });
    expect(document.activeElement).toBe(rows[2]);
    await fireEvent.keyDown(rows[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    await fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[0]);
    await fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);

    const list = view.getByRole('list', { name: 'Kaydedilen mesajlar' });
    view.getByRole('button', { name: 'Kaydedilenler panelini kapat' }).focus();
    await fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[2]);
    await fireEvent.keyDown(list, { key: 'PageDown' });
    expect(document.activeElement).toBe(rows[2]);

    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('dialog', { name: t('saved_title') })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('an unavailable-only list ignores navigation keys because it has no executable destination', async () => {
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [
      { id: 'unavailable-only', savedAt: Date.now(), unavailable: true },
    ] })) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await view.findByText('Mesaj artık kullanılamıyor');
    const closeButton = view.getByRole('button', { name: 'Kaydedilenler panelini kapat' });
    closeButton.focus();

    await fireEvent.keyDown(view.getByRole('list', { name: 'Kaydedilen mesajlar' }), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(closeButton);
    await fireEvent.keyDown(closeButton, { key: 'Home' });
    expect(document.activeElement).toBe(closeButton);
  });

  it('destroy invalidates a pending load and unregisters public entry points before it settles', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    BridgeRegistry.register('apiFetch', vi.fn(() => pending) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await view.findByRole('dialog', { name: t('saved_title') });

    view.unmount();
    expect(BridgeRegistry.has('showSaved')).toBe(false);
    expect(BridgeRegistry.has('openSaved')).toBe(false);
    expect(BridgeRegistry.has('saveForLater')).toBe(false);
    resolve(response({ items: [savedChannel({ preview: 'must never mount' })] }));
    await Promise.resolve();
  });
});

// Final21 UX: panel keydown'ı durduruyordu; odak panelin İÇİNDEYKEN Esc pencere düzeyindeki
// işleyiciye hiç ulaşmıyor ve panel kapanmıyordu (Inbox ile aynı kusur; ölçüldü).
describe('Escape with focus inside the panel', () => {
  it('closes from a focused row and returns focus to the trigger', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    BridgeRegistry.register('apiFetch', vi.fn(async () => response({ items: [savedChannel({ id: 'only', preview: 'only row' })] })) as AnyFn);
    const view = render(SavedPanel);
    BridgeRegistry.call('showSaved');
    await view.findByText('only row');
    const row = view.container.querySelector<HTMLButtonElement>('[data-saved-item]')!;
    row.focus();
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    row.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(view.queryByRole('dialog', { name: t('saved_title') })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
