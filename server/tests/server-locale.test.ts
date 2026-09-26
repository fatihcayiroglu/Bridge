// server/tests/server-locale.test.ts — Final21 Phase 16.
//
// Everything the SERVER writes to a person (push titles) was Turkish for every reader, because
// nothing recorded which language they read. `users.locale` (migration 075) plus this catalog
// fix that. The catalog is small on purpose: only strings the server actually sends.

import fs from 'fs';
import path from 'path';
import {
  DEFAULT_SERVER_LOCALE, SERVER_LOCALES, __CATALOGS_FOR_TEST,
  normalizeServerLocale, serverText, userLocale,
} from '../lib/serverLocale';

describe('server locale catalog', () => {
  it('covers exactly the locales the client ships', () => {
    const clientIndex = fs.readFileSync(
      path.resolve(__dirname, '../../client/js/core/i18n/index.ts'), 'utf8',
    );
    const declared = clientIndex.match(/export type Locale =([^;]+);/)![1];
    const clientLocales = [...declared.matchAll(/'([a-z]{2})'/g)].map((m) => m[1]).sort();
    expect([...SERVER_LOCALES].sort()).toEqual(clientLocales);
  });

  it('every locale carries every key, with the same placeholders', () => {
    const keys = Object.keys(__CATALOGS_FOR_TEST[DEFAULT_SERVER_LOCALE]);
    for (const locale of SERVER_LOCALES) {
      const catalog = __CATALOGS_FOR_TEST[locale];
      expect(Object.keys(catalog).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
        expect(placeholders(catalog[key as keyof typeof catalog]))
          .toEqual(placeholders(__CATALOGS_FOR_TEST[DEFAULT_SERVER_LOCALE][key as keyof typeof catalog]));
      }
    }
  });

  it('writes the mention title in the reader\'s language', () => {
    expect(serverText('de', 'push_mention_title', { name: 'Ayşe' })).toBe('Ayşe hat dich erwähnt');
    expect(serverText('ja', 'push_mention_title', { name: 'Ayşe' })).toBe('Ayşe があなたにメンションしました');
    expect(serverText('tr', 'push_mention_title', { name: 'Ayşe' })).toBe('Ayşe seni mention etti');
  });

  it('fills every placeholder, including counts', () => {
    expect(serverText('en', 'push_many_mentions', { count: 3, channel: '#genel' }))
      .toBe('3 new mentions — #genel');
  });

  it('is callable with no variables at all — placeholders stay visible', () => {
    expect(serverText('en', 'push_mention_title')).toBe('{name} mentioned you');
  });
  it('an unknown placeholder is left visible rather than silently emptied', () => {
    expect(serverText('en', 'push_mention_title', {})).toBe('{name} mentioned you');
  });

  it.each([
    ['de-DE', 'de'], ['DE', 'de'], ['pt_BR', 'pt'], ['en-GB', 'en'],
    ['', DEFAULT_SERVER_LOCALE], ['klingon', DEFAULT_SERVER_LOCALE],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeServerLocale(input)).toBe(expected);
  });

  it.each([null, undefined, 42, {}, []])('non-strings fall back to the default: %p', (value) => {
    expect(normalizeServerLocale(value)).toBe(DEFAULT_SERVER_LOCALE);
  });
});

describe('userLocale is fail-soft — wording must never break delivery', () => {
  const load = () => require('../lib/serverLocale') as typeof import('../lib/serverLocale');

  afterEach(() => { jest.resetModules(); });

  it('returns the stored locale', async () => {
    jest.resetModules();
    jest.doMock('../db/repositories', () => ({ Users: { findById: async () => ({ locale: 'fr' }) } }));
    await expect(load().userLocale('u1')).resolves.toBe('fr');
  });

  it('falls back when the person has no locale yet', async () => {
    jest.resetModules();
    jest.doMock('../db/repositories', () => ({ Users: { findById: async () => ({}) } }));
    await expect(load().userLocale('u1')).resolves.toBe(DEFAULT_SERVER_LOCALE);
  });

  it('falls back when the lookup throws', async () => {
    jest.resetModules();
    jest.doMock('../db/repositories', () => ({ Users: { findById: async () => { throw new Error('db down'); } } }));
    await expect(load().userLocale('u1')).resolves.toBe(DEFAULT_SERVER_LOCALE);
  });

  it('falls back when the repository surface has no findById at all', async () => {
    jest.resetModules();
    jest.doMock('../db/repositories', () => ({ Users: {} }));
    await expect(load().userLocale('u1')).resolves.toBe(DEFAULT_SERVER_LOCALE);
  });
});
