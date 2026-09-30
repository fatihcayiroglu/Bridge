import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('../js/core/utils.js', () => ({ toast: toastMock }));
// KANONİK SÖZLÜĞE DEVRET (reaktif sarmalayıcı yalnızca Svelte reaktifliği
// ekler; metin sahibi `i18n/index.ts`tir). Elle yazılmış çiftler yedek metni
// olmayan anahtarlarda ham anahtar döndürüyor ve `vars` yerleştirmesini
// düşürüyordu.
vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});
import GeneralTab from '../js/core/server-settings/tabs/GeneralTab.svelte';

function makeStore(overrides: Record<string, unknown> = {}) {
  const store: any = {
    serverId: 's1', server: { _id: 's1', name: 'Bridge', icon: '🌉' }, activeTab: 'general',
    error: null, name: 'Bridge', icon: '🌉', slug: '', slugPreview: '', slugSaving: false,
    discoverable: false, category: 'other', discoverySaving: false, bannerUrl: '', iconUrl: '', saving: false,
    setTab: vi.fn(), setError: vi.fn(),
    setName: vi.fn((value: string) => { store.name = value; }),
    setIcon: vi.fn((value: string) => { store.icon = value; }),
    setSlug: vi.fn((value: string) => { store.slug = value; }),
    setDiscoverable: vi.fn((value: boolean) => { store.discoverable = value; }),
    setCategory: vi.fn((value: string) => { store.category = value; }),
    setBannerUrl: vi.fn(), setIconUrl: vi.fn(), saveGeneral: vi.fn().mockResolvedValue(true),
    saveSlug: vi.fn().mockResolvedValue(true), saveDiscovery: vi.fn().mockResolvedValue(true),
    isDirty: vi.fn(() => false), isSlugDirty: vi.fn(() => false), isDiscoveryDirty: vi.fn(() => false),
    loadSlug: vi.fn(), reload: vi.fn(), subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
  return store;
}

beforeEach(() => { document.body.innerHTML = ''; toastMock.mockClear(); });
afterEach(() => cleanup());

describe('GeneralTab behavior', () => {
  it('binds edits to the canonical store and keeps save disabled while clean', async () => {
    const store = makeStore();
    render(GeneralTab, { props: { store } });
    const name = document.querySelector<HTMLInputElement>('#srv-name-input')!;
    const icon = document.querySelector<HTMLInputElement>('#srv-icon-input')!;
    expect(name.value).toBe('Bridge');
    expect(icon.value).toBe('🌉');
    expect(document.querySelector<HTMLButtonElement>('button.btn-primary')!.disabled).toBe(true);
    await fireEvent.input(name, { target: { value: 'Bridge Prod' } });
    await fireEvent.input(icon, { target: { value: '🚀' } });
    expect(store.setName).toHaveBeenCalledWith('Bridge Prod');
    expect(store.setIcon).toHaveBeenCalledWith('🚀');
  });

  it('saves through store, reports success and calls onSaved only after success', async () => {
    const onSaved = vi.fn();
    const store = makeStore({ isDirty: () => true });
    render(GeneralTab, { props: { store, onSaved } });
    await fireEvent.click(document.querySelector<HTMLButtonElement>('button.btn-primary')!);
    await waitFor(() => expect(store.saveGeneral).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith('Sunucu ayarları kaydedildi', 'success');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('never emits a success toast/callback when persistence fails and exposes server error', async () => {
    const onSaved = vi.fn();
    const store = makeStore({ error: 'Forbidden', isDirty: () => true, saveGeneral: vi.fn().mockResolvedValue(false) });
    render(GeneralTab, { props: { store, onSaved } });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Forbidden');
    await fireEvent.click(document.querySelector<HTMLButtonElement>('button.btn-primary')!);
    await waitFor(() => expect(store.saveGeneral).toHaveBeenCalledTimes(1));
    expect(toastMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('names the public profile slug field for assistive technology', () => {
    render(GeneralTab, { props: { store: makeStore() } });
    const input = document.querySelector<HTMLInputElement>('#srv-slug-input')!;
    // A fieldset legend names the group, not the field inside it.
    const labelledBy = input.getAttribute('aria-labelledby') ?? '';
    const name = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
    expect(name).toBe('Herkese Açık Profil Adresi');
  });

  it('persists the public profile slug through the dedicated store action', async () => {
    const store = makeStore({ slug: 'bridge-old', isSlugDirty: () => true });
    render(GeneralTab, { props: { store } });
    const input = document.querySelector<HTMLInputElement>('#srv-slug-input')!;
    await fireEvent.input(input, { target: { value: 'bridge-new' } });
    expect(store.setSlug).toHaveBeenCalledWith('bridge-new');
    const section = input.closest('fieldset')!;
    await fireEvent.click(section.querySelector<HTMLButtonElement>('button')!);
    await waitFor(() => expect(store.saveSlug).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith('Profil adresi kaydedildi', 'success');
  });

  it('exposes private/discoverable and category settings with real persistence', async () => {
    const store = makeStore({ isDiscoveryDirty: () => true });
    render(GeneralTab, { props: { store } });
    const toggle = document.querySelector<HTMLInputElement>('#srv-discoverable-input')!;
    const category = document.querySelector<HTMLSelectElement>('#srv-category-input')!;
    await fireEvent.click(toggle);
    await fireEvent.change(category, { target: { value: 'education' } });
    expect(store.setDiscoverable).toHaveBeenCalledWith(true);
    expect(store.setCategory).toHaveBeenCalledWith('education');
    const section = category.closest('fieldset')!;
    await fireEvent.click(section.querySelector<HTMLButtonElement>('button')!);
    await waitFor(() => expect(store.saveDiscovery).toHaveBeenCalledTimes(1));
  });

  it('disables save while a request is in flight and renders progress copy', () => {
    const store = makeStore({ saving: true, isDirty: () => true });
    render(GeneralTab, { props: { store } });
    const button = document.querySelector<HTMLButtonElement>('button.btn-primary')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Kaydediliyor');
  });
});
