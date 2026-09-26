import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import MemberProfilePopover from '../js/core/MemberProfilePopover.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const SID = 'srv-profile';
const UID = 'user-profile';
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null;
let roleResponse: Response;

async function openProfile(): Promise<void> {
  await vi.waitFor(() => expect(BridgeRegistry.has('openMemberProfile')).toBe(true));
  BridgeRegistry.call('openMemberProfile', UID);
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('.mp-name')?.textContent).toBe('Ada');
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = null;
  roleResponse = response([
    { _id: 'r1', name: 'Admin',     color: '#e05260', position: 40 },
    { _id: 'r2', name: 'Developer', color: '#2d9cdb', position: 30 },
    { _id: 'r3', name: 'Backend',   color: '#888888', position: 20 },
    { _id: 'r4', name: '<script>not markup</script>', color: '#ffffff', position: 10 },
  ]);

  BridgeRegistry.register('currentServer', () => ({ _id: SID }));
  BridgeRegistry.register('me', () => ({ _id: 'viewer' }));
  BridgeRegistry.register('apiFetch', async (url: string) => {
    if (url.includes(`/api/users/${UID}`)) return response({ _id: UID, username: 'ada', displayName: 'Ada', status: 'online' });
    if (url.endsWith('/api/friends')) return response([]);
    if (url.endsWith(`/members/${UID}/roles`)) return roleResponse;
    return response({}, 404);
  });
  instance = mount(MemberProfilePopover, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  for (const key of ['currentServer', 'me', 'apiFetch', 'openMemberProfile', 'closeMemberProfile']) {
    BridgeRegistry.unregister(key);
  }
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Uye profilinde gercek sunucu rolleri', () => {
  it('ilk uc rolu gosterir, tasani +N ile erisilebilir bicimde acar', async () => {
    await openProfile();
    await vi.waitFor(() => expect(host.querySelectorAll('.mp-role-name')).toHaveLength(3));

    expect([...host.querySelectorAll('.mp-role-name')].map(el => el.textContent))
      .toEqual(['Admin', 'Developer', 'Backend']);
    const more = host.querySelector<HTMLButtonElement>('.mp-role-more')!;
    expect(more.textContent).toBe('+1');
    expect(more.getAttribute('aria-label')).toMatch(/1 rol daha/);

    more.click();
    flushSync();
    expect(host.querySelectorAll('.mp-role-name')).toHaveLength(4);
    expect(host.textContent).toContain('<script>not markup</script>');
    expect(host.querySelector('script')).toBeNull();
  });

  it('rol ucu basarisizsa profil calisir ve rol metadatasi sizdirmaz', async () => {
    roleResponse = response({ error: 'Forbidden' }, 403);
    await openProfile();

    await vi.waitFor(() => expect(host.querySelector('.mp-roles')).toBeNull());
    expect(host.querySelector('.mp-name')?.textContent).toBe('Ada');
  });
});
