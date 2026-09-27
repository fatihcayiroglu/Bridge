import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { t } from '../js/core/i18n/index.ts';

const { catalog, plugins, loadCatalogMock, fetchPluginsMock, injectStylesMock } = vi.hoisted(() => ({
  catalog: [
    { id: 'safe', name: 'Safe Bot', category: 'utility', tags: ['<img src=x onerror=1>', 'tools'], description: 'helper', longDescription: 'long safe', rating: 4.4, installs: 12, avatar: '🤖', author: 'Bridge', commands: ['/safe'], featured: true },
    { id: 'music', name: 'Music Bot', category: 'music', tags: ['music'], description: 'beats', longDescription: 'long music', rating: 3, installs: 2, avatar: '🎵', author: 'Bridge', commands: ['/play'], featured: false },
  ] as any[],
  plugins: [{ id: 'plug', name: 'Loaded Plugin', category: 'plugin', tags: [], description: 'plugin desc', rating: 0 }] as any[],
  loadCatalogMock: vi.fn(async () => undefined),
  fetchPluginsMock: vi.fn(async () => undefined),
  injectStylesMock: vi.fn(),
}));
vi.mock('../js/core/bot-marketplace/bot-catalog.js', () => ({ getCatalog: () => catalog, loadCatalog: loadCatalogMock }));
vi.mock('../js/core/bot-marketplace/bot-api.js', () => ({ fetchLoadedPlugins: fetchPluginsMock, getLoadedPlugins: () => plugins }));
vi.mock('../js/core/bot-marketplace/bot-styles.js', () => ({ injectStyles: injectStylesMock }));
vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  // KANONIK SOZLUGE DEVRET.
  // Onceki cift `(_k, fallback) => fallback` idi; yani YEDEK METNI OLMAYAN her
  // cagri (`t("market_install_unavailable")`, `t(cat.labelKey)`) `undefined`
  // donduruyordu. Boylece kurulum butonunun ve kategori butonlarinin
  // erisilebilir ADI bos kaliyor, testler de gercek urunu degil, kusurlu
  // cifti olcuyordu.
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});

import BotMarketplace from '../js/core/bot-marketplace/BotMarketplace.svelte';

beforeEach(() => { document.body.innerHTML = ''; loadCatalogMock.mockClear(); fetchPluginsMock.mockClear(); injectStylesMock.mockClear(); });
afterEach(() => cleanup());

describe('BotMarketplace dormant all-source surface', () => {
  it('loads catalog/plugins, renders hostile tags as text, and never advertises fake installation', async () => {
    render(BotMarketplace);
    await waitFor(() => expect(document.body.textContent).toContain('Safe Bot'));
    expect(loadCatalogMock).toHaveBeenCalledTimes(1);
    expect(fetchPluginsMock).toHaveBeenCalledTimes(1);
    expect(injectStylesMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.mp-card-tags img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=1>');
    const install = screen.getAllByRole('button', { name: t('market_install_unavailable') })[0]!;
    expect(install).toBeDisabled();
  });

  it('filters by search/category, exposes plugin tab, opens detail, and uses Escape ownership', async () => {
    const onClose = vi.fn();
    render(BotMarketplace, { props: { onClose, initialTab: 'all' } });
    await waitFor(() => expect(document.body.textContent).toContain('Music Bot'));

    await fireEvent.input(document.querySelector<HTMLInputElement>('#mp-search')!, { target: { value: 'helper' } });
    await waitFor(() => expect(document.body.textContent).not.toContain('Music Bot'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('#mp-search')!, { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: new RegExp(t('bot_cat_music')) }));
    await waitFor(() => expect(document.body.textContent).toContain('Music Bot'));
    expect(document.body.textContent).not.toContain('Safe Bot');

    await fireEvent.click(screen.getByRole('tab', { name: new RegExp(t('ui_plugins')) }));
    await waitFor(() => expect(document.body.textContent).toContain('Loaded Plugin'));
    await fireEvent.click(screen.getByRole('tab', { name: t('ui_tum_botlar') }));
    await fireEvent.click(screen.getByRole('button', { name: new RegExp(t('bot_cat_all')) }));
    await waitFor(() => expect(document.body.textContent).toContain('Safe Bot'));
    await fireEvent.click(screen.getAllByRole('button', { name: t('markup_detaylar_2638108') })[0]!);
    await waitFor(() => expect(document.body.textContent).toContain('long safe'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => expect(document.body.textContent).not.toContain('long safe'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
