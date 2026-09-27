import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  applyTheme,
  currentTheme,
  getAvailableThemes,
  isTheme,
  nextTheme,
  readStoredTheme,
  resolveInitialTheme,
  systemTheme,
  writeStoredTheme,
} from '../js/core/theme-store.ts';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  document.body.removeAttribute('data-theme');
  document.body.classList.remove('theme-light');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('theme-store persistence and fallback behavior', () => {
  it('validates only canonical themes and cycles deterministically', () => {
    expect(getAvailableThemes()).toBe(THEMES);
    for (const theme of THEMES) expect(isTheme(theme)).toBe(true);
    for (const invalid of [null, 7, '', 'sunset', 'DARK']) expect(isTheme(invalid)).toBe(false);
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('midnight')).toBe('dark');
  });

  it('reads current storage, migrates a valid legacy preference and removes corrupt current values', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'aurora');
    expect(readStoredTheme()).toBe('aurora');

    localStorage.clear();
    localStorage.setItem('bridge_theme', 'light');
    expect(readStoredTheme()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem('bridge_theme')).toBeNull();

    localStorage.setItem(THEME_STORAGE_KEY, 'removed-theme');
    expect(readStoredTheme()).toBeNull();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('contains storage failures while still allowing the in-memory/DOM theme path to operate', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readStoredTheme()).toBeNull();
    get.mockRestore();

    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => writeStoredTheme('dark')).not.toThrow();
    set.mockRestore();
  });

  it('derives the system preference safely and gives an explicit stored preference priority', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    expect(systemTheme()).toBe('light');
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight');
    expect(resolveInitialTheme()).toBe('midnight');

    localStorage.clear();
    expect(resolveInitialTheme()).toBe('light');
    vi.stubGlobal('matchMedia', vi.fn(() => { throw new Error('unsupported'); }));
    expect(systemTheme()).toBe(DEFAULT_THEME);
  });

  it('applies canonical DOM state and reads only a valid live theme', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
    expect(document.body.classList.contains('theme-light')).toBe(true);
    expect(currentTheme()).toBe('light');

    applyTheme('amoled');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.body.classList.contains('theme-light')).toBe(false);
    expect(currentTheme()).toBe('amoled');

    document.documentElement.setAttribute('data-theme', 'corrupt');
    document.body.setAttribute('data-theme', 'light');
    // html is the canonical live owner when present; corrupt values fail closed.
    expect(currentTheme()).toBe(DEFAULT_THEME);
    document.documentElement.removeAttribute('data-theme');
    expect(currentTheme()).toBe('light');
  });
});
