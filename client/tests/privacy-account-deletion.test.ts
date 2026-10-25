// client/tests/privacy-account-deletion.test.ts
//
// Final21 Faz 19 — hesabı üründen silme.
//
// Sunucuda `DELETE /api/account` ve `GET /api/account/deletion-preflight` vardı ama istemcide
// hiçbir giriş noktası yoktu. Bu süit Gizlilik sekmesindeki akışı gerçek bileşenle sürer:
// sahiplik engeli listelenir ve silme sunulmaz; onay + parola olmadan düğme kapalıdır; yanlış
// parola oturumu KAPATMAZ; başarıda oturum kapanır ve kişiye bilgi verilir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

const order = vi.hoisted(() => [] as string[]);
const authCompat = vi.hoisted(() => ({
  logout: vi.fn(() => { order.push('logout'); }), showAuthMsg: vi.fn(),
  readToken: vi.fn(() => 'account-access-token'), saveToken: vi.fn(),
}));
vi.mock('../js/core/auth-compat.js', () => authCompat);
// P7: local-first erasure of the deleted account (its own suite covers what it wipes).
const erasure = vi.hoisted(() => ({
  eraseLocalAccount: vi.fn(async (userId: string) => { order.push(`erase:${userId}`); return { erased: true, markPersisted: true }; }),
}));
vi.mock('../js/core/local-first/account-erasure', () => erasure);

import { t } from '../js/core/i18n/index.ts';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { createSettingsStore } from '../js/core/settings/stores/settingsStore.ts';
import { apiFetch as realApiFetch, resetCsrfState, resetRefreshState } from '../js/core/api-fetch.ts';
import PrivacyTab from '../js/core/settings/tabs/PrivacyTab.svelte';

type Reply = { status: number; body?: unknown };
let replies: Record<string, Reply[]>;
let apiFetch: ReturnType<typeof vi.fn>;

const json = (r: Reply) => new Response(r.body === undefined ? null : JSON.stringify(r.body), {
  status: r.status, headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  replies = {};
  apiFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const next = replies[key]?.shift();
    if (!next) throw new Error(`unexpected request ${key}`);
    return json(next);
  });
  BridgeRegistry.register('getMe', (() => ({ _id: 'u1' })) as unknown as AnyFn);
  BridgeRegistry.register('apiFetch', apiFetch as unknown as AnyFn);
  authCompat.logout.mockClear();
  authCompat.showAuthMsg.mockClear();
  authCompat.readToken.mockReset().mockReturnValue('account-access-token');
  erasure.eraseLocalAccount.mockClear();
  order.length = 0;
});

afterEach(() => {
  cleanup();
  resetRefreshState(); resetCsrfState(); vi.unstubAllGlobals();
  for (const key of ['getMe', 'apiFetch']) BridgeRegistry.unregister(key);
});

const view = () => render(PrivacyTab, { props: { store: createSettingsStore('privacy') } });
const open = async (v: ReturnType<typeof view>) => fireEvent.click(v.getByRole('button', { name: t('privacy_delete_start') }));

