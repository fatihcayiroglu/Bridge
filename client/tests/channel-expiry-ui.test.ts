// client/tests/channel-expiry-ui.test.ts — P7 D2 (#321): owner sets/clears a channel's expiry,
// and every member sees an absolute, accessible expiry on the row. Real components; only the
// network (apiFetch), the API base and the permission probe are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: mockApiFetch }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://api' }));
vi.mock('../js/core/permissions/myPermissions.ts', () => ({
  canManageChannels: vi.fn(async () => true),
  clearPermsCache: vi.fn(),
}));

import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import ChannelActionMenu from '../js/core/channel-perms/ChannelActionMenu.svelte';
import ChannelExpiryDialog from '../js/core/channel-perms/ChannelExpiryDialog.svelte';
import ChannelItem from '../js/core/channel-list/ChannelItem.svelte';
import { CLOCK_SKEW_MARGIN_MS, DAY_MS, HOUR_MS } from '../js/core/channel-list/channel-expiry.ts';

const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
const putCalls = () => mockApiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  mockApiFetch.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  for (const k of ['getCurrentServer', 'getMe', 'loadChannels']) BridgeRegistry.unregister(k);
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
}

describe('ChannelExpiryDialog', () => {
  function open(channel: Record<string, unknown>, onSaved = vi.fn(), onClose = vi.fn()) {
    mockApiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? ok({ expiresAt: JSON.parse(String(init.body)).expiresAt, expiryVersion: 7 }) : ok(channel));
    instance = mount(ChannelExpiryDialog, { target: host, props: { serverId: 's1', channelId: 'c1', channelName: '<b>news</b>', onClose, onSaved } });
    return { onSaved, onClose };
  }

  it('sets a 24 h expiry with the version it loaded, then closes', async () => {
    const { onSaved, onClose } = open({ _id: 'c1', expiresAt: null, expiryVersion: 6 });
    await settle();
    expect(document.querySelector('.ce-title')!.textContent).toContain('<b>news</b>');   // text, not HTML
    expect(document.querySelector('.ce-title b')).toBeNull();
    const save = document.querySelector<HTMLButtonElement>('.ce-footer .btn-primary')!;
    expect(save.disabled).toBe(true);                   // "never" on a permanent channel changes nothing
    const before = Date.now();
    document.querySelector<HTMLInputElement>('input[value="24h"]')!.click();
    flushSync();
    expect(save.disabled).toBe(false);
    save.click();
    await settle();
    const [url, init] = putCalls()[0] as [string, RequestInit];
    expect(url).toBe('http://api/api/servers/s1/channels/c1/expiry');
    const body = JSON.parse(String(init.body));
    expect(body.expectedVersion).toBe(6);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + DAY_MS);
    expect(onSaved).toHaveBeenCalledWith(body.expiresAt);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the current absolute expiry and never changes it unless the owner picks something', async () => {
    const at = Date.now() + 3 * DAY_MS;
    open({ _id: 'c1', expiresAt: String(at), expiryVersion: '2' });
    await settle();
    const time = document.querySelector('.ce-current time')!;
    expect(time.getAttribute('datetime')).toBe(new Date(at).toISOString());
    expect(document.querySelector<HTMLInputElement>('input[name="ce-choice"]:checked')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('.ce-footer .btn-primary')!.disabled).toBe(true);
    document.querySelector<HTMLInputElement>('input[value="never"]')!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('.ce-footer .btn-primary')!.click();
    await settle();
    expect(JSON.parse(String((putCalls()[0] as [string, RequestInit])[1].body))).toEqual({ expiresAt: null, expectedVersion: 2 });
  });

  it('keeps "1 hour" inside the server window despite clock skew', async () => {
    open({ _id: 'c1', expiresAt: null, expiryVersion: 0 });
    await settle();
    const before = Date.now();
    document.querySelector<HTMLInputElement>('input[value="1h"]')!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('.ce-footer .btn-primary')!.click();
    await settle();
    const { expiresAt } = JSON.parse(String((putCalls()[0] as [string, RequestInit])[1].body));
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS + CLOCK_SKEW_MARGIN_MS);
  });

  it('explains a refusal and stays open; a version conflict reloads the current state', async () => {
    let version = 1;
    let puts = 0;
    const onClose = vi.fn();
    mockApiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'PUT') return ok({ _id: 'c1', expiresAt: null, expiryVersion: version });
      puts += 1;
      return ok({ code: puts === 1 ? 'VERSION_CONFLICT' : 'LAST_PERMANENT_CHANNEL' }, 409);
    });
    instance = mount(ChannelExpiryDialog, { target: host, props: { serverId: 's1', channelId: 'c1', channelName: 'news', onClose } });
    await settle();
    version = 2;   // someone else changed it
    document.querySelector<HTMLInputElement>('input[value="7d"]')!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('.ce-footer .btn-primary')!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')!.textContent).toMatch(/changed|değişti|\S/);
    expect(mockApiFetch.mock.calls.filter(([, i]) => !(i as RequestInit | undefined)?.method)).toHaveLength(2);  // reloaded
    document.querySelector<HTMLInputElement>('input[value="7d"]')!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('.ce-footer .btn-primary')!.click();
    await settle();
    expect(JSON.parse(String((putCalls()[1] as [string, RequestInit])[1].body)).expectedVersion).toBe(2);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape without saving', async () => {
    const { onClose } = open({ _id: 'c1', expiresAt: null, expiryVersion: 0 });
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
    expect(putCalls()).toHaveLength(0);
  });
});

