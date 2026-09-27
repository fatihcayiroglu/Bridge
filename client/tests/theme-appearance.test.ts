import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { flushSync, mount, unmount } from 'svelte';
import AppearanceTab from '../js/core/settings/tabs/AppearanceTab.svelte';
import ThemeManager from '../js/core/ThemeManager.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { THEMES, THEME_STORAGE_KEY, type ThemeId } from '../js/core/theme-store.ts';
import { locale, setLocale, SUPPORTED_LOCALES } from '../js/core/i18n/index.ts';
import { __resetLayoutPrefsForTests, getLayoutMode } from '../js/core/layout-prefs.ts';

let appearanceInstance: ReturnType<typeof mount> | null = null;
let managerInstance: ReturnType<typeof mount> | null = null;
let appearanceHost: HTMLDivElement;
let managerHost: HTMLDivElement;

function themeButton(theme: ThemeId): HTMLButtonElement {
  return [...appearanceHost.querySelectorAll<HTMLButtonElement>('.theme-btn')][THEMES.indexOf(theme)]!;
}

beforeEach(async () => {
  localStorage.clear();
  await setLocale('tr');
  __resetLayoutPrefsForTests();
  document.documentElement.setAttribute('data-theme', 'dark');
  document.body.setAttribute('data-theme', 'dark');
  document.body.classList.remove('theme-light');

  managerHost = document.createElement('div');
  managerHost.innerHTML = '<button id="btn-theme" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h16"/></svg></button>';
  appearanceHost = document.createElement('div');
  document.body.append(managerHost, appearanceHost);

  managerInstance = mount(ThemeManager, { target: managerHost });
  appearanceInstance = mount(AppearanceTab, {
    target: appearanceHost,
    props: { store: {} as never },
  });
  flushSync();
});

afterEach(async () => {
  if (appearanceInstance) unmount(appearanceInstance);
  if (managerInstance) unmount(managerInstance);
  appearanceInstance = null;
  managerInstance = null;
  appearanceHost.remove();
  managerHost.remove();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  document.body.removeAttribute('data-theme');
  document.body.classList.remove('theme-light');
  await setLocale('tr');
  __resetLayoutPrefsForTests();
});

describe('appearance theme contract', () => {
  it('canonical beş temayı theme-store sırasıyla sunar', () => {
    const labels = [...appearanceHost.querySelectorAll<HTMLButtonElement>('.theme-btn')]
      .map(button => button.textContent?.trim());

    expect(labels).toEqual(['Koyu', 'Açık', 'AMOLED', 'Aurora', 'Gece Yarısı']);
  });

  it('seçimi setTheme sözleşmesiyle html, body ve bridge:theme:v1 anahtarına uygular', () => {
    themeButton('midnight').click();
    flushSync();

    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(document.body.getAttribute('data-theme')).toBe('midnight');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('midnight');
    expect(themeButton('midnight').getAttribute('aria-pressed')).toBe('true');
  });

  it('registry kaynaklı tema değişikliklerini paralel yerel durum oluşturmadan yansıtır', () => {
    BridgeRegistry.call('setTheme', 'light');
    flushSync();

    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.body.classList.contains('theme-light')).toBe(true);
    expect(themeButton('light').getAttribute('aria-pressed')).toBe('true');
    expect(themeButton('dark').getAttribute('aria-pressed')).toBe('false');
  });

  it('shell theme control keeps its stable SVG while state and labels synchronize', () => {
    const shellButton = managerHost.querySelector<HTMLButtonElement>('#btn-theme')!;
    const icon = shellButton.querySelector('svg');

    BridgeRegistry.call('setTheme', 'aurora');
    flushSync();

    expect(shellButton.querySelector('svg')).toBe(icon);
    expect(shellButton.dataset.theme).toBe('aurora');
    expect(shellButton.getAttribute('aria-label')).toMatch(/Tema: Aurora/);
  });

  it('ignores malformed theme events instead of desynchronizing the selected control', () => {
    const selected = themeButton('dark');
    document.dispatchEvent(new CustomEvent('bridge:theme-changed', { detail: { theme: 'not-a-theme' } }));
    flushSync();

    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(themeButton('light').getAttribute('aria-pressed')).toBe('false');
  });

  it('offers every supported locale, persists a real locale change, and ignores a same-locale change', async () => {
    const select = appearanceHost.querySelector<HTMLSelectElement>('#locale-select')!;
    expect([...select.options].map(option => option.value)).toEqual(Object.keys(SUPPORTED_LOCALES));

    select.value = locale.current;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(select).not.toBeDisabled();

    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('lang', 'en'));
    expect(localStorage.getItem('bridge_locale')).toBe('en');
    expect(select.value).toBe('en');
    await waitFor(() => expect(select).not.toBeDisabled());
  });

  it('applies each canonical layout through the layout preference owner', () => {
    // Yogunluk grubu da `.layout-btn` kullanir; secici DUZEN grubuna
    // kapsanmazsa iki grubun butonlari birbirine karisiyordu.
    const buttons = [...appearanceHost.querySelectorAll<HTMLButtonElement>(
      '.layout-group:not(.density-group) .layout-btn')];
    expect(buttons.map(button => button.querySelector('.layout-label')?.textContent)).toEqual([
      'Klasik', 'Odak', 'Kompakt',
    ]);

    buttons[0].click();
    flushSync();
    expect(getLayoutMode()).toBe('classic');
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');

    buttons[1].click();
    flushSync();
    expect(getLayoutMode()).toBe('focus');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'true');

    buttons[2].click();
    flushSync();
    expect(getLayoutMode()).toBe('compact');
    expect(buttons[2]).toHaveAttribute('aria-pressed', 'true');
  });
});
