import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import MemberListPanel from '../js/core/MemberListPanel.svelte';


// Bu dosyanin iddialari INGILIZCE arayuz metnine dayanir.
// Dil, ortamdan (jsdom `navigator.language`) SIZMAMALI; acikca
// belirtilir. Genel test kurulumu urunun birincil dili olan
// Turkce'ye sabitler, burasi onu bilerek ezer.
import { setLocale as __setLocale } from '../js/core/i18n/index.ts';
beforeAll(async () => { await __setLocale('en'); });
const { registry, apiFetch } = vi.hoisted(() => ({
  registry: {} as Record<string, (...args: unknown[]) => unknown>,
  apiFetch: vi.fn(),
}));

vi.mock('../js/core/api-fetch.js', () => ({ apiFetch }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://bridge.test' }));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: (key: string, fn: (...args: unknown[]) => unknown) => { registry[key] = fn; },
    unregister: (key: string) => { delete registry[key]; },
    call: (key: string, ...args: unknown[]) => registry[key]?.(...args),
    has: (key: string) => typeof registry[key] === 'function',
    // The canonical registry also exposes `get` (returns the registered value,
    // or null). Production reads owners with it; omitting it from the double
    // threw "BridgeRegistry.get is not a function" before a single assertion ran.
    get: (key: string) => registry[key] ?? null,
  },
}));

