import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MemberProfilePopover from '../js/core/MemberProfilePopover.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const USER_ID = 'user/a';
const SERVER_ID = 'server/a';
const PROFILE = {
  _id: USER_ID,
  username: 'ada',
  displayName: 'Ada Lovelace',
  avatarColor: '#123abc',
  avatarUrl: '/avatars/ada.png',
  status: 'idle',
  statusEmoji: '☕',
  statusText: 'Mola veriyor',
  pronouns: 'she/her',
  bio: 'Analytical engine programmer',
};

type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null;
let apiFetch: ReturnType<typeof vi.fn<ApiFetch>>;

function installApi(handler?: ApiFetch): void {
  apiFetch = vi.fn<ApiFetch>(handler ?? (async (url) => {
    if (url.includes('/api/users/')) return response(PROFILE);
    if (url.endsWith('/api/friends')) return response([]);
    if (url.includes('/roles')) return response([]);
    return response({}, 404);
  }));
  BridgeRegistry.register('apiFetch', apiFetch);
}

function open(id = USER_ID): void {
  BridgeRegistry.call('openMemberProfile', id);
  flushSync();
}

async function waitForProfile(name = 'Ada Lovelace'): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('.mp-name')?.textContent).toBe(name);
  });
}

function friendButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('.mp-friend');
}

beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
  delete (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
  BridgeRegistry.register('currentServer', () => ({ _id: SERVER_ID }));
  BridgeRegistry.register('me', () => ({ id: 'viewer' }));
  installApi();
  component = mount(MemberProfilePopover, { target: host });
  flushSync();
  await vi.waitFor(() => expect(BridgeRegistry.has('openMemberProfile')).toBe(true));
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  for (const key of [
    'apiFetch', 'currentServer', 'me', 'openDm',
    'openMemberProfile', 'closeMemberProfile',
  ]) {
    BridgeRegistry.unregister(key);
  }
  delete (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('MemberProfilePopover deep behavior', () => {
  it('renders canonical optional fields, a safe relative avatar, presence, and encoded endpoint ids', async () => {
    open();
    await waitForProfile();

    expect(host.querySelector<HTMLImageElement>('.mp-avatar img')?.src)
      .toBe(`${location.origin}/avatars/ada.png`);
    expect(host.querySelector('.mp-avatar')?.getAttribute('style')).toContain('rgb(18, 58, 188)');
    expect(host.querySelector('.mp-presence')?.textContent).toContain('Boşta');
    expect(host.querySelector('.mp-status')?.textContent).toBe('☕ Mola veriyor');
    expect(host.querySelector('.mp-meta')?.textContent).toBe('she/her');
    expect(host.querySelector('.mp-bio')?.textContent).toBe('Analytical engine programmer');

    const urls = apiFetch.mock.calls.map(([url]) => url);
    expect(urls).toContain(`${location.origin}/api/users/user%2Fa`);
    expect(urls).toContain(`${location.origin}/api/servers/server%2Fa/members/user%2Fa/roles`);
  });

  it('uses the configured API base and username/default identity fallbacks without inventing presence', async () => {
    (globalThis as { BRIDGE_API?: string }).BRIDGE_API = 'https://bridge-api.example';
    installApi(async (url) => {
      if (url.includes('/api/users/')) return response({ username: 'grace', status: 'mystery' });
      return response([]);
    });

    open('grace');
    await waitForProfile('grace');
    expect(host.querySelector('.mp-handle')?.textContent).toBe('@grace');
    expect(host.querySelector('.mp-presence')).toBeNull();
    expect(apiFetch.mock.calls.every(([url]) => url.startsWith('https://bridge-api.example/'))).toBe(true);

    BridgeRegistry.call('closeMemberProfile');
    installApi(async (url) => url.includes('/api/users/') ? response({}) : response([]));
    open('anonymous');
    await waitForProfile('Bridge kullanıcısı');
    expect(host.querySelector('.mp-handle')).toBeNull();
    expect(host.querySelector('.mp-status')).toBeNull();
  });

  it('rejects malformed avatar URLs and falls back for unsafe role colors and non-array role payloads', async () => {
    installApi(async (url) => {
      if (url.includes('/api/users/')) return response({ ...PROFILE, avatarUrl: 'http://[' });
      if (url.endsWith('/api/friends')) return response([]);
      return response([{ _id: 'r1', name: 'Untrusted color', color: 'red;display:none', position: 1 }]);
    });
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(host.querySelector('.mp-role-dot')).not.toBeNull());
    expect(host.querySelector('.mp-avatar img')).toBeNull();
    expect(host.querySelector('.mp-role-dot')?.getAttribute('style')).toContain('var(--text-muted)');

    BridgeRegistry.call('closeMemberProfile');
    installApi(async (url) => url.includes('/api/users/') ? response(PROFILE) : response({ nope: true }));
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(host.querySelector('.mp-roles')).toBeNull());
  });

  it('fails closed when role ownership is absent, role fetch throws, or the role response is not ok', async () => {
    BridgeRegistry.unregister('currentServer');
    open();
    await waitForProfile();
    expect(apiFetch.mock.calls.some(([url]) => url.includes('/roles'))).toBe(false);

    BridgeRegistry.call('closeMemberProfile');
    BridgeRegistry.register('currentServer', () => { throw new Error('server owner failed'); });
    open();
    await waitForProfile();
    expect(host.querySelector('.mp-roles')).toBeNull();

    BridgeRegistry.call('closeMemberProfile');
    BridgeRegistry.register('currentServer', () => ({ _id: SERVER_ID }));
    installApi(async (url) => {
      if (url.includes('/roles')) throw new Error('roles offline');
      return url.includes('/api/users/') ? response(PROFILE) : response([]);
    });
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.includes('/roles'))).toBe(true));
    expect(host.querySelector('.mp-roles')).toBeNull();

    BridgeRegistry.call('closeMemberProfile');
    installApi(async (url) => url.includes('/roles') ? response({}, 403)
      : url.includes('/api/users/') ? response(PROFILE) : response([]));
    open();
    await waitForProfile();
    expect(host.querySelector('.mp-roles')).toBeNull();
  });

  it('supports both canonical friend id shapes, non-array lists, missing ownership, and thrown identity lookup', async () => {
    BridgeRegistry.register('me', () => ({ _id: 'viewer' }));
    installApi(async (url) => url.includes('/api/users/') ? response(PROFILE)
      : url.endsWith('/api/friends') ? response([{ id: USER_ID }]) : response([]));
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar'));

    BridgeRegistry.call('closeMemberProfile');
    BridgeRegistry.register('me', () => null);
    installApi(async (url) => url.includes('/api/users/') ? response(PROFILE)
      : url.endsWith('/api/friends') ? response({ malformed: true }) : response([]));
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaş ekle'));

    BridgeRegistry.call('closeMemberProfile');
    BridgeRegistry.register('me', () => { throw new Error('identity unavailable'); });
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaş ekle'));
  });

  it('ignores friend-list entries that have neither canonical id shape', async () => {
    installApi(async (url) => url.includes('/api/users/') ? response(PROFILE)
      : url.endsWith('/api/friends') ? response([{}]) : response([]));
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaş ekle'));
  });

  it('fails closed when friend state fetch throws or apiFetch disappears', async () => {
    installApi(async (url) => {
      if (url.endsWith('/api/friends')) throw new Error('friends offline');
      return url.includes('/api/users/') ? response(PROFILE) : response([]);
    });
    open();
    await waitForProfile();
    expect(friendButton()).toBeNull();

    BridgeRegistry.call('closeMemberProfile');
    BridgeRegistry.unregister('apiFetch');
    open();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.mp-error')?.textContent).toContain('Profil yüklenemedi');
    });
    expect(friendButton()).toBeNull();
  });

  it('shows loading and recovers through the visible retry action after a failed JSON body', async () => {
    const pending = deferred<Response>();
    installApi(async (url) => {
      if (url.includes('/api/users/')) return pending.promise;
      return response([]);
    });
    open();
    expect(host.querySelector('.mp-state')?.textContent).toContain('Yükleniyor');

    pending.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } } as Response);
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.mp-error')).not.toBeNull();
    });

    installApi(async (url) => url.includes('/api/users/') ? response(PROFILE) : response([]));
    host.querySelector<HTMLButtonElement>('.mp-ghost')!.click();
    await waitForProfile();
  });

  it('reports non-conflict friend request failures and network errors, then permits retry', async () => {
    installApi(async (url) => {
      if (url.includes('/api/friends/request')) return response({}, 422);
      return url.includes('/api/users/') ? response(PROFILE) : response([]);
    });
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()).not.toBeNull());
    friendButton()!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.mp-note')?.textContent).toContain('İstek gönderilemedi');
    });

    installApi(async (url) => {
      if (url.includes('/api/friends/request')) throw new Error('network down');
      return url.includes('/api/users/') ? response(PROFILE) : response([]);
    });
    friendButton()!.click();
    await vi.waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.includes('/api/friends/request'))).toBe(true));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.mp-note')?.textContent).toContain('İstek gönderilemedi');
    });
  });

  it('shows request progress and suppresses a duplicate friend request while one is pending', async () => {
    const pending = deferred<Response>();
    installApi(async (url) => {
      if (url.includes('/api/friends/request')) return pending.promise;
      return url.includes('/api/users/') ? response(PROFILE) : response([]);
    });
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()).not.toBeNull());

    const button = friendButton()!;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(friendButton()?.textContent).toContain('Gönderiliyor');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/api/friends/request'))).toHaveLength(1);

    pending.resolve(response({ ok: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(friendButton()?.textContent).toContain('İstek bekliyor');
    });
  });

  it('removes a canonical friend, reports HTTP/network failures, and remains retryable', async () => {
    let removeMode: 'ok' | 'http' | 'throw' = 'ok';
    installApi(async (url, init) => {
      if (url.includes('/api/users/')) return response(PROFILE);
      if (url.endsWith('/api/friends')) return response([{ _id: USER_ID }]);
      if (init?.method === 'DELETE') {
        if (removeMode === 'throw') throw new Error('delete offline');
        return response({}, removeMode === 'http' ? 500 : 200);
      }
      return response([]);
    });
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar'));

    removeMode = 'http';
    friendButton()!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.mp-note')?.textContent).toContain('Arkadaşlıktan çıkarılamadı');
    });

    removeMode = 'throw';
    friendButton()!.click();
    await vi.waitFor(() => expect(apiFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2));
    await vi.waitFor(() => {
      flushSync();
      expect(friendButton()?.disabled).toBe(false);
      expect(host.querySelector('.mp-note')?.textContent).toContain('Arkadaşlıktan çıkarılamadı');
    });

    removeMode = 'ok';
    friendButton()!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(friendButton()?.textContent).toContain('Arkadaş ekle');
    });
    expect(apiFetch.mock.calls.some(([url, init]) => url.endsWith('/friends/user%2Fa') && init?.method === 'DELETE')).toBe(true);
  });

  it('handles a missing action owner for add and remove without leaving the UI busy', async () => {
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaş ekle'));
    BridgeRegistry.unregister('apiFetch');
    friendButton()!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(friendButton()?.disabled).toBe(false);
      expect(host.querySelector('.mp-note')?.textContent).toContain('İstek gönderilemedi');
    });

    BridgeRegistry.call('closeMemberProfile');
    installApi(async (url) => url.includes('/api/users/') ? response(PROFILE)
      : url.endsWith('/api/friends') ? response([{ _id: USER_ID }]) : response([]));
    open();
    await waitForProfile();
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar'));
    BridgeRegistry.unregister('apiFetch');
    friendButton()!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(friendButton()?.disabled).toBe(false);
      expect(host.querySelector('.mp-note')?.textContent).toContain('Arkadaşlıktan çıkarılamadı');
    });
  });

  it('guards empty opens and missing DM ownership, and closes through every visible dismissal path', async () => {
    open('');
    expect(host.querySelector('.mp-card')).toBeNull();

    open();
    await waitForProfile();
    host.querySelector<HTMLButtonElement>('.mp-msg')!.click();
    flushSync();
    expect(host.querySelector('.mp-card')).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(host.querySelector('.mp-card')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('.mp-x')!.click();
    flushSync();
    expect(host.querySelector('.mp-card')).toBeNull();

    open();
    await waitForProfile();
    const card = host.querySelector<HTMLElement>('.mp-card')!;
    card.click();
    flushSync();
    expect(host.querySelector('.mp-card')).not.toBeNull();
    host.querySelector<HTMLElement>('.mp-overlay')!.click();
    flushSync();
    expect(host.querySelector('.mp-card')).toBeNull();
  });

  it('does not let a slower prior profile request overwrite the latest opened member', async () => {
    const first = deferred<Response>();
    installApi(async (url) => {
      if (url.includes('/api/users/first')) return first.promise;
      if (url.includes('/api/users/second')) return response({ username: 'second', displayName: 'Second User' });
      return response([]);
    });

    open('first');
    open('second');
    await waitForProfile('Second User');
    first.resolve(response({ username: 'first', displayName: 'First User' }));
    await first.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(host.querySelector('.mp-name')?.textContent).toBe('Second User');
  });

  it('ignores stale profile, friend, and role JSON bodies that finish after a newer member', async () => {
    const staleProfileJson = deferred<unknown>();
    const staleFriendsJson = deferred<unknown>();
    const staleRolesJson = deferred<unknown>();
    let friendCalls = 0;
    let profileJsonStarted = false;
    let friendJsonStarted = false;
    let roleJsonStarted = false;
    installApi(async (url) => {
      if (url.includes('/api/users/first')) {
        return {
          ok: true, status: 200,
          json: () => { profileJsonStarted = true; return staleProfileJson.promise; },
        } as Response;
      }
      if (url.includes('/api/users/second')) return response({ username: 'second', displayName: 'Second User' });
      if (url.endsWith('/api/friends')) {
        friendCalls += 1;
        return friendCalls === 1
          ? ({
              ok: true, status: 200,
              json: () => { friendJsonStarted = true; return staleFriendsJson.promise; },
            } as Response)
          : response([]);
      }
      if (url.includes('/members/first/roles')) {
        return {
          ok: true, status: 200,
          json: () => { roleJsonStarted = true; return staleRolesJson.promise; },
        } as Response;
      }
      return response([]);
    });

    open('first');
    await vi.waitFor(() => {
      expect(profileJsonStarted).toBe(true);
      expect(friendJsonStarted).toBe(true);
      expect(roleJsonStarted).toBe(true);
    });
    open('second');
    await waitForProfile('Second User');
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaş ekle'));

    staleProfileJson.resolve({ username: 'first', displayName: 'First User' });
    staleFriendsJson.resolve([{ id: 'second' }]);
    staleRolesJson.resolve([{ _id: 'old-role', name: 'Old role', color: '#fff', position: 1 }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();

    expect(host.querySelector('.mp-name')?.textContent).toBe('Second User');
    expect(friendButton()?.textContent).toContain('Arkadaş ekle');
    expect(host.textContent).not.toContain('Old role');
  });

  it('silently absorbs stale rejected profile, friend, and role requests', async () => {
    const staleProfile = deferred<Response>();
    const staleFriends = deferred<Response>();
    const staleRoles = deferred<Response>();
    let friendCalls = 0;
    installApi(async (url) => {
      if (url.includes('/api/users/first')) return staleProfile.promise;
      if (url.includes('/api/users/second')) return response({ username: 'second', displayName: 'Second User' });
      if (url.endsWith('/api/friends')) {
        friendCalls += 1;
        return friendCalls === 1 ? staleFriends.promise : response([]);
      }
      if (url.includes('/members/first/roles')) return staleRoles.promise;
      return response([]);
    });

    open('first');
    await vi.waitFor(() => expect(friendCalls).toBe(1));
    open('second');
    await waitForProfile('Second User');
    staleProfile.reject(new Error('old profile failed'));
    staleFriends.reject(new Error('old friends failed'));
    staleRoles.reject(new Error('old roles failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();

    expect(host.querySelector('.mp-name')?.textContent).toBe('Second User');
    expect(host.querySelector('.mp-error')).toBeNull();
    expect(friendButton()?.textContent).toContain('Arkadaş ekle');
    expect(host.querySelector('.mp-roles')).toBeNull();
  });

  it('does not let a stale friend-list HTTP response clear the newer friend state', async () => {
    const staleFriends = deferred<Response>();
    let friendCalls = 0;
    installApi(async (url) => {
      if (url.includes('/api/users/')) {
        const id = decodeURIComponent(url.split('/').pop()!);
        return response({ username: id, displayName: `${id} User` });
      }
      if (url.endsWith('/api/friends')) {
        friendCalls += 1;
        return friendCalls === 1 ? staleFriends.promise : response([{ id: 'second' }]);
      }
      return response([]);
    });

    open('first');
    await vi.waitFor(() => expect(friendCalls).toBe(1));
    open('second');
    await waitForProfile('second User');
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar'));

    staleFriends.resolve(response([]));
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar');
  });

  it('does not apply a stale friend-request completion or rejection to a newly opened member', async () => {
    let pendingRequest = deferred<Response>();
    installApi(async (url) => {
      if (url.includes('/api/friends/request')) return pendingRequest.promise;
      if (url.includes('/api/users/')) {
        const id = decodeURIComponent(url.split('/').pop()!);
        return response({ username: id, displayName: `${id} User` });
      }
      return response([]);
    });

    open('first');
    await waitForProfile('first User');
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaş ekle'));
    friendButton()!.click();
    open('second');
    await waitForProfile('second User');
    pendingRequest.resolve(response({}, 409));
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(friendButton()?.textContent).toContain('Arkadaş ekle');
    expect(host.querySelector('.mp-note')).toBeNull();

    pendingRequest = deferred<Response>();
    friendButton()!.click();
    open('third');
    await waitForProfile('third User');
    pendingRequest.reject(new Error('old request failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(friendButton()?.textContent).toContain('Arkadaş ekle');
    expect(host.querySelector('.mp-note')).toBeNull();
  });

  it('does not apply a stale friend-removal completion or rejection to a newly opened member', async () => {
    let pendingRemoval = deferred<Response>();
    let listedFriend = 'first';
    installApi(async (url, init) => {
      if (init?.method === 'DELETE') return pendingRemoval.promise;
      if (url.includes('/api/users/')) {
        const id = decodeURIComponent(url.split('/').pop()!);
        return response({ username: id, displayName: `${id} User` });
      }
      if (url.endsWith('/api/friends')) return response([{ id: listedFriend }]);
      return response([]);
    });

    open('first');
    await waitForProfile('first User');
    await vi.waitFor(() => expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar'));
    friendButton()!.click();
    listedFriend = 'second';
    open('second');
    await waitForProfile('second User');
    pendingRemoval.resolve(response({ ok: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar');

    pendingRemoval = deferred<Response>();
    friendButton()!.click();
    listedFriend = 'third';
    open('third');
    await waitForProfile('third User');
    pendingRemoval.reject(new Error('old removal failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync();
    expect(friendButton()?.textContent).toContain('Arkadaşlıktan çıkar');
    expect(host.querySelector('.mp-note')).toBeNull();
  });
});

// Final21 UX: kendi profilinde "Mesaj gönder" kendine DM açmaktı; ilk kullanım görevlerinden
// biri olan "profilini düzenle" beklenen eylemdir. Baş harfler de mesajlarla aynı kurala uyar
// ("Deniz Test" → DT; önceden ilk iki HARF: DE — aynı kişi iki farklı avatarla görünüyordu).
describe('MemberProfilePopover — own profile and initials', () => {
  it('own profile offers "Profili düzenle" which opens Settings › Profile', async () => {
    BridgeRegistry.register('me', () => ({ id: USER_ID }));
    const openSettings = vi.fn();
    BridgeRegistry.register('openSettingsModal', openSettings);
    open(USER_ID);
    await waitForProfile();
    const action = host.querySelector<HTMLButtonElement>('.mp-msg')!;
    expect(action.textContent).toBe('Profili düzenle');
    action.click();
    flushSync();
    expect(openSettings).toHaveBeenCalledWith('profile');
    expect(host.querySelector('.mp-name')).toBeNull();
    BridgeRegistry.unregister('openSettingsModal');
  });

  it('someone else\'s profile still offers "Mesaj gönder"', async () => {
    open(USER_ID);
    await waitForProfile();
    expect(host.querySelector('.mp-msg')!.textContent).toBe('Mesaj gönder');
  });

  it('initials come from words, like the message list and the user panel', async () => {
    installApi(async (url) => {
      if (url.includes('/api/users/')) return response({ ...PROFILE, avatarUrl: undefined });
      if (url.endsWith('/api/friends')) return response([]);
      return response([]);
    });
    open(USER_ID);
    await waitForProfile();
    expect(host.querySelector('.mp-avatar')!.textContent!.trim()).toBe('AL');
  });
});
