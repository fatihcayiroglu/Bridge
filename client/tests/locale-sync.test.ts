// client/tests/locale-sync.test.ts — Final21 Phase 16.
//
// The server writes push titles in the language this person reads, but only if the client tells
// it. Reporting is best effort: it must never throw into the caller and must not repeat itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
const readToken = vi.fn();

vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('../js/core/auth-compat.js', () => ({ readToken: () => readToken() }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'https://bridge.test' }));
vi.mock('../js/core/logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));

const load = async () => {
  const mod = await import('../js/core/i18n/locale-sync.ts');
  mod.resetReportedLocale();
  return mod;
};

beforeEach(() => {
  apiFetch.mockReset();
  readToken.mockReset();
  readToken.mockReturnValue('token-1');
  apiFetch.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.resetModules(); });

describe('reportLocaleToServer', () => {
  it('sends the locale to PATCH /api/me', async () => {
    const { reportLocaleToServer } = await load();
    await expect(reportLocaleToServer('de')).resolves.toBe('sent');
    expect(apiFetch).toHaveBeenCalledWith('https://bridge.test/api/me', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ locale: 'de' }),
    }));
  });

  it('does not repeat the same locale', async () => {
    const { reportLocaleToServer } = await load();
    await reportLocaleToServer('de');
    await expect(reportLocaleToServer('de')).resolves.toBe('skipped');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('reports again when the person switches language', async () => {
    const { reportLocaleToServer } = await load();
    await reportLocaleToServer('de');
    await expect(reportLocaleToServer('ja')).resolves.toBe('sent');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('stays quiet before sign-in — there is nobody to store it for', async () => {
    readToken.mockReturnValue(null);
    const { reportLocaleToServer } = await load();
    await expect(reportLocaleToServer('de')).resolves.toBe('skipped');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('a refused request is reported as failed and is retried next time', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { reportLocaleToServer } = await load();
    await expect(reportLocaleToServer('de')).resolves.toBe('failed');
    apiFetch.mockResolvedValueOnce({ ok: true });
    await expect(reportLocaleToServer('de')).resolves.toBe('sent');
  });

  it('a transport error never throws into the caller', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    const { reportLocaleToServer } = await load();
    await expect(reportLocaleToServer('de')).resolves.toBe('failed');
  });

  it('an empty locale is not sent', async () => {
    const { reportLocaleToServer } = await load();
    await expect(reportLocaleToServer('')).resolves.toBe('skipped');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