describe('Gizlilik — hesabı sil', () => {
  it('sahiplik engeli varsa listelenir, parola formu SUNULMAZ ve hiçbir silme isteği gitmez', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 200, body: {
      canDelete: false,
      blockers: [{ kind: 'server', id: 's1', name: 'Kulüp', memberCount: 4 }, { kind: 'group_dm', id: 'g1', memberCount: 3 }],
    } }];
    const v = view();
    await open(v);

    await waitFor(() => expect(v.getByText(t('privacy_delete_blocker_server', undefined, { name: 'Kulüp', count: 4 }))).toBeTruthy());
    expect(v.getByText(t('privacy_delete_blocker_group', undefined, { count: 3 }))).toBeTruthy();
    expect(v.queryByLabelText(t('privacy_delete_password'))).toBeNull();
    await fireEvent.click(v.getByRole('button', { name: t('cancel') }));
    expect(v.getByRole('button', { name: t('privacy_delete_start') })).toBeTruthy();
    expect(apiFetch.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${c[0]}`)).toEqual(['GET /api/account/deletion-preflight']);
  });

  it('onay ve parola olmadan silme düğmesi KAPALI; ikisiyle birlikte tek DELETE gider, oturum kapanır', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 200, body: { canDelete: true, blockers: [] } }];
    replies['DELETE /api/account'] = [{ status: 200, body: { ok: true, deleted: true } }];
    const v = view();
    await open(v);

    const confirm = await waitFor(() => v.getByRole('button', { name: t('privacy_delete_confirm') }));
    expect(confirm).toBeDisabled();
    await fireEvent.input(v.getByLabelText(t('privacy_delete_password')), { target: { value: 'dogru-parola' } });
    expect(confirm).toBeDisabled();
    await fireEvent.click(v.getByLabelText(t('privacy_delete_ack')));
    expect(confirm).not.toBeDisabled();
    await fireEvent.click(confirm);

    await waitFor(() => expect(authCompat.logout).toHaveBeenCalledOnce());
    const [, init] = apiFetch.mock.calls.find((c) => c[0] === '/api/account')!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ confirm: 'DELETE', password: 'dogru-parola' });
    expect(authCompat.showAuthMsg).toHaveBeenCalledWith(t('privacy_delete_done'), 'success');
    // P7: this device's local data of the deleted account is erased, before logout.
    expect(order).toEqual(['erase:u1', 'logout']);
  });

  it('yanlış parola (400) hata gösterir ve oturumu KAPATMAZ', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 200, body: { canDelete: true, blockers: [] } }];
    replies['DELETE /api/account'] = [{ status: 400, body: { error: 'Password incorrect' } }];
    const v = view();
    await open(v);
    await waitFor(() => v.getByLabelText(t('privacy_delete_password')));
    await fireEvent.input(v.getByLabelText(t('privacy_delete_password')), { target: { value: 'yanlis' } });
    await fireEvent.click(v.getByLabelText(t('privacy_delete_ack')));
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));

    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_wrong_password')));
    expect(authCompat.logout).not.toHaveBeenCalled();
    expect(v.getByRole('button', { name: t('privacy_delete_confirm') })).toBeTruthy();
    expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
  });

  it('ön denetimden SONRA oluşan sahiplik (409) engel listesine döner, silme olmaz', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 200, body: { canDelete: true, blockers: [] } }];
    replies['DELETE /api/account'] = [{ status: 409, body: { error: 'Ownership transfer required before deletion', blockers: [{ kind: 'server', id: 's9', name: 'Yeni', memberCount: 2 }] } }];
    const v = view();
    await open(v);
    await waitFor(() => v.getByLabelText(t('privacy_delete_password')));
    await fireEvent.input(v.getByLabelText(t('privacy_delete_password')), { target: { value: 'dogru' } });
    await fireEvent.click(v.getByLabelText(t('privacy_delete_ack')));
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));

    await waitFor(() => expect(v.getByText(t('privacy_delete_blocker_server', undefined, { name: 'Yeni', count: 2 }))).toBeTruthy());
    expect(v.queryByLabelText(t('privacy_delete_password'))).toBeNull();
    expect(authCompat.logout).not.toHaveBeenCalled();
    expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
  });

  it('PostgreSQL olmayan kurulumda (503) dürüstçe kullanılamaz der', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 503, body: { error: 'Requires PostgreSQL' } }];
    const v = view();
    await open(v);
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_unavailable')));
    expect(v.getByRole('button', { name: t('privacy_delete_start') })).not.toBeDisabled();
  });
});

describe('P7 B2 — SSO-only account (no password)', () => {
  beforeEach(() => {
    BridgeRegistry.register('getMe', (() => ({ _id: 'u1', hasPassword: false })) as unknown as AnyFn);
  });

  it('offers deletion without a password field; the request carries no password (the sign-in grant proves it)', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 200, body: { canDelete: true, blockers: [] } }];
    replies['DELETE /api/account'] = [{ status: 200, body: { ok: true, deleted: true } }];
    const v = view();
    await open(v);

    const confirm = await waitFor(() => v.getByRole('button', { name: t('privacy_delete_confirm') }));
    expect(v.queryByLabelText(t('privacy_delete_password'))).toBeNull();
    expect(v.getByTestId('delete-account-sso-note').textContent).toBe(t('privacy_delete_sso_note'));
    expect(confirm).toBeDisabled();
    await fireEvent.click(v.getByLabelText(t('privacy_delete_ack')));
    expect(confirm).not.toBeDisabled();
    await fireEvent.click(confirm);

    await waitFor(() => expect(authCompat.logout).toHaveBeenCalledOnce());
    const [, init] = apiFetch.mock.calls.find((c) => c[0] === '/api/account')!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ confirm: 'DELETE' });
    expect(order).toEqual(['erase:u1', 'logout']);
  });

  it('a refused proof (403, e.g. the person declined to sign in again) keeps the session and explains', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 200, body: { canDelete: true, blockers: [] } }];
    replies['DELETE /api/account'] = [{ status: 403, body: { error: 'STEP_UP_REQUIRED', scope: 'destructive-admin', methods: ['sign_in'] } }];
    const v = view();
    await open(v);
    await fireEvent.click(await waitFor(() => v.getByLabelText(t('privacy_delete_ack'))));
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_needs_proof')));
    expect(authCompat.logout).not.toHaveBeenCalled();
    expect(erasure.eraseLocalAccount).not.toHaveBeenCalled();
  });
});

describe('P7 account deletion acknowledgement across session races', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }

  async function beginRealDeletion(pending: ReturnType<typeof deferred<Response>>, current: () => string | null) {
    BridgeRegistry.register('getMe', (() => {
      const id = current();
      return id ? { _id: id } : null;
    }) as unknown as AnyFn);
    BridgeRegistry.register('apiFetch', realApiFetch as unknown as AnyFn);
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/csrf-token')) return Promise.resolve(json({ status: 200, body: { token: 'csrf' } }));
      if (url.endsWith('/api/account/deletion-preflight')) return Promise.resolve(json({ status: 200, body: { blockers: [] } }));
      if (url.endsWith('/api/account') && init?.method === 'DELETE') return pending.promise;
      throw new Error(`Unexpected ${String(init?.method)} ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const v = view();
    await open(v);
    await waitFor(() => v.getByLabelText(t('privacy_delete_password')));
    await fireEvent.input(v.getByLabelText(t('privacy_delete_password')), { target: { value: 'correct' } });
    await fireEvent.click(v.getByLabelText(t('privacy_delete_ack')));
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) =>
      String(url).endsWith('/api/account') && (init as RequestInit | undefined)?.method === 'DELETE')).toBe(true));
    return v;
  }

  it('erases the captured account and shows confirmation when live revocation beats HTTP 200', async () => {
    const pending = deferred<Response>();
    let account: string | null = 'u1';
    await beginRealDeletion(pending, () => account);
    account = null;
    authCompat.readToken.mockReturnValue(null);
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    pending.resolve(json({ status: 200, body: { deleted: true } }));
    await waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('u1'));
    await waitFor(() => expect(authCompat.showAuthMsg).toHaveBeenCalledWith(t('privacy_delete_done'), 'success'));
    expect(authCompat.logout).not.toHaveBeenCalled();
  });

  it('a delayed HTTP deletion success erases only the old account without logging out its replacement', async () => {
    const pending = deferred<Response>();
    let account: string | null = 'u1';
    await beginRealDeletion(pending, () => account);
    account = 'u2';
    authCompat.readToken.mockReturnValue('replacement-account-token');
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    pending.resolve(json({ status: 200, body: { deleted: true } }));
    await waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('u1'));
    expect(authCompat.logout).not.toHaveBeenCalled();
    expect(authCompat.showAuthMsg).not.toHaveBeenCalled();
  });

  it('a replacement session during local erasure cannot be logged out by the old completion', async () => {
    const pending = deferred<Response>();
    const wipe = deferred<{ erased: boolean; markPersisted: boolean }>();
    erasure.eraseLocalAccount.mockImplementationOnce(async (userId: string) => {
      order.push(`erase:${userId}`);
      return wipe.promise;
    });
    let account: string | null = 'u1';
    await beginRealDeletion(pending, () => account);
    pending.resolve(json({ status: 200, body: { deleted: true } }));
    await waitFor(() => expect(erasure.eraseLocalAccount).toHaveBeenCalledExactlyOnceWith('u1'));
    account = 'u2';
    authCompat.readToken.mockReturnValue('replacement-account-token');
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    wipe.resolve({ erased: true, markPersisted: true });
    await waitFor(() => expect(order).toContain('erase:u1'));
    await Promise.resolve();
    expect(authCompat.logout).not.toHaveBeenCalled();
    expect(authCompat.showAuthMsg).not.toHaveBeenCalled();
  });
});
