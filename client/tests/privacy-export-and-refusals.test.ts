// client/tests/privacy-export-and-refusals.test.ts
//
// The Privacy tab is where a person takes their data out (personal export,
// portable profile export), brings a profile in, opts into AI assistance and
// deletes their account. The existing suites drive the main happy paths and
// the headline refusals. This suite drives the real component through the
// paths that were never executed:
//   - the data exports themselves (endpoint, file name, what is handed to the
//     browser, object URL release, busy state, refusals);
//   - the AI opt-in switch, through the real local preference owner;
//   - portable import races: identity changing while the file is read or the
//     preview answer is parsed, failures that arrive after a logout, a picker
//     closed without a file, a preview with nothing to change;
//   - portable apply when the API owner is gone, server errors other than 403,
//     the identity changing while the receipt is parsed, a legacy shell
//     without the AppState owner;
//   - account deletion refusals: no API owner, failed preflight, a 409 without
//     a blocker list, a form submitted without the acknowledgement, 503/500.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

const authCompat = vi.hoisted(() => ({ logout: vi.fn(), showAuthMsg: vi.fn(), updateUserPanel: vi.fn() }));
vi.mock('../js/core/auth-compat.js', () => authCompat);

import { t } from '../js/core/i18n/index.ts';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { initProductPreferences } from '../js/core/product-preferences.ts';
import { createSettingsStore } from '../js/core/settings/stores/settingsStore.ts';
import PrivacyTab from '../js/core/settings/tabs/PrivacyTab.svelte';

type Reply = (url: string, init?: RequestInit) => Promise<Response>;
let reply: Reply;
let apiFetch: ReturnType<typeof vi.fn>;
let owner: string | null;

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json' },
});
const method = (init?: RequestInit) => init?.method ?? 'GET';
const requests = () => apiFetch.mock.calls.map(c => `${method(c[1] as RequestInit | undefined)} ${String(c[0])}`);
const view = () => render(PrivacyTab, { props: { store: createSettingsStore('privacy') } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  owner = 'target';
  reply = async (url, init) => { throw new Error(`unexpected request ${method(init)} ${url}`); };
  apiFetch = vi.fn((url: string, init?: RequestInit) => reply(url, init));
  BridgeRegistry.register('getMe', (() => (owner ? { _id: owner } : null)) as unknown as AnyFn);
  BridgeRegistry.register('apiFetch', apiFetch as unknown as AnyFn);
  authCompat.logout.mockClear();
  authCompat.showAuthMsg.mockClear();
  authCompat.updateUserPanel.mockClear();
});

