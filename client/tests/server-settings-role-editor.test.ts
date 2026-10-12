import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import RolesTab from '../js/core/server-settings/tabs/RolesTab.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const { fetchMock, permissionMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  permissionMock: vi.fn(),
}));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));
vi.mock('../js/core/permissions/myPermissions.js', () => ({
  PERM_MANAGE_ROLES: 1 << 2,
  fetchMyPermissions: (...args: unknown[]) => permissionMock(...args),
  hasPerm: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
}));

const SID = 'roles-ui';
const baseRole = {
  _id: 'role/member', name: 'Member', permissions: (1 << 0) | (1 << 8),
  color: '#123abc', position: 5, displayOnProfile: true,
};
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
}) as Response;

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null;
let currentId = SID;
function setServerId(id: string): void {
  currentId = id;
  BridgeRegistry.register('getCurrentServer', () => ({ _id: currentId }));
}
async function render(): Promise<void> {
  instance = mount(RolesTab, { target: host });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(host.textContent).not.toMatch(/Roller yükleniyor/);
  });
}
function click(selector: string): void {
  const button = host.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  flushSync();
}
function setInput(selector: string, value: string): void {
  const el = host.querySelector<HTMLInputElement>(selector);
  expect(el).not.toBeNull();
  el!.value = value;
  el!.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}
function checkedPermission(text: string): HTMLInputElement {
  const labels = [...host.querySelectorAll<HTMLLabelElement>('.role-permission')];
  const found = labels.find(el => el.textContent?.includes(text));
  expect(found).toBeDefined();
  return found!.querySelector<HTMLInputElement>('input')!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = null;
  setServerId(SID);
  fetchMock.mockReset();
  permissionMock.mockReset();
  permissionMock.mockResolvedValue(1 << 2);
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return response({ ...baseRole, _id: 'created' });
    if (init?.method === 'PATCH') return response(baseRole);
    if (init?.method === 'DELETE') return response({ deleted: true });
    return response([baseRole]);
  });
});

afterEach(() => {
  if (instance) unmount(instance);
  BridgeRegistry.unregister('getCurrentServer');
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Server roles editor (client visibility, server authority)', () => {
  it('shows no mutation surfaces without a proven MANAGE_ROLES grant', async () => {
    permissionMock.mockResolvedValue(0);
    await render();
    expect(host.textContent).toContain('Member');
    expect(host.querySelector('.role-create')).toBeNull();
    expect(host.querySelector('.role-edit')).toBeNull();
    expect(host.querySelector('.role-delete')).toBeNull();
    expect(host.querySelector('input[type=checkbox]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates an explicitly no-permission role, without relying on default SEND_MESSAGES', async () => {
    await render();
    click('.role-primary');
    expect(host.querySelector('.role-editor')).not.toBeNull();
    setInput('.role-name-input', 'Helpers');
    click('.role-editor button[type=submit]');
    await vi.waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String((calls[0]![1] as RequestInit).body))).toEqual({
        name: 'Helpers', color: '#99aab5', permissions: 0,
      });
    });
    await vi.waitFor(() => expect(host.querySelector('.role-editor')).toBeNull());
  });

  it('edits role name and exact permission bits without touching hierarchy or profile visibility', async () => {
    await render();
    click('.role-edit');
    expect(checkedPermission('Kanalları görüntüle').checked).toBe(true);
    expect(checkedPermission('Mesaj gönder').checked).toBe(true);
    checkedPermission('Üyeleri yasakla').click();
    flushSync();
    setInput('.role-name-input', 'Trusted Member');
    click('.role-editor button[type=submit]');
    await vi.waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(calls).toHaveLength(1);
      const [url, init] = calls[0]!;
      expect(url).toBe('http://test/api/servers/roles-ui/roles/role%2Fmember');
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        name: 'Trusted Member', color: '#123abc', permissions: (1 << 0) | (1 << 8) | (1 << 5),
      });
    });
  });

  it('does not open editor for missing, negative or unknown-bit role permissions', async () => {
    fetchMock.mockResolvedValue(response([{ ...baseRole, permissions: undefined }]));
    await render();
    click('.role-edit');
    expect(host.querySelector('.role-editor')).toBeNull();
    expect(host.querySelector('[role=alert]')?.textContent).toMatch(/güvenli biçimde okunamadı/);
  });

  it('requires a second explicit confirmation before DELETE', async () => {
    await render();
    click('.role-delete');
    expect(fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
    click('.role-confirm .role-danger');
    await vi.waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'DELETE');
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe('http://test/api/servers/roles-ui/roles/role%2Fmember');
    });
  });

  it('lets users cancel a pending deletion without writing', async () => {
    await render();
    click('.role-delete');
    click('.role-confirm button:last-child');
    expect(host.querySelector('.role-confirm')).toBeNull();
    expect(fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
  });

  it('never submits a stale-server edit or deletion', async () => {
    await render();
    click('.role-edit');
    setInput('.role-name-input', 'Nope');
    setServerId('new-server');
    click('.role-editor button[type=submit]');
    expect(fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(0);
    expect(host.querySelector('.role-editor [role=alert]')?.textContent).toMatch(/Sunucu değişti/);
  });

  it('displays backend 403 without claiming success or hiding editor', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? response({ error: 'Forbidden' }, 403) : response([baseRole]));
    await render();
    click('.role-edit');
    click('.role-editor button[type=submit]');
    await vi.waitFor(() => expect(host.querySelector('.role-editor [role=alert]')).not.toBeNull());
    expect(host.querySelector('.role-editor')).not.toBeNull();
    expect(host.textContent).not.toContain('Rol güncellendi.');
  });

  it('prevents a duplicate write while a save is still pending', async () => {
    let finish: (result: Response) => void = () => {};
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
      return response([baseRole]);
    });
    await render();
    click('.role-primary');
    setInput('.role-name-input', 'Pending');
    click('.role-editor button[type=submit]');
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.role-editor button[type=submit]')?.disabled).toBe(true));
    host.querySelector<HTMLFormElement>('.role-editor')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
    finish(response({ ...baseRole, _id: 'new' }));
  });
});