function response(data: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: vi.fn(async () => data) } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(registry).forEach(key => delete registry[key]);
  document.body.innerHTML = `
    <aside id="member-list"><div id="member-list-content"></div></aside>
    <button id="btn-members" aria-expanded="true"></button>
  `;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('MemberListPanel — canonical production owner', () => {
  it('loads the selected server and renders dense online/offline groups', async () => {
    apiFetch.mockResolvedValue(response([
      { _id: 'a', displayName: 'Maya Kim', status: 'online', avatarColor: '#8257e6', activity: 'Design systems' },
      { _id: 'b', displayName: 'Nora Vale', status: 'offline', avatarColor: '#676b78' },
    ]));
    const view = render(MemberListPanel);

    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));

    await waitFor(() => expect(view.getByText('Maya Kim')).toBeInTheDocument());
    expect(view.getByText('Online — 1')).toBeInTheDocument();
    expect(view.getByText('Offline — 1')).toBeInTheDocument();
    expect(view.getByText('Design systems')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('http://bridge.test/api/servers/server-1/members');
  });

  it('renders user-controlled names as text and rejects unsafe avatar schemes', async () => {
    apiFetch.mockResolvedValue(response([
      { _id: 'x', displayName: '<img src=x onerror=alert(1)>', status: 'online', avatarUrl: 'javascript:alert(1)' },
    ]));
    const view = render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));

    await waitFor(() => expect(view.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument());
    expect(view.container.querySelector('.member-avatar img')).toBeNull();
    expect(view.container.querySelector('script')).toBeNull();
  });

  it('owns the desktop member toggle without duplicating member state', async () => {
    render(MemberListPanel);
    await waitFor(() => expect(registry.toggleMemberList).toBeTypeOf('function'));
    const panel = document.getElementById('member-list')!;
    const button = document.getElementById('btn-members')!;

    registry.toggleMemberList();
    expect(panel).toHaveClass('is-collapsed');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    registry.toggleMemberList();
    expect(panel).not.toHaveClass('is-collapsed');
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('exposes a compact retry state without leaking raw response bodies', async () => {
    apiFetch.mockResolvedValueOnce(response({}, false)).mockResolvedValueOnce(response([]));
    const view = render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));

    const retry = await view.findByRole('button', { name: 'Try again' });
    expect(view.getByText('Members could not be loaded.')).toBeInTheDocument();
    await retry.click();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  });

  it('opens the canonical profile owner and falls back to DM when it is unavailable', async () => {
    apiFetch.mockResolvedValue(response([
      { id: 'legacy-id', nickname: 'Lin', username: 'lin', status: 'idle', avatarColor: '#abcd' },
    ]));
    const openProfile = vi.fn();
    const openDm = vi.fn();
    registry.openMemberProfile = openProfile;
    registry.openDm = openDm;
    const view = render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));
    const row = await view.findByRole('button', { name: /Lin.*Open profile/i });

    await fireEvent.click(row);
    expect(openProfile).toHaveBeenCalledWith('legacy-id');
    expect(openDm).not.toHaveBeenCalled();

    delete registry.openMemberProfile;
    await fireEvent.click(row);
    expect(openDm).toHaveBeenCalledWith('legacy-id', 'Lin', '#abcd');

    delete registry.openDm;
    await expect(fireEvent.click(row)).resolves.toBe(true);
  });

  it('normalizes hostile member payloads and de-duplicates canonical identities', async () => {
    apiFetch.mockResolvedValue(response([
      null, 'not-an-object', [], {},
      { _id: 'same', displayName: 'First', status: 'online' },
      { _id: 'same', displayName: 'Shadow', status: 'offline' },
      { id: 'second', displayName: 'Second', status: 'offline' },
    ]));
    const view = render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));

    await waitFor(() => expect(view.getByText('First')).toBeInTheDocument());
    expect(view.getByText('Second')).toBeInTheDocument();
    expect(view.queryByText('Shadow')).not.toBeInTheDocument();
    expect(view.getByLabelText('2 Members')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.member-row')).toHaveLength(2);
  });

  it('accepts only real CSS hex lengths and permits only local/http avatar URLs', async () => {
    apiFetch.mockResolvedValue(response([
      { _id: 'bad-color', displayName: 'Bad Color', avatarColor: '#12345', avatarUrl: 'ftp://evil.test/a.png' },
      { _id: 'local', displayName: 'Local Avatar', avatarColor: '#abcd', avatarUrl: '/avatars/local.png' },
      { _id: 'remote', displayName: 'Remote Avatar', avatarColor: '#11223344', avatarUrl: 'https://cdn.test/a.png' },
    ]));
    const view = render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));
    await waitFor(() => expect(view.getByText('Bad Color')).toBeInTheDocument());

    const rows = [...view.container.querySelectorAll<HTMLElement>('.member-row')];
    expect(rows[0].querySelector('.member-avatar')?.getAttribute('style')).toContain('var(--brand)');
    expect(rows[0].querySelector('img')).toBeNull();
    expect(rows[1].querySelector('.member-avatar')?.getAttribute('style')).not.toContain('var(--brand)');
    expect(rows[1].querySelector('img')?.getAttribute('src')).toBe('http://bridge.test/avatars/local.png');
    expect(rows[2].querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/a.png');
  });

  it('keeps the newest server response authoritative when requests resolve out of order', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    apiFetch
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    const view = render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'old/server' } }));
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'new server' } }));

    resolveSecond(response([{ _id: 'new', displayName: 'Newest', status: 'online' }]));
    await waitFor(() => expect(view.getByText('Newest')).toBeInTheDocument());
    resolveFirst(response([{ _id: 'old', displayName: 'Stale', status: 'online' }]));
    await Promise.resolve();
    await Promise.resolve();

    expect(view.queryByText('Stale')).not.toBeInTheDocument();
    expect(view.getByRole('region', { name: 'Members' })).toHaveAttribute('aria-busy', 'false');
    expect(apiFetch).toHaveBeenNthCalledWith(1, 'http://bridge.test/api/servers/old%2Fserver/members');
    expect(apiFetch).toHaveBeenNthCalledWith(2, 'http://bridge.test/api/servers/new%20server/members');
  });

  it('auto-loads the current server and lets the registry refresh that same owner', async () => {
    registry.getCurrentServer = () => ({ _id: 'auto' });
    apiFetch
      .mockResolvedValueOnce(response([{ _id: 'a', displayName: 'Initial', status: 'online' }]))
      .mockResolvedValueOnce(response([{ _id: 'b', displayName: 'Refreshed', status: 'online' }]));
    const view = render(MemberListPanel);

    await waitFor(() => expect(view.getByText('Initial')).toBeInTheDocument());
    await registry.loadMembers();
    await waitFor(() => expect(view.getByText('Refreshed')).toBeInTheDocument());
    expect(registry.getCurrentServerMembers()).toEqual([expect.objectContaining({ _id: 'b' })]);
    expect(registry.currentServerMembers()).toEqual([expect.objectContaining({ _id: 'b' })]);
  });

  it('ignores empty load requests and handles non-array or non-Error failures safely', async () => {
    apiFetch.mockResolvedValueOnce(response({ members: [] })).mockRejectedValueOnce('offline');
    const view = render(MemberListPanel);
    await registry.loadMembers();
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: {} }));
    await Promise.resolve();
    expect(apiFetch).not.toHaveBeenCalled();

    await registry.loadMembers('server-1');
    await waitFor(() => expect(view.getByText('No members to show yet.')).toBeInTheDocument());
    await registry.loadMembers('server-2');
    expect(await view.findByRole('alert')).toHaveTextContent('Members could not be loaded.');
  });

  it('renders a pending load and all canonical name, status, badge, and avatar fallbacks', async () => {
    let resolveMembers!: (value: Response) => void;
    apiFetch.mockReturnValue(new Promise<Response>((resolve) => { resolveMembers = resolve; }));
    const view = render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));
    await waitFor(() => expect(view.getByRole('region', { name: 'Members' })).toHaveAttribute('aria-busy', 'true'));
    expect(view.getByText('Loading members…')).toBeInTheDocument();

    resolveMembers(response([
      { _id: 'nick', nickname: 'Nick Name', status: 'dnd', badge: 'MOD' },
      { _id: 'user', username: 'username-only', status: 'mystery' },
      { _id: 'fallback', status: 'online', avatarUrl: 'http://[::1' },
      { _id: 'off', displayName: 'Offline Avatar', status: 'offline', badge: 'BOT', avatarUrl: '/avatars/off.png' },
    ]));

    await waitFor(() => expect(view.getByText('Nick Name')).toBeInTheDocument());
    expect(view.getByText('username-only')).toBeInTheDocument();
    expect(view.getByText('Bridge member')).toBeInTheDocument();
    expect(view.getByText('MOD')).toBeInTheDocument();
    expect(view.getByText('BOT')).toBeInTheDocument();
    expect(view.getByRole('button', { name: /Nick Name.*Open profile/i })).toHaveAttribute('title', expect.stringContaining('Do not disturb'));
    expect(view.getByRole('button', { name: /username-only.*Open profile/i })).toHaveAttribute('title', expect.stringContaining('Online'));
    expect(view.getByRole('button', { name: /Offline Avatar.*Open profile/i })).toHaveAttribute('title', expect.stringContaining('Offline'));
    expect(view.getByText('Bridge member').closest('.member-row')?.querySelector('img')).toBeNull();
    expect(view.getByText('Offline Avatar').closest('.member-row')?.querySelector('img')?.getAttribute('src')).toBe('http://bridge.test/avatars/off.png');
  });

  it('restores a hidden member list and safely ignores a missing shell panel', async () => {
    render(MemberListPanel);
    await waitFor(() => expect(registry.toggleMemberList).toBeTypeOf('function'));
    const panel = document.getElementById('member-list')!;
    const button = document.getElementById('btn-members')!;
    panel.hidden = true;
    panel.classList.add('is-collapsed');

    registry.toggleMemberList();
    expect(panel.hidden).toBe(false);
    expect(panel).not.toHaveClass('is-collapsed');
    expect(button).toHaveAttribute('aria-expanded', 'true');

    panel.remove();
    await expect(Promise.resolve(registry.toggleMemberList())).resolves.toBeUndefined();
  });
});