describe('ChannelActionMenu — expiry item', () => {
  async function openMenu(ownerId: string) {
    BridgeRegistry.register('getCurrentServer', (() => ({ _id: 's1', ownerId })) as AnyFn);
    BridgeRegistry.register('getMe', (() => ({ _id: 'me' })) as AnyFn);
    instance = mount(ChannelActionMenu, { target: host });
    flushSync();
    await BridgeRegistry.call('openChannelMenu', 'c1', 'news', new MouseEvent('click', { clientX: 5, clientY: 5 }));
    flushSync();
  }

  it('is offered to the server owner and opens the dialog for the captured channel', async () => {
    mockApiFetch.mockResolvedValue(ok({ _id: 'c1', expiresAt: null, expiryVersion: 0 }));
    await openMenu('me');
    const items = [...document.querySelectorAll<HTMLButtonElement>('.cam-item')];
    expect(items).toHaveLength(2);
    items[1]!.click();
    await settle();
    expect(document.querySelector('.ce-card')).not.toBeNull();
    expect(String(mockApiFetch.mock.calls[0]![0])).toBe('http://api/api/servers/s1/channels/c1');
  });

  it('is not offered to anyone else (the server refuses them anyway)', async () => {
    await openMenu('someone-else');
    expect(document.querySelectorAll('.cam-item')).toHaveLength(1);
  });
});

describe('ChannelItem — expiry badge', () => {
  it('announces an absolute expiry in the row label and warns within a day', () => {
    const at = Date.now() + 2 * HOUR_MS;
    instance = mount(ChannelItem, { target: host, props: { channel: { _id: 'c1', name: 'news', expiresAt: at }, onSelect: vi.fn() } });
    flushSync();
    const badge = document.querySelector('.ch-expiry-badge')!;
    expect(badge.classList.contains('ch-expiry-soon')).toBe(true);
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.ch-open')!.getAttribute('aria-label')).toContain(String(new Date(at).getFullYear()));
  });

  it('shows nothing for a permanent channel', () => {
    instance = mount(ChannelItem, { target: host, props: { channel: { _id: 'c1', name: 'news', expiresAt: null }, onSelect: vi.fn() } });
    flushSync();
    expect(document.querySelector('.ch-expiry-badge')).toBeNull();
    expect(document.querySelector('.ch-open')!.getAttribute('aria-label')).not.toContain('—');
  });
});
