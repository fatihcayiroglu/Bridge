// P7 C3 — real PrivacyTab file selection and no-write portable import preview.
// Coverage does not substitute for product assertions: verify the actual
// request method, payload, UI result, rejection and absence of any write route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { createSettingsStore } from '../js/core/settings/stores/settingsStore.ts';
import PrivacyTab from '../js/core/settings/tabs/PrivacyTab.svelte';

vi.mock('../js/core/auth-compat.js', () => ({ logout: vi.fn(), showAuthMsg: vi.fn() }));

let apiFetch: ReturnType<typeof vi.fn>;
let reply: (url: string, init?: RequestInit) => Promise<Response>;

function portableFile(content: string, bytes = content.length): File {
  const file = new File([content], 'profile.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => content });
  if (bytes !== content.length) Object.defineProperty(file, 'size', { value: bytes });
  return file;
}
function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
const sixFields = [
  { field: 'displayName', current: 'Target', proposed: 'Source', changed: true },
  { field: 'bio', current: 'Same', proposed: 'Same', changed: false },
  { field: 'website', current: '', proposed: 'https://example.test', changed: true },
  { field: 'pronouns', current: '', proposed: '', changed: false },
  { field: 'avatarColor', current: '#abcdef', proposed: '#abcdef', changed: false },
  { field: 'bannerColor', current: '', proposed: '', changed: false },
];
const preview = (fields = sixFields, targetUserId = 'target') => ({
  dryRun: true, applied: false, checksumVerified: true,
  mapping: { sourceUserId: 'source-account', targetUserId, strategy: 'map-to-authenticated-account' },
  fields,
});
const source = { format: 'bridge-portable-identity', version: 1, identity: { username: 'source' } };
const view = () => render(PrivacyTab, { props: { store: createSettingsStore('privacy') } });

beforeEach(() => {
  reply = async () => { throw new Error('Unexpected API request'); };
  apiFetch = vi.fn((url: string, init?: RequestInit) => reply(url, init));
  BridgeRegistry.register('getMe', (() => ({ _id: 'target' })) as unknown as AnyFn);
  BridgeRegistry.register('apiFetch', apiFetch as unknown as AnyFn);
});
afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('apiFetch');
});

