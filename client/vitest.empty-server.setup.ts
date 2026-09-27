import '@testing-library/jest-dom';

// The isolated suite asserts the Turkish product copy. Set the locale before
// Svelte/i18n modules are imported; changing it in beforeEach is too late
// because the translation owner resolves its initial locale at module load.
document.documentElement.lang = 'tr';
Object.defineProperty(navigator, 'language', {
  configurable: true,
  value: 'tr-TR',
});

const values = new Map<string, string>();
values.set('bridge_locale', 'tr');

const storage: Storage = {
  get length() { return values.size; },
  clear() { values.clear(); },
  getItem(key: string) { return values.get(String(key)) ?? null; },
  key(index: number) { return Array.from(values.keys())[index] ?? null; },
  removeItem(key: string) { values.delete(String(key)); },
  setItem(key: string, value: string) { values.set(String(key), String(value)); },
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: storage,
});
