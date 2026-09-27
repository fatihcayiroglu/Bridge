import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { render, cleanup, waitFor } from '@testing-library/svelte';

let apiMock = vi.fn();
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => apiMock(...args) }));
import PluginTab from '../js/core/server-settings/tabs/PluginTab.svelte';
import SsoTab from '../js/core/server-settings/tabs/SsoTab.svelte';

const response = (ok: boolean, body: unknown, status = ok ? 200 : 500) => ({ ok, status, json: async () => body }) as Response;
beforeEach(() => { document.body.innerHTML = ''; apiMock = vi.fn(); });
afterEach(() => cleanup());

describe('PluginTab behavior', () => {
  it('renders valid plugin metadata, fallbacks and safe external-link attributes', async () => {
    apiMock = vi.fn(async () => response(true, [
      { _id: 'p1', name: 'Welcome', version: '1.2.3', author: 'Bridge', description: 'Greets users' },
      { id: 'p2' },
    ]));
    render(PluginTab);
    await waitFor(() => expect(document.body.textContent).toContain('Welcome'));
    expect(document.body.textContent).toContain('Greets users');
    expect(document.body.textContent).toContain(`v? · ${t('pmp_unknown')}`);
    const link = document.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows explicit empty state for an empty plugin inventory', async () => {
    apiMock = vi.fn(async () => response(true, [])); render(PluginTab);
    await waitFor(() => expect(document.body.textContent).toContain('Yüklü plugin bulunamadı'));
  });

  it('fails visibly on HTTP error, malformed JSON shape and rejected fetch', async () => {
    for (const impl of [
      () => Promise.resolve(response(false, {}, 503)),
      () => Promise.resolve(response(true, { not: 'array' })),
      () => Promise.reject(new Error('offline')),
    ]) {
      cleanup(); document.body.innerHTML = ''; apiMock = vi.fn(impl as any); render(PluginTab);
      await waitFor(() => expect(document.body.textContent).toContain('Plugin listesi alınamadı'));
    }
  });
});

describe('SsoTab behavior', () => {
  it('renders OIDC/SAML active state and metadata link from server truth', async () => {
    apiMock = vi.fn(async () => response(true, {
      oidc: { enabled: true }, saml: { enabled: true }, metadataUrl: 'https://bridge.test/api/sso/saml/metadata',
    }));
    render(SsoTab);
    await waitFor(() => expect(document.body.textContent).toContain(`OIDC: ${t('common_active_status')}`));
    expect(document.body.textContent).toContain('SAML: ✅ Aktif');
    const link = document.querySelector<HTMLAnchorElement>('a.sso-link')!;
    expect(link.href).toContain('/api/sso/saml/metadata');
    expect(link.rel).toContain('noopener');
    expect(document.body.textContent).toContain('mevcut provider/subject bağı e-posta ile değiştirilemez');
  });

  it('renders passive state without inventing a metadata link', async () => {
    apiMock = vi.fn(async () => response(true, { oidc: { enabled: false }, saml: {} }));
    render(SsoTab);
    await waitFor(() => expect(document.body.textContent).toContain(`OIDC: ${t('common_inactive_status')}`));
    expect(document.body.textContent).toContain(`SAML: ${t('common_inactive_status')}`);
    expect(document.querySelector('a.sso-link')).toBeNull();
  });

  it('HTTP ve ag hatasi "kapali" DEMEZ; durumun bilinemedigini soyler', async () => {
    // ONEMLI DAVRANIS DEGISIKLIGI: panel eskiden basarisiz bir istekten sonra
    // OIDC/SAML'i "Pasif" gosteriyordu — yani DOGRULANMAMIS bir seyi gercek
    // gibi sunuyordu. Uretim artik ayri bir "durum alinamadi" hali cizip
    // acikca "bu, ozelliklerin kapali oldugu anlamina gelmez" diyor.
    apiMock = vi.fn(async () => response(false, {}, 500)); render(SsoTab);
    await waitFor(() => expect(document.body.textContent).toContain(t('sso_status_unavailable')));
    expect(document.body.textContent).not.toContain(`OIDC: ${t('common_inactive_status')}`);
    cleanup(); document.body.innerHTML = '';

    apiMock = vi.fn(async () => { throw new Error('offline'); }); render(SsoTab);
    await waitFor(() => expect(document.body.textContent).toContain(t('sso_status_unavailable')));
    expect(document.body.textContent).not.toContain(`SAML: ${t('common_inactive_status')}`);
  });
});