afterEach(() => {
  cleanup();
  for (const key of ['getMe', 'apiFetch', 'setMe']) BridgeRegistry.unregister(key);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Data export ────────────────────────────────────────────────────────────
describe('data export hands the server file to the browser and nothing else', () => {
  const personalLabel = () => t('surface_verilerimi_d_sa_aktar_86f34a');
  const exportFailed = () => t('ui_veriler_disa_aktarilamadi', 'Veriler dışa aktarılamadı.');
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let downloads: Array<{ href: string; download: string; connected: boolean; display: string }>;
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-04T10:00:00Z'));
    createObjectURL = vi.fn(() => 'blob:bridge/export-1');
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true });
    downloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, download: this.download, connected: this.isConnected, display: this.style.display });
    });
  });
  afterEach(() => {
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
    else delete (URL as unknown as Record<string, unknown>).createObjectURL;
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  it('personal export: one GET, the exact server bytes under a dated name, a hidden anchor removed after use, URL released', async () => {
    const body = { format: 'bridge-personal-export', user: { _id: 'target' }, messages: [] };
    const pending = deferred<Response>();
    reply = () => pending.promise;
    const v = view();
    const personal = v.getByRole('button', { name: personalLabel() }) as HTMLButtonElement;
    const portable = v.getByTestId('portable-identity-export') as HTMLButtonElement;

    await fireEvent.click(personal);
    // While the server prepares the file both export buttons are locked and say so.
    expect(personal.disabled).toBe(true);
    expect(portable.disabled).toBe(true);
    expect(personal.textContent?.trim()).toBe(t('surface_haz_rlan_yor_aa7fb7'));

    pending.resolve(json(body));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0]).toEqual(['/api/account/export']);
    expect(downloads[0]).toEqual({
      href: 'blob:bridge/export-1', download: 'bridge-personal-export-2026-03-04.json', connected: true, display: 'none',
    });
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toBe(JSON.stringify(body));
    expect(document.querySelector('a[download]')).toBeNull();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:bridge/export-1'));
    expect(personal.disabled).toBe(false);
    expect(personal.textContent?.trim()).toBe(personalLabel());
    expect(v.queryByRole('alert')).toBeNull();
  });

  it('portable export asks for the portable document and names it as identity v1', async () => {
    reply = async () => json({ format: 'bridge-portable-identity', version: 1 });
    const v = view();
    await fireEvent.click(v.getByTestId('portable-identity-export'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(requests()).toEqual(['GET /api/account/portable-export']);
    expect(downloads[0]?.download).toBe('bridge-portable-identity-v1-2026-03-04.json');
  });

  it('503 says export is unavailable on this installation, any other refusal says it failed; neither downloads', async () => {
    const statuses = [503, 500];
    reply = async () => json({ error: 'no' }, statuses.shift()!);
    const v = view();
    await fireEvent.click(v.getByRole('button', { name: personalLabel() }));
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(
      t('ui_veri_disa_aktarma_bu_kurulumda_su_anda_kullanilamiyo', 'Veri dışa aktarma bu kurulumda şu anda kullanılamıyor.')));

    await fireEvent.click(v.getByTestId('portable-identity-export'));
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(exportFailed()));
    expect(requests()).toEqual(['GET /api/account/export', 'GET /api/account/portable-export']);
    expect(downloads).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect((v.getByRole('button', { name: personalLabel() }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a network failure says export failed and unlocks the buttons', async () => {
    reply = async () => { throw new TypeError('Failed to fetch'); };
    const v = view();
    await fireEvent.click(v.getByRole('button', { name: personalLabel() }));
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(exportFailed()));
    expect(downloads).toEqual([]);
    expect((v.getByTestId('portable-identity-export') as HTMLButtonElement).disabled).toBe(false);
  });

  it('without the API owner it says export is unavailable and sends nothing', async () => {
    BridgeRegistry.unregister('apiFetch');
    const v = view();
    await fireEvent.click(v.getByTestId('portable-identity-export'));
    expect(v.getByRole('alert').textContent).toBe(
      t('ui_veri_disa_aktarma_su_anda_kullanilamiyor', 'Veri dışa aktarma şu anda kullanılamıyor.'));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(downloads).toEqual([]);
  });
});

// ── AI assistance opt-in ───────────────────────────────────────────────────
describe('AI assistance is a local opt-in that starts off', () => {
  const turnOn = () => t('surface_yapay_zeka_yard_m_n_ac_8580b4');
  const turnOff = () => t('surface_yapay_zeka_yard_m_n_kapat_6b0305');

  beforeEach(() => {
    localStorage.removeItem('bridge_ai_assistance');
    initProductPreferences();
  });
  afterEach(() => {
    localStorage.removeItem('bridge_ai_assistance');
    BridgeRegistry.unregister('getAiAssistanceEnabled');
    BridgeRegistry.unregister('setAiAssistanceEnabled');
  });

  it('switching it on and off goes through the preference owner, which persists and announces it; no request is sent', async () => {
    const announced: boolean[] = [];
    const onChange = (e: Event) => announced.push((e as CustomEvent<{ enabled: boolean }>).detail.enabled);
    document.addEventListener('bridge:ai-assistance-changed', onChange);
    try {
      const v = view();
      const toggle = v.getByRole('button', { name: turnOn() });
      expect(toggle.getAttribute('aria-pressed')).toBe('false');

      await fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.getAttribute('aria-label')).toBe(turnOff());
      expect(localStorage.getItem('bridge_ai_assistance')).toBe('enabled');
      expect(document.documentElement.dataset.aiAssistance).toBe('enabled');

      await fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(localStorage.getItem('bridge_ai_assistance')).toBe('disabled');
      expect(document.documentElement.dataset.aiAssistance).toBe('disabled');
      expect(announced).toEqual([true, false]);
      expect(apiFetch).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('bridge:ai-assistance-changed', onChange);
    }
  });

  it('a stored opt-in is shown as on when the tab opens again', () => {
    localStorage.setItem('bridge_ai_assistance', 'enabled');
    const v = view();
    expect(v.getByRole('button', { name: turnOff() }).getAttribute('aria-pressed')).toBe('true');
  });
});