describe('P7 C3 portable profile preflight in the real PrivacyTab', () => {
  it('sends exactly one authenticated preview request and renders proposed profile differences without writes', async () => {
    const document = source;
    reply = async (url, init) => {
      expect(url).toBe('/api/account/portable-import/preview');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual(document);
      return response(preview());
    };
    const v = view();
    const input = v.getByTestId('portable-identity-preview-file') as HTMLInputElement;
    await fireEvent.change(input, { target: { files: [portableFile(JSON.stringify(document))] } });
    await waitFor(() => expect(v.getByTestId('portable-identity-preview-ok')).toBeTruthy());
    expect(v.getByText(/displayName: Target/).textContent).toContain('Source');
    expect(v.queryByText(/bio: Same/)).toBeNull(); // unchanged fields are not displayed
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0]?.[0]).toBe('/api/account/portable-import/preview');
  });

  it('rejects oversized files before any upload or request', async () => {
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile('{}', 16 * 1024 + 1)] },
    });
    await waitFor(() => expect(v.getByRole('alert').textContent).toBeTruthy());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull();
  });

  it('shows the server rejection for an invalid checksum and does not report success', async () => {
    reply = async () => response({ code: 'PORTABLE_IDENTITY_INVALID' }, 422);
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile('{"format":"bridge-portable-identity"}')] },
    });
    await waitFor(() => expect(v.getByRole('alert').textContent).toBeTruthy());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull();
  });

  it('refuses malformed JSON locally without attempting a network request', async () => {
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile('NOT JSON')] },
    });
    await waitFor(() => expect(v.getByRole('alert').textContent).toBeTruthy());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('refuses success-shaped responses that do not explicitly guarantee no writes', async () => {
    reply = async () => response({ dryRun: false, applied: true, checksumVerified: true, fields: [] });
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile('{}')] },
    });
    await waitFor(() => expect(v.getByRole('alert').textContent).toBeTruthy());
    expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
  it('never sends an apply write until BOTH explicit confirmations; sends exactly six original preview fields', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    reply = async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) as unknown });
      if (url.endsWith('/preview')) return response(preview());
      expect(url).toBe('/api/account/portable-import/apply');
      return response({ ok: true, applied: true, targetUserId: 'target', version: 1, appliedFields: ['displayName', 'website'] });
    };
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile(JSON.stringify(source))] },
    });
    await waitFor(() => expect(v.getByTestId('portable-identity-preview-ok')).toBeTruthy());
    const apply = v.getByTestId('portable-identity-apply') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    await fireEvent.click(apply);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await fireEvent.click(v.getByTestId('portable-identity-apply-ack'));
    expect(apply.disabled).toBe(true);
    await fireEvent.input(v.getByTestId('portable-identity-apply-phrase'), { target: { value: 'IMPORT' } });
    expect(apply.disabled).toBe(false);
    await fireEvent.click(apply);
    await waitFor(() => expect(v.getByTestId('portable-identity-apply-success')).toBeTruthy());
    expect(requests).toEqual([
      { url: '/api/account/portable-import/preview', body: source },
      { url: '/api/account/portable-import/apply',
        body: {
          document: source,
          expected: {
            displayName: 'Target', bio: 'Same', website: '', pronouns: '',
            avatarColor: '#abcdef', bannerColor: '',
          },
          confirm: 'APPLY_PORTABLE_PROFILE',
        } },
    ]);
    expect(v.queryByTestId('portable-identity-apply')).toBeNull();
    expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull();
  });

  it('fails closed on stale-preview conflict (409); a second write requires an entirely new preview', async () => {
    reply = async url => url.endsWith('/preview')
      ? response(preview())
      : response({ code: 'PORTABLE_PROFILE_CONFLICT' }, 409);
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile(JSON.stringify(source))] },
    });
    await waitFor(() => expect(v.getByTestId('portable-identity-apply')).toBeTruthy());
    await fireEvent.click(v.getByTestId('portable-identity-apply-ack'));
    await fireEvent.input(v.getByTestId('portable-identity-apply-phrase'), { target: { value: 'IMPORT' } });
    await fireEvent.click(v.getByTestId('portable-identity-apply'));
    await waitFor(() => expect(v.getByTestId('portable-identity-apply-error')).toBeTruthy());
    expect(v.queryByTestId('portable-identity-apply')).toBeNull();
    expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull();
    expect(v.queryByTestId('portable-identity-apply-success')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not fake success when step-up is refused/cancelled or a 200 response is not an apply receipt', async () => {
    let status = 403;
    reply = async url => url.endsWith('/preview')
      ? response(preview())
      : response(status === 403 ? { error: 'STEP_UP_REQUIRED' } : { ok: true, applied: false }, status);
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile(JSON.stringify(source))] },
    });
    await waitFor(() => expect(v.getByTestId('portable-identity-apply')).toBeTruthy());
    await fireEvent.click(v.getByTestId('portable-identity-apply-ack'));
    await fireEvent.input(v.getByTestId('portable-identity-apply-phrase'), { target: { value: 'IMPORT' } });
    await fireEvent.click(v.getByTestId('portable-identity-apply'));
    await waitFor(() => expect(v.getByTestId('portable-identity-apply-error')).toBeTruthy());
    expect(v.queryByTestId('portable-identity-apply-success')).toBeNull();
    status = 200;
    await fireEvent.click(v.getByTestId('portable-identity-apply'));
    await waitFor(() => expect(v.queryByTestId('portable-identity-preview-ok')).toBeNull());
    expect(v.queryByTestId('portable-identity-apply-success')).toBeNull();
  });

  it('rejects an untrusted partial / duplicate-field / wrong-target preview before enabling any write', async () => {
    const v = view();
    reply = async () => response(preview(sixFields, 'different-account'));
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile(JSON.stringify(source))] },
    });
    await waitFor(() => expect(v.getByRole('alert').textContent).toBeTruthy());
    expect(v.queryByTestId('portable-identity-apply')).toBeNull();
    reply = async () => response(preview([...sixFields.slice(0, 5), sixFields[0]!]));
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile(JSON.stringify(source))] },
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(v.queryByTestId('portable-identity-apply')).toBeNull();
  });

  it('cancels when the authenticated account changes after preview, without issuing a write', async () => {
    let owner = 'target';
    BridgeRegistry.register('getMe', (() => ({ _id: owner })) as unknown as AnyFn);
    reply = async () => response(preview());
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile(JSON.stringify(source))] },
    });
    await waitFor(() => expect(v.getByTestId('portable-identity-apply')).toBeTruthy());
    await fireEvent.click(v.getByTestId('portable-identity-apply-ack'));
    await fireEvent.input(v.getByTestId('portable-identity-apply-phrase'), { target: { value: 'IMPORT' } });
    owner = 'other';
    await fireEvent.click(v.getByTestId('portable-identity-apply'));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(v.queryByTestId('portable-identity-apply')).toBeNull();
    expect(v.getByTestId('portable-identity-apply-error').textContent).toBeTruthy();
  });

  it('erases the in-memory import intent on logout, even after both confirmations', async () => {
    reply = async () => response(preview());
    const v = view();
    await fireEvent.change(v.getByTestId('portable-identity-preview-file'), {
      target: { files: [portableFile(JSON.stringify(source))] },
    });
    await waitFor(() => expect(v.getByTestId('portable-identity-apply')).toBeTruthy());
    await fireEvent.click(v.getByTestId('portable-identity-apply-ack'));
    await fireEvent.input(v.getByTestId('portable-identity-apply-phrase'), { target: { value: 'IMPORT' } });
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    await waitFor(() => expect(v.queryByTestId('portable-identity-apply')).toBeNull());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

});
