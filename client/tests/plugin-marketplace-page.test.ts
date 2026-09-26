import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
const fetchMock = vi.fn();
let registry: typeof import('../js/core/bridge-registry.ts').BridgeRegistry;

const jsonResponse = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

async function boot() {
  vi.resetModules();
  registry = (await import('../js/core/bridge-registry.ts')).BridgeRegistry;
  await import('../js/plugin-marketplace-page.ts');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = `
    <input id="q"><section id="plugins"></section><section id="bots"></section>
    <button id="refresh" data-bridge-action="loadMarketplace"><span>refresh</span></button>
    <div id="marketplace-modal" tabindex="-1" style="display:none"><div id="mkt-modal-content"></div><button data-bridge-action="closeMktModal">close</button></div>`;
  localStorage.clear(); localStorage.setItem('token', 'token-1');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/plugins')) return jsonResponse([{ id: 'p1', name: '<img src=x onerror=1>', description: 'Plugin desc', author: 'A&B', version: '1.0' }]);
    if (url.includes('/api/bots/marketplace') && init?.method !== 'POST') return jsonResponse({ bots: [{ id: 'b/1', name: '<script>x</script>', description: 'Bot desc', category: 'utility', installs: 2, rating: 4.5, ratingCount: 2, commands: ['x'], supportUrl: 'javascript:alert(1)', sourceUrl: 'https://example.com/src' }], total: 1, limit: 60, offset: 0 });
    if (url.includes('/rating')) return jsonResponse({ id: 'b/1' });
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  for (const key of ['closeMktModal','showPluginDetails','showBotDetails','rateMarketplaceBot','loadMarketplace']) registry?.unregister(key);
  vi.unstubAllGlobals();
});