// ── Portable profile import: preview ───────────────────────────────────────
function portableFile(content: string | Promise<string>): File {
  const file = new File(['{}'], 'profile.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) });
  return file;
}
const sixFields = [
  { field: 'displayName', current: 'Target', proposed: 'Source', changed: true },
  { field: 'bio', current: 'Same', proposed: 'Same', changed: false },
  { field: 'website', current: '', proposed: 'https://example.test', changed: true },
  { field: 'pronouns', current: '', proposed: '', changed: false },
  { field: 'avatarColor', current: '#abcdef', proposed: '#abcdef', changed: false },
  { field: 'bannerColor', current: '', proposed: '', changed: false },
];
const unchanged = sixFields.map(f => ({ ...f, proposed: f.current, changed: false }));
const preview = (fields = sixFields) => ({
  dryRun: true, applied: false, checksumVerified: true,
  mapping: { sourceUserId: 'source-account', targetUserId: 'target', strategy: 'map-to-authenticated-account' },
  fields,
});
const source = { format: 'bridge-portable-identity', version: 1, identity: { username: 'source' } };
const pick = (v: ReturnType<typeof view>, file: File | null) =>
  fireEvent.change(v.getByTestId('portable-identity-preview-file'), { target: { files: file ? [file] : [] } });
const previewError = () => t('privacy_portable_preview_error', 'Dosya geçersiz, değiştirilmiş veya desteklenmeyen bir sürümde.');
const applyError = () => t('privacy_portable_apply_error', 'Profil içe aktarılamadı. Yeniden deneyin.');

/** A response whose JSON body only arrives when the test says so. */
function slowJson(status = 200) {
  const body = deferred<unknown>();
  const response = { ok: status >= 200 && status < 300, status, json: () => body.promise } as unknown as Response;
  return { response, body };
}

describe('portable profile preview: nothing from another session or a closed picker reaches the screen', () => {
  it('closing the file picker without a file keeps the current preview and sends nothing', async () => {
    reply = async () => json(preview());
    const v = view();
    await pick(v, portableFile(JSON.stringify(source)));
    await waitFor(() => expect(v.getByTestId('portable-identity-preview-ok')).toBeTruthy());
    await pick(v, null);
    expect(v.getByTestId('portable-identity-preview-ok')).toBeTruthy();
    expect(v.getByTestId('portable-identity-apply')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('a file identical to the current profile is previewed but offers no apply control', async () => {
    reply = async () => json(preview(unchanged));
    const v = view();
    await pick(v, portableFile(JSON.stringify(source)));
    await waitFor(() => expect(v.getByTestId('portable-identity-preview-ok')).toBeTruthy());
    expect(v.getByText(t('privacy_portable_no_changes', 'İçe aktarılacak profil farkı bulunamadı.'))).toBeTruthy();
    expect(v.queryByTestId('portable-identity-apply-panel')).toBeNull();
    expect(v.queryByTestId('portable-identity-apply')).toBeNull();
  });

  it('refuses to preview when nobody is signed in, and when the API owner is missing; nothing is uploaded', async () => {
    owner = null;
    const v = view();
    await pick(v, portableFile(JSON.stringify(source)));
    expect(v.getByRole('alert').textContent).toBe(previewError());

    owner = 'target';
    BridgeRegistry.unregister('apiFetch');
    await pick(v, portableFile(JSON.stringify(source)));
    expect(v.getByRole('alert').textContent).toBe(previewError());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('a sign-in that happens while the file is being read stops the preview before any upload', async () => {
    const text = deferred<string>();
    const v = view();
    const selecting = pick(v, portableFile(text.promise));
    await waitFor(() => expect((v.getByTestId('portable-identity-preview-file') as HTMLInputElement).disabled).toBe(true));
    owner = 'another-account';
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    text.resolve(JSON.stringify(source));
    await selecting;
    await Promise.resolve();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull();
    expect(v.queryByRole('alert')).toBeNull();
    expect((v.getByTestId('portable-identity-preview-file') as HTMLInputElement).disabled).toBe(false);
  });

  it('a preview answer parsed after the signed-in account changed is dropped, not shown to the new account', async () => {
    const slow = slowJson();
    reply = async () => slow.response;
    const v = view();
    await pick(v, portableFile(JSON.stringify(source)));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    owner = 'another-account';
    slow.body.resolve(preview());
    await waitFor(() => expect((v.getByTestId('portable-identity-preview-file') as HTMLInputElement).disabled).toBe(false));
    expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull();
    expect(v.queryByText(/displayName: Target/)).toBeNull();
    expect(v.queryByRole('alert')).toBeNull();
  });

  it('a preview upload that fails after logout does not show the previous session an error', async () => {
    const upload = deferred<Response>();
    reply = () => upload.promise;
    const v = view();
    await pick(v, portableFile(JSON.stringify(source)));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    upload.reject(new TypeError('Failed to fetch'));
    await new Promise(r => setTimeout(r, 0));
    expect(v.queryByRole('alert')).toBeNull();
    expect((v.getByTestId('portable-identity-preview-file') as HTMLInputElement).disabled).toBe(false);
  });
});

// ── Portable profile import: apply ─────────────────────────────────────────
async function armApply(v: ReturnType<typeof view>): Promise<HTMLButtonElement> {
  await pick(v, portableFile(JSON.stringify(source)));
  await waitFor(() => expect(v.getByTestId('portable-identity-apply')).toBeTruthy());
  await fireEvent.click(v.getByTestId('portable-identity-apply-ack'));
  await fireEvent.input(v.getByTestId('portable-identity-apply-phrase'), { target: { value: 'IMPORT' } });
  const apply = v.getByTestId('portable-identity-apply') as HTMLButtonElement;
  expect(apply.disabled).toBe(false);
  return apply;
}
const receipt = { ok: true, applied: true, targetUserId: 'target', version: 1 };

describe('portable profile apply: refusals keep the account untouched and say why', () => {
  it('without the API owner at apply time it reports the failure and sends no write', async () => {
    reply = async () => json(preview());
    const v = view();
    const apply = await armApply(v);
    BridgeRegistry.unregister('apiFetch');
    await fireEvent.click(apply);
    expect(v.getByTestId('portable-identity-apply-error').textContent).toBe(applyError());
    expect(requests()).toEqual(['POST /api/account/portable-import/preview']);
  });

  it('403 asks for the security proof, any other server error says the import failed; the preview stays for a retry', async () => {
    const statuses = [403, 500];
    reply = async url => url.endsWith('/preview') ? json(preview()) : json({ error: 'no' }, statuses.shift()!);
    const v = view();
    const apply = await armApply(v);
    await fireEvent.click(apply);
    await waitFor(() => expect(v.getByTestId('portable-identity-apply-error').textContent).toBe(
      t('privacy_portable_proof_required', 'Güvenlik doğrulaması gerekli; işlem yapılmadı.')));
    await fireEvent.click(v.getByTestId('portable-identity-apply'));
    await waitFor(() => expect(v.getByTestId('portable-identity-apply-error').textContent).toBe(applyError()));
    expect(v.getByTestId('portable-identity-preview-ok')).toBeTruthy();
    expect(v.queryByTestId('portable-identity-apply-success')).toBeNull();
    expect(authCompat.updateUserPanel).not.toHaveBeenCalled();
  });

  it('a receipt parsed after the signed-in account changed is not applied to anyone\'s profile', async () => {
    const setMe = vi.fn();
    BridgeRegistry.register('setMe', setMe as unknown as AnyFn);
    const slow = slowJson();
    reply = async url => url.endsWith('/preview') ? json(preview()) : slow.response;
    const v = view();
    await fireEvent.click(await armApply(v));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    owner = 'another-account';
    slow.body.resolve(receipt);
    await waitFor(() => expect((v.getByTestId('portable-identity-preview-file') as HTMLInputElement).disabled).toBe(false));
    expect(v.queryByTestId('portable-identity-apply-success')).toBeNull();
    expect(setMe).not.toHaveBeenCalled();
    expect(authCompat.updateUserPanel).not.toHaveBeenCalled();
  });

  it('a network failure says the import failed; one that lands after logout says nothing', async () => {
    const writes = [deferred<Response>(), deferred<Response>()];
    let n = 0;
    reply = url => url.endsWith('/preview') ? Promise.resolve(json(preview())) : writes[n++]!.promise;
    const v = view();
    await fireEvent.click(await armApply(v));
    writes[0]!.reject(new TypeError('Failed to fetch'));
    await waitFor(() => expect(v.getByTestId('portable-identity-apply-error').textContent).toBe(applyError()));

    await fireEvent.click(v.getByTestId('portable-identity-apply'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    writes[1]!.reject(new TypeError('Failed to fetch'));
    await new Promise(r => setTimeout(r, 0));
    expect(v.queryByTestId('portable-identity-apply-error')).toBeNull();
    expect(v.queryByTestId('portable-identity-apply')).toBeNull();
  });

  it('in a legacy shell without the AppState owner the accepted fields still reach the panel and the same-account globals only', async () => {
    const legacy = globalThis as typeof globalThis & {
      currentUser?: Record<string, unknown> | null; me?: Record<string, unknown> | null;
    };
    const before = { currentUser: legacy.currentUser, me: legacy.me };
    const otherAccount = { _id: 'someone-else', displayName: 'Other' };
    legacy.currentUser = otherAccount;
    legacy.me = { _id: 'target', displayName: 'Target' };
    reply = async url => url.endsWith('/preview') ? json(preview()) : json(receipt);
    try {
      const v = view();
      await fireEvent.click(await armApply(v));
      await waitFor(() => expect(v.getByTestId('portable-identity-apply-success')).toBeTruthy());
      expect(BridgeRegistry.has('setMe')).toBe(false);
      expect(legacy.me).toMatchObject({ _id: 'target', displayName: 'Source', website: 'https://example.test', bio: 'Same' });
      expect(legacy.currentUser).toBe(otherAccount);
      expect(otherAccount.displayName).toBe('Other');
      expect(authCompat.updateUserPanel).toHaveBeenCalledWith(legacy.me);
    } finally {
      legacy.currentUser = before.currentUser;
      legacy.me = before.me;
    }
  });
});

// ── Account deletion refusals ──────────────────────────────────────────────
describe('account deletion refusals never sign the person out', () => {
  const start = (v: ReturnType<typeof view>) => fireEvent.click(v.getByRole('button', { name: t('privacy_delete_start') }));
  type Step = { status: number; body?: unknown } | Error;
  let steps: Record<string, Step[]>;
  beforeEach(() => {
    steps = {};
    reply = async (url, init) => {
      const key = `${method(init)} ${url}`;
      const next = steps[key]?.shift();
      if (!next) throw new Error(`unexpected request ${key}`);
      if (next instanceof Error) throw next;
      return new Response(next.body === undefined ? 'not json' : JSON.stringify(next.body), { status: next.status });
    };
  });
  async function ready(v: ReturnType<typeof view>, password = 'pw') {
    await start(v);
    await waitFor(() => v.getByLabelText(t('privacy_delete_password')));
    await fireEvent.input(v.getByLabelText(t('privacy_delete_password')), { target: { value: password } });
    await fireEvent.click(v.getByLabelText(t('privacy_delete_ack')));
  }

  it('without the API owner it says deletion is unavailable and does not open the form', async () => {
    BridgeRegistry.unregister('apiFetch');
    const v = view();
    await start(v);
    expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_unavailable'));
    expect(v.queryByLabelText(t('privacy_delete_password'))).toBeNull();
    expect(v.getByRole('button', { name: t('privacy_delete_start') })).not.toBeDisabled();
  });

  it('a failed or unreachable preflight says deletion failed and returns to the start button', async () => {
    steps['GET /api/account/deletion-preflight'] = [{ status: 500, body: { error: 'boom' } }, new TypeError('Failed to fetch')];
    const v = view();
    await start(v);
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_failed')));
    expect(v.getByRole('button', { name: t('privacy_delete_start') })).not.toBeDisabled();
    await start(v);
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_failed')));
    expect(v.queryByLabelText(t('privacy_delete_password'))).toBeNull();
  });

  it('a preflight without a blocker list opens the form; a server blocker without a name is still listed', async () => {
    steps['GET /api/account/deletion-preflight'] = [
      { status: 200, body: { canDelete: true } },
      { status: 200, body: { canDelete: false, blockers: [{ kind: 'server', id: 's1', memberCount: 2 }] } },
    ];
    const v = view();
    await start(v);
    await waitFor(() => expect(v.getByLabelText(t('privacy_delete_password'))).toBeTruthy());
    await fireEvent.click(v.getByTestId('delete-account-cancel'));
    await start(v);
    await waitFor(() => expect(v.getByTestId('delete-account-blockers').textContent?.trim())
      .toBe(t('privacy_delete_blocker_server', undefined, { name: '', count: 2 })));
  });

  it('submitting the form (Enter) without the acknowledgement sends no DELETE', async () => {
    steps['GET /api/account/deletion-preflight'] = [{ status: 200, body: { blockers: [] } }];
    const v = view();
    await start(v);
    await waitFor(() => v.getByLabelText(t('privacy_delete_password')));
    await fireEvent.input(v.getByLabelText(t('privacy_delete_password')), { target: { value: 'pw' } });
    await fireEvent.submit(v.getByLabelText(t('privacy_delete_password')).closest('form')!);
    expect(requests()).toEqual(['GET /api/account/deletion-preflight']);
    expect(authCompat.logout).not.toHaveBeenCalled();
  });

  it('if the API owner is gone at confirmation it says unavailable and sends no DELETE', async () => {
    steps['GET /api/account/deletion-preflight'] = [{ status: 200, body: { blockers: [] } }];
    const v = view();
    await ready(v);
    BridgeRegistry.unregister('apiFetch');
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));
    expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_unavailable'));
    expect(requests()).toEqual(['GET /api/account/deletion-preflight']);
    expect(authCompat.logout).not.toHaveBeenCalled();
  });

  it('a 409 without a readable blocker list keeps the form, clears the password and says deletion failed', async () => {
    steps['GET /api/account/deletion-preflight'] = [{ status: 200, body: { blockers: [] } }];
    steps['DELETE /api/account'] = [{ status: 409 }];
    const v = view();
    await ready(v, 'secret');
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_failed')));
    expect((v.getByLabelText(t('privacy_delete_password')) as HTMLInputElement).value).toBe('');
    expect(v.queryByTestId('delete-account-blockers')).toBeNull();
    expect(authCompat.logout).not.toHaveBeenCalled();
  });

  it('503 says unavailable, 500 says failed; the session stays and the form stays usable', async () => {
    steps['GET /api/account/deletion-preflight'] = [{ status: 200, body: { blockers: [] } }];
    steps['DELETE /api/account'] = [{ status: 503, body: { error: 'Requires PostgreSQL' } }, { status: 500, body: { error: 'x' } }];
    const v = view();
    await ready(v);
    const confirm = v.getByRole('button', { name: t('privacy_delete_confirm') });
    await fireEvent.click(confirm);
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_unavailable')));
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_failed')));
    expect(requests()).toEqual(['GET /api/account/deletion-preflight', 'DELETE /api/account', 'DELETE /api/account']);
    expect(authCompat.logout).not.toHaveBeenCalled();
    expect(authCompat.showAuthMsg).not.toHaveBeenCalled();
  });

  it('a DELETE that never reaches the server says deletion failed and keeps the session', async () => {
    steps['GET /api/account/deletion-preflight'] = [{ status: 200, body: { blockers: [] } }];
    steps['DELETE /api/account'] = [new TypeError('Failed to fetch')];
    const v = view();
    await ready(v);
    await fireEvent.click(v.getByRole('button', { name: t('privacy_delete_confirm') }));
    await waitFor(() => expect(v.getByRole('alert').textContent).toBe(t('privacy_delete_failed')));
    expect(v.getByRole('button', { name: t('privacy_delete_confirm') })).not.toBeDisabled();
    expect(authCompat.logout).not.toHaveBeenCalled();
    expect(authCompat.showAuthMsg).not.toHaveBeenCalled();
  });
});

// ── Saved indicator ────────────────────────────────────────────────────────
describe('saved indicator', () => {
  it('a second save restarts the two-second confirmation instead of clearing it early', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => true);
    const v = render(PrivacyTab, { props: { store: { save, error: null } as never } });
    const select = v.getByLabelText(t('markup_kimden_dm_alabilirim_6df19a8', 'Kimden DM alabilirim'));
    await fireEvent.change(select, { target: { value: 'friends' } });
    await fireEvent.click(v.getByRole('button', { name: t('save') }));
    await vi.waitFor(() => expect(v.container).toHaveTextContent(t('ui_saved')));

    await vi.advanceTimersByTimeAsync(1500);
    await fireEvent.change(select, { target: { value: 'none' } });
    await fireEvent.click(v.getByRole('button', { name: `✓ ${t('ui_saved')}` }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(1000); // 2.5 s after the first save, 1 s after the second
    expect(v.container).toHaveTextContent(t('ui_saved'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(v.container).not.toHaveTextContent(t('ui_saved'));
    expect(save.mock.calls.map(c => (c as unknown as [Record<string, unknown>])[0].dmPrivacy)).toEqual(['friends', 'none']);
  });
});
