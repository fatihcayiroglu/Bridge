// Real PrivacyTab + auth owner + HTTP fence; only transport and the device
// erasure backend are replaced. Reproduce server revocation before DELETE ACK.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const erasure = vi.hoisted(() => ({ eraseLocalAccount: vi.fn() }));
vi.mock('../js/core/local-first/account-erasure', () => erasure);
vi.mock('../js/core/globals.ts', () => ({
  getAPI: () => 'https://bridge.test', toServerUrl: (url: string) => new URL(url, 'https://bridge.test').href,
}));
vi.mock('../js/core/refresh-coordinator.ts', () => ({
  storageAvailable: () => false, tryAcquireLease: () => true, releaseLease: vi.fn(),
  publishResult: vi.fn(), waitForOtherTab: vi.fn(),
}));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { createSettingsStore } from '../js/core/settings/stores/settingsStore.ts';
import { t } from '../js/core/i18n/index.ts';

let auth: typeof import('../js/core/auth-compat.ts');
let client: typeof import('../js/core/api-fetch.ts');
let PrivacyTab: typeof import('../js/core/settings/tabs/PrivacyTab.svelte').default;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
let me: Record<string, unknown> | null;
let acknowledged: ReturnType<typeof deferred<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  localStorage.clear();
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
  auth = await import('../js/core/auth-compat.ts');
  client = await import('../js/core/api-fetch.ts');
  PrivacyTab = (await import('../js/core/settings/tabs/PrivacyTab.svelte')).default;
});
beforeEach(async () => {
  document.body.innerHTML = '<div id="auth-msg"></div><div id="auth-screen"><div id="login-form"></div></div><div id="app"></div>';
  localStorage.clear(); me = null;
  acknowledged = deferred<Response>();
  erasure.eraseLocalAccount.mockReset();
  erasure.eraseLocalAccount.mockResolvedValue({ erased: true, markPersisted: true });
  fetchMock = vi.fn(async (raw: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(raw).pathname;
    if (path === '/api/csrf-token') return json({ token: 'csrf' });
    if (path === '/api/account/deletion-preflight') return json({ canDelete: true, blockers: [] });
    if (path === '/api/account' && init?.method === 'DELETE') return acknowledged.promise;
    if (path === '/api/refresh/logout') return json({ ok: true });
    throw new Error('Unexpected transport operation');
  });
  vi.stubGlobal('fetch', fetchMock);
  BridgeRegistry.register('getMe', (() => me) as AnyFn);
  BridgeRegistry.register('setMe', ((value: Record<string, unknown> | null) => { me = value; }) as AnyFn);
  BridgeRegistry.register('apiFetch', client.apiFetch as AnyFn);
  await auth.startApp('old-token', { _id: 'old-user', hasPassword: true });
});
afterEach(async () => {
  cleanup(); auth.logout(); auth.cancelTwoFactorLogin();
  for (const key of ['getMe', 'setMe', 'apiFetch']) BridgeRegistry.unregister(key);
  await Promise.resolve(); vi.unstubAllGlobals();
});
afterAll(() => { Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' }); });

async function beginDeletion() {
  const view = render(PrivacyTab, { props: { store: createSettingsStore('privacy') }, target: document.getElementById('app')! });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await vi.waitFor(() => expect(view.getByTestId('delete-account-password')).toBeDefined());
  await fireEvent.input(view.getByTestId('delete-account-password'), { target: { value: 'old-password' } });
  await fireEvent.click(view.getByTestId('delete-account-ack'));
  await fireEvent.click(view.getByTestId('delete-account-confirm'));
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
    new URL(String(url)).pathname === '/api/account' && init?.method === 'DELETE')).toBe(true));
  return view;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await tick(); await new Promise(resolve => setTimeout(resolve, 0));
}

it('reports confirmed deletion and erases the captured account when live revocation beats the HTTP acknowledgement', async () => {
  await beginDeletion();
  auth.logout(); // Same effect as the authoritative socket account_deleted event.
  acknowledged.resolve(json({ ok: true, deleted: true }));
  await vi.waitFor(() => expect(document.querySelector('#auth-msg.auth-success')?.textContent).toBe(t('privacy_delete_done')));
  expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('old-user');
  expect(auth.readToken()).toBeNull();
});

it('finishes old-account erasure without signing a replacement account out when its acknowledgement is delayed', async () => {
  await beginDeletion();
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  acknowledged.resolve(json({ ok: true, deleted: true, privateOldMetadata: 'must-not-escape' }));
  await vi.waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('old-user'));
  await settle();
  expect(auth.readToken()).toBe('new-token');
  expect(me?._id).toBe('new-user');
  expect(document.getElementById('auth-msg')?.textContent).not.toBe(t('privacy_delete_done'));
});

it('does not sign a new account out when local erasure of the confirmed old deletion completes late', async () => {
  const erased = deferred<{ erased: boolean; markPersisted: boolean }>();
  erasure.eraseLocalAccount.mockReturnValueOnce(erased.promise);
  await beginDeletion(); acknowledged.resolve(json({ ok: true, deleted: true }));
  await vi.waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('old-user'));
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  erased.resolve({ erased: true, markPersisted: true }); await erased.promise; await settle();
  expect(auth.readToken()).toBe('new-token');
  expect(me?._id).toBe('new-user');
  expect(document.getElementById('auth-msg')?.textContent).not.toBe(t('privacy_delete_done'));
});

it.each([400, 403, 409, 503])('does not erase or report successful deletion on HTTP %s', async status => {
  await beginDeletion(); acknowledged.resolve(json({ ok: false, blockers: [] }, status));
  await settle();
  expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
  expect(auth.readToken()).toBe('old-token');
  expect(document.getElementById('auth-msg')?.textContent).not.toBe(t('privacy_delete_done'));
});