describe('plugin marketplace production page', () => {
  it('loads authenticated plugin/bot catalogs and escapes hostile metadata', async () => {
    await boot();
    // Sayfa artik kanonik `apiFetch` kullaniyor: yetkilendirme bir `Headers`
    // ornegi icinde tasinir (duz nesne degil) ve `credentials: 'include'`
    // eklenir. Duz-nesne bekleyen eski iddia, isteğin GERCEKTEN yetkili
    // oldugunu artik dogrulayamiyordu.
    const pluginCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/plugins'));
    expect(pluginCall).toBeTruthy();
    const pluginInit = pluginCall![1] as RequestInit;
    expect(new Headers(pluginInit.headers).get('Authorization')).toBe('Bearer token-1');
    expect(pluginInit.credentials).toBe('include');
    expect(document.querySelector('#plugins img')).toBeNull();
    expect(document.getElementById('plugins')!.textContent).toContain('<img src=x onerror=1>');
    expect(document.querySelector('#bots script')).toBeNull();
    expect(document.getElementById('bots')!.textContent).toContain('<script>x</script>');
  });

  it('shows safe details and rejects non-http support links', async () => {
    await boot();
    const details = document.querySelector<HTMLButtonElement>('#bots [data-bridge-action="showBotDetails"]')!;
    details.click();
    const box = document.getElementById('mkt-modal-content')!;
    expect(box.querySelector('script')).toBeNull();
    expect(box.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(box.querySelector('a[href="https://example.com/src"]')).not.toBeNull();
    expect(document.getElementById('marketplace-modal')!.style.display).toBe('flex');
    document.querySelector<HTMLButtonElement>('[data-bridge-action="closeMktModal"]')!.click();
    expect(document.getElementById('marketplace-modal')!.style.display).toBe('none');
  });

  it('dispatches standalone page controls, closes on Escape/backdrop, and ignores untrusted actions', async () => {
    await boot();
    const callsBeforeRefresh = fetchMock.mock.calls.length;
    document.querySelector<HTMLElement>('#refresh span')!.click();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));

    await vi.waitFor(() => expect(document.querySelector('#plugins [data-bridge-action="showPluginDetails"]')).not.toBeNull());
    const pluginDetails = document.querySelector<HTMLButtonElement>('#plugins [data-bridge-action="showPluginDetails"]')!;
    pluginDetails.focus();
    pluginDetails.click();
    const modal = document.getElementById('marketplace-modal')!;
    expect(modal.style.display).toBe('flex');
    // Odak artik kabin KENDISINE degil, icindeki ilk odaklanabilir ogeye
    // taşınır — ekran okuyucu ve klavye icin dogrusu budur.
    expect(modal.contains(document.activeElement)).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(modal.style.display).toBe('none');
    expect(document.activeElement).toBe(pluginDetails);

    pluginDetails.click();
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.style.display).toBe('none');

    const hostile = document.createElement('button');
    hostile.dataset.bridgeAction = 'notAllowed';
    document.body.appendChild(hostile);
    hostile.click();
    expect(modal.style.display).toBe('none');
  });

  it('validates ratings locally, posts canonical integer ratings, then refreshes the catalog', async () => {
    await boot();
    registry.call('showBotDetails', 0);
    const input = document.getElementById('mkt-rate-value') as HTMLInputElement;
    input.value = '6';
    await registry.call<Promise<void>>('rateMarketplaceBot', 'b/1');
    expect(document.getElementById('mkt-rate-status')?.textContent).toMatch(/1–5/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/rating'))).toBe(false);

    input.value = '4';
    await registry.call<Promise<void>>('rateMarketplaceBot', 'b/1');
    const ratingCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/rating'));
    expect(ratingCall?.[0]).toContain('/b%2F1/rating');
    expect(ratingCall?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ rating: 4 }) }));
    expect(document.getElementById('mkt-rate-status')?.textContent).toBe('Puanlama kaydedildi.');
    expect(document.getElementById('mkt-rate-status')?.dataset.status).toBe('success');
  });

  it('filters on Enter and degrades both catalog failures into bounded UI messages', async () => {
    await boot();
    const q = document.getElementById('q') as HTMLInputElement;
    q.value = 'missing';
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(document.getElementById('plugins')!.textContent).toContain('Plugin bulunamadı'));

    fetchMock.mockRejectedValue(new Error('offline'));
    await registry.call<Promise<void>>('loadMarketplace');
    expect(document.getElementById('plugins')!.textContent).toContain('giriş yapman gerekiyor');
    expect(document.getElementById('bots')!.textContent).toContain('yüklenemedi');
  });

  it('renders sparse catalog fallbacks and contains absent detail/modal owners', async () => {
    localStorage.clear();
    fetchMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url.includes('/api/plugins')) return jsonResponse([{}]);
      if (url.includes('/api/bots/marketplace')) {
        return jsonResponse({
          bots: [{ id: 'fallback', name: '', supportUrl: '#', sourceUrl: 'http://[' }],
          total: 1, limit: 60, offset: 0,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await boot();

    // Jeton yokken de istek KANONIK `apiFetch` uzerinden gider; yalnizca
    // `Authorization` baslıgı olusmaz.
    const anonCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/plugins'));
    expect(anonCall).toBeTruthy();
    expect(new Headers((anonCall![1] as RequestInit).headers).get('Authorization')).toBeNull();
    expect(document.getElementById('plugins')?.textContent).toContain('Plugin');
    expect(document.getElementById('plugins')?.textContent).toContain('Açıklama yok');
    expect(document.getElementById('bots')?.textContent).toContain('utility');

    registry.call('showPluginDetails', 0);
    expect(document.getElementById('mkt-modal-content')?.textContent)
      .toContain(t('pmp_author', undefined, { author: t('pmp_unknown') }));
    expect(document.getElementById('mkt-modal-content')?.textContent).toContain('ID: -');
    registry.call('showPluginDetails', 999);

    const box = document.getElementById('mkt-modal-content')!;
    document.getElementById('marketplace-modal')!.remove();
    document.body.appendChild(box);
    registry.call('showPluginDetails', 0);
    registry.call('showBotDetails', 0);
    expect(box.textContent).toContain('Komut: 0');
    expect(box.querySelector('a')).toBeNull();
    registry.call('showBotDetails', 999);

    box.remove();
    registry.call('showPluginDetails', 0);
    registry.call('showBotDetails', 0);
    registry.call('closeMktModal');
  });

  it('normalizes malformed catalog shapes, empty search results, missing hosts, and non-Enter keys', async () => {
    const q = document.getElementById('q') as HTMLInputElement;
    q.value = 'needle';
    let malformed = false;
    fetchMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url.includes('/api/plugins')) return jsonResponse(malformed ? { plugins: [] } : [{}]);
      if (url.includes('/api/bots/marketplace')) {
        return jsonResponse(malformed ? { bots: null } : { bots: [], total: 0, limit: 60, offset: 0 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await boot();

    expect(document.getElementById('plugins')?.textContent).toContain('bulunamadı');
    expect(document.getElementById('bots')?.textContent).toContain('bulunamadı');
    const callsBeforeEscape = fetchMock.mock.calls.length;
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeEscape);

    malformed = true;
    q.value = '';
    await registry.call<Promise<void>>('loadMarketplace');
    expect(document.getElementById('plugins')?.textContent).toContain('bulunamadı');
    expect(document.getElementById('bots')?.textContent).toContain('bulunamadı');

    document.getElementById('plugins')?.remove();
    document.getElementById('bots')?.remove();
    document.getElementById('q')?.remove();
    await expect(registry.call<Promise<void>>('loadMarketplace')).resolves.toBeUndefined();
  });

  it('surfaces HTTP failures and non-Error rating transport failures with bounded fallbacks', async () => {
    localStorage.clear();
    fetchMock.mockResolvedValue(jsonResponse({}, false, 418));
    await boot();
    await vi.waitFor(() => expect(document.getElementById('plugins')?.textContent).toContain('giriş'));
    expect(document.getElementById('bots')?.textContent).toContain('yüklenemedi');

    const input = document.createElement('input');
    input.id = 'mkt-rate-value';
    input.type = 'number';
    input.value = '3';
    const status = document.createElement('p');
    status.id = 'mkt-rate-status';
    document.body.append(input, status);
    fetchMock.mockRejectedValue('offline');
    await registry.call<Promise<void>>('rateMarketplaceBot', 'bot');
    expect(document.getElementById('mkt-rate-status')?.textContent).toMatch(/başarısız/i);

    input.value = '0';
    await registry.call<Promise<void>>('rateMarketplaceBot', 'bot');
    expect(document.getElementById('mkt-rate-status')?.textContent).toMatch(/1–5/);
    input.remove();
    await registry.call<Promise<void>>('rateMarketplaceBot', 'bot');
    expect(document.getElementById('mkt-rate-status')?.textContent).toMatch(/1–5/);
  });
});
