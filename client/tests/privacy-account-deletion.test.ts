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

const authCompat = vi.hoisted(() => ({ logout: vi.fn(), showAuthMsg: vi.fn() }));
vi.mock('../js/core/auth-compat.js', () => authCompat);

import { t } from '../js/core/i18n/index.ts';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { createSettingsStore } from '../js/core/settings/stores/settingsStore.ts';
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
});

afterEach(() => {
  cleanup();
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
  });

  it('PostgreSQL olmayan kurulumda (503) dürüstçe kullanılamaz der', async () => {
    replies['GET /api/account/deletion-preflight'] = [{ status: 503, body: { error: 'Requires PostgreSQL' } }];
    const v = view();
    await open(v);
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_unavailable')));
    expect(v.getByRole('button', { name: t('privacy_delete_start') })).not.toBeDisabled();
  });
});