it('does not accept a forged deletion acknowledgement in a network conflict', async () => {
  await beginDeletion(); auth.logout();
  acknowledged.resolve(json({ ok: true, deleted: true, error: 'AUTH_SESSION_CHANGED' }, 409));
  await settle();
  expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
  expect(document.getElementById('auth-msg')?.textContent).not.toBe(t('privacy_delete_done'));
});

it('finishes confirmed deletion after live revocation unmounts Settings', async () => {
  await beginDeletion(); auth.logout(); cleanup();
  acknowledged.resolve(json({ ok: true, deleted: true }));
  await vi.waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('old-user'));
  await vi.waitFor(() => expect(document.querySelector('#auth-msg.auth-success')?.textContent).toBe(t('privacy_delete_done')));
});

it('signs the deleted account out after acknowledgement even if Settings closed without a live revocation event', async () => {
  await beginDeletion(); cleanup();
  expect(auth.readToken()).toBe('old-token');
  acknowledged.resolve(json({ ok: true, deleted: true }));
  await vi.waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('old-user'));
  await vi.waitFor(() => expect(auth.readToken()).toBeNull());
  expect(document.querySelector('#auth-msg.auth-success')?.textContent).toBe(t('privacy_delete_done'));
});

it('does not reopen an old deletion form after its preflight finishes in a replacement session', async () => {
  const pending = deferred<Response>();
  fetchMock.mockImplementationOnce(() => pending.promise);
  const view = render(PrivacyTab, { props: { store: createSettingsStore('privacy') }, target: document.getElementById('app')! });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  pending.resolve(json({ canDelete: false, blockers: [{ kind: 'server', name: 'old-private-name', memberCount: 3 }] }));
  await settle();
  expect(view.queryByTestId('delete-account-password')).toBeNull();
  expect(view.queryByText(/old-private-name/)).toBeNull();
  expect(auth.readToken()).toBe('new-token');
});

it('does not clear a replacement account deletion form when the old acknowledgement arrives', async () => {
  const view = await beginDeletion();
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await vi.waitFor(() => expect(view.getByTestId('delete-account-password')).toBeDefined());
  await fireEvent.input(view.getByTestId('delete-account-password'), { target: { value: 'new-password' } });
  acknowledged.resolve(json({ ok: true, deleted: true }));
  await vi.waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('old-user'));
  await settle();
  expect((view.getByTestId('delete-account-password') as HTMLInputElement).value).toBe('new-password');
  expect(auth.readToken()).toBe('new-token');
});

it.each([400, 409, 503])('does not close the replacement deletion form after an old HTTP %s response', async status => {
  const view = await beginDeletion();
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await vi.waitFor(() => expect(view.getByTestId('delete-account-password')).toBeDefined());
  await fireEvent.input(view.getByTestId('delete-account-password'), { target: { value: 'new-password' } });
  acknowledged.resolve(json({ ok: false, blockers: [] }, status)); await settle();
  expect((view.getByTestId('delete-account-password') as HTMLInputElement).value).toBe('new-password');
  expect(auth.readToken()).toBe('new-token');
  expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
});

it('does not close a newer deletion form when an old preflight finishes after account replacement', async () => {
  const pending = deferred<Response>();
  fetchMock.mockImplementationOnce(() => pending.promise);
  const view = render(PrivacyTab, { props: { store: createSettingsStore('privacy') }, target: document.getElementById('app')! });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await vi.waitFor(() => expect(view.getByTestId('delete-account-password')).toBeDefined());
  await fireEvent.input(view.getByTestId('delete-account-password'), { target: { value: 'new-password' } });
  pending.resolve(json({ canDelete: true, blockers: [] })); await settle();
  expect((view.getByTestId('delete-account-password') as HTMLInputElement).value).toBe('new-password');
  expect(auth.readToken()).toBe('new-token');
});

it('does not close the replacement form when the old deletion loses its network acknowledgement', async () => {
  const view = await beginDeletion();
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await vi.waitFor(() => expect(view.getByTestId('delete-account-password')).toBeDefined());
  await fireEvent.input(view.getByTestId('delete-account-password'), { target: { value: 'new-password' } });
  acknowledged.reject(new Error('Connection lost')); await settle();
  expect((view.getByTestId('delete-account-password') as HTMLInputElement).value).toBe('new-password');
  expect(auth.readToken()).toBe('new-token');
  expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
});

it('discards an old ownership-conflict body decoded after the account changes', async () => {
  const view = await beginDeletion();
  const decoded = deferred<{ blockers: { kind: string; name: string; memberCount: number }[] }>();
  const conflict = json({}, 409);
  const read = vi.spyOn(conflict, 'json').mockImplementationOnce(() => decoded.promise);
  acknowledged.resolve(conflict);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await auth.startApp('new-token', { _id: 'new-user', hasPassword: true });
  await fireEvent.click(view.getByTestId('delete-account-start'));
  await vi.waitFor(() => expect(view.getByTestId('delete-account-password')).toBeDefined());
  await fireEvent.input(view.getByTestId('delete-account-password'), { target: { value: 'new-password' } });
  decoded.resolve({ blockers: [{ kind: 'server', name: 'old-private-name', memberCount: 3 }] }); await settle();
  expect(view.queryByText(/old-private-name/)).toBeNull();
  expect((view.getByTestId('delete-account-password') as HTMLInputElement).value).toBe('new-password');
  expect(auth.readToken()).toBe('new-token');
  expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
});
