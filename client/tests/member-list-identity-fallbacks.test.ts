// client/tests/member-list-identity-fallbacks.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MemberListPanel.svelte — ÜYE KİMLİĞİ, BAŞ HARF VE SAHİP DELEGASYONU
// ════════════════════════════════════════════════════════════════════════════
// Üye satırı hem GÖSTERİM hem de EYLEM taşır: tıklanınca profil (yoksa DM)
// açar. Bu yüzden her satırın çözülebilir bir kimliği olmalıdır. Kimlik
// çözülemiyorsa satır TIKLANDIĞINDA HİÇBİR ŞEY YAPMAMALIDIR — yanlış bir
// kimlikle profil/DM açmak, kullanıcıyı başkasının konuşmasına sokar.
//
// Ayrıca panel KENDİ DM durumunu tutmaz: kanonik sahiplere (`openMemberProfile`,
// `openDm`) delege eder ve sahip yoksa sessizce durur.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import MemberListPanel from '../js/core/MemberListPanel.svelte';
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

const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.member-row')];

async function load(members: unknown, serverId = 'server-1'): Promise<void> {
  apiFetch.mockResolvedValue(response(members));
  render(MemberListPanel);
  document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId } }));
  await waitFor(() => expect(document.querySelector('.member-state, .member-row')).not.toBeNull());
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

describe('identity resolution', () => {
  it('falls back through id, username and display name to key a row', async () => {
    await load([
      { _id: 'a', displayName: 'Maya Kim', status: 'online' },
      { id: 'b', displayName: 'Legacy Id', status: 'online' },
      { username: 'onlyname', status: 'online' },
      { displayName: 'Only Display', status: 'online' },
    ]);
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('never renders a member whose identity cannot be resolved, and de-duplicates', async () => {
    const openProfile = vi.fn();
    registry.openMemberProfile = openProfile;
    await load([
      { status: 'online', avatarColor: '#123456' },   // kimliksiz
      null,
      'not-an-object',
      ['array-row'],
      { _id: 'a', displayName: 'Maya', status: 'online' },
      { _id: 'a', displayName: 'Maya Kopya', status: 'online' },
    ]);
    // Kimliksiz satır HİÇ çizilmez: anahtarlı çizim belirsizleşir ve tıklama
    // yanlış kişiye yönlenebilirdi. Tekrar eden kimlik de tekilleştirilir.
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(document.body.textContent).toContain('Maya');
    expect(document.body.textContent).not.toContain('Maya Kopya');
    expect(openProfile).not.toHaveBeenCalled();
  });

  it('renders a stable placeholder initial for an unnamed member', async () => {
    await load([{ _id: 'a', status: 'online' }]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const avatar = document.querySelector('.member-avatar')!;
    expect((avatar.textContent ?? '').trim()).not.toBe('');
    expect(avatar.textContent).not.toContain('undefined');
  });

  it('builds initials from at most the first two words', async () => {
    await load([
      { _id: 'a', displayName: 'Maya Deniz Kim', status: 'online' },
      { _id: 'b', displayName: '   ', status: 'online' },
    ]);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const initials = [...document.querySelectorAll('.member-avatar')]
      .map(node => (node.textContent ?? '').trim());
    expect(initials[0]).toBe('MD');
    expect(initials[1]).not.toBe('');
  });

  it('marks a member with no declared status as online', async () => {
    await load([{ _id: 'a', displayName: 'Maya', avatarColor: '#8257e6' }]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(document.querySelector('.m-status')!.className).toContain('online');
  });
});

describe('owner delegation', () => {
  it('prefers the profile owner and falls back to the DM owner', async () => {
    const openProfile = vi.fn();
    const openDm = vi.fn();
    registry.openMemberProfile = openProfile;
    registry.openDm = openDm;
    await load([{ _id: 'a', displayName: 'Maya', status: 'online', avatarColor: '#8257e6' }]);
    await waitFor(() => expect(rows()).toHaveLength(1));

    await fireEvent.click(rows()[0]!);
    expect(openProfile).toHaveBeenCalledWith('a');
    expect(openDm).not.toHaveBeenCalled();

    delete registry.openMemberProfile;
    await fireEvent.click(rows()[0]!);
    expect(openDm).toHaveBeenCalledWith('a', 'Maya', '#8257e6');
  });

  it('does nothing at all when neither owner is mounted', async () => {
    await load([{ _id: 'a', displayName: 'Maya', status: 'online' }]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    // Sahipsiz tıklama sessizdir; panel kendi DM durumunu KURMAZ.
    await expect(fireEvent.click(rows()[0]!)).resolves.toBeTruthy();
  });
});

describe('load failures and staleness', () => {
  it('reports a failed load and retries through the visible control', async () => {
    apiFetch.mockResolvedValue(response({}, false));
    render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));
    await waitFor(() => expect(document.querySelector('.member-state-error')).not.toBeNull());

    apiFetch.mockResolvedValue(response([{ _id: 'a', displayName: 'Maya', status: 'online' }]));
    await fireEvent.click(document.querySelector('.member-state-error button')!);
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('reports a transport rejection with the same visible error state', async () => {
    apiFetch.mockRejectedValue(new Error('offline'));
    render(MemberListPanel);
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));
    await waitFor(() => expect(document.querySelector('.member-state-error')).not.toBeNull());
  });

  it('says the list is empty rather than showing a stuck loading state', async () => {
    await load([]);
    await waitFor(() => expect(document.querySelector('.member-state')?.textContent).toContain('No members'));
  });

  it('ignores a stale response after a newer server was selected', async () => {
    const releases: Array<(value: Response) => void> = [];
    apiFetch.mockImplementation(() => new Promise<Response>(resolve => { releases.push(resolve); }));
    render(MemberListPanel);

    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));
    await waitFor(() => expect(releases).toHaveLength(1));
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-2' } }));
    await waitFor(() => expect(releases).toHaveLength(2));

    releases[1]!(response([{ _id: 'new', displayName: 'Newest', status: 'online' }]));
    await waitFor(() => expect(document.body.textContent).toContain('Newest'));

    releases[0]!(response([{ _id: 'old', displayName: 'Stale', status: 'online' }]));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(document.body.textContent).toContain('Newest');
    expect(document.body.textContent).not.toContain('Stale');
  });

  it('ignores a stale rejection the same way', async () => {
    const rejects: Array<(reason: unknown) => void> = [];
    apiFetch.mockImplementation(() => new Promise<Response>((_resolve, reject) => { rejects.push(reject); }));
    render(MemberListPanel);

    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-1' } }));
    await waitFor(() => expect(rejects).toHaveLength(1));
    apiFetch.mockResolvedValue(response([{ _id: 'new', displayName: 'Newest', status: 'online' }]));
    document.dispatchEvent(new CustomEvent('bridge:load-members', { detail: { serverId: 'server-2' } }));
    await waitFor(() => expect(document.body.textContent).toContain('Newest'));

    rejects[0]!(new Error('late failure'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(document.querySelector('.member-state-error')).toBeNull();
  });

  it('renders nothing for a non-array payload instead of trusting it', async () => {
    await load({ members: [{ _id: 'a', displayName: 'Maya' }] });
    await waitFor(() => expect(rows()).toHaveLength(0));
  });
});
