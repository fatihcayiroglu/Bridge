// client/tests/search-panel-deleted-author.test.ts
//
// Final21 Faz 19 — hesabı silinen kişinin mesajı sunucu aramasında.
//
// Hesap silme artık mesajlardaki yazar anlık görüntüsünü boşaltır (`username` ve
// `displayName` boş dizge; sütunlar NOT NULL). Sunucu arama paneli yazarı
// `m.displayName ?? m.username ?? ''` ile seçiyordu: `??` boş dizgeyi GEÇİRİR ve satır
// yalnızca "@" gösteriyordu. Yerelleştirilmiş "Bilinmeyen" etiketi gösterilmeli; normal
// bir yazar için davranış değişmemeli.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const registryMap: Record<string, unknown> = {};
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (key: string, fn: unknown) => { registryMap[key] = fn; },
    unregister: (key: string) => { delete registryMap[key]; },
    has:        (key: string) => key in registryMap,
    get:        (key: string) => registryMap[key],
    call:       (key: string, ...args: unknown[]) => {
      const v = registryMap[key];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown)(...args) : v;
    },
  },
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/a11y/focusTrap.ts', () => ({ focusTrap: () => ({ destroy() {} }) }));

import SearchPanel from '../js/core/SearchPanel.svelte';
import { t } from '../js/core/i18n/reactive.svelte.ts';

afterEach(() => { cleanup(); for (const k of Object.keys(registryMap)) delete registryMap[k]; });

async function searchWith(messages: unknown[]): Promise<HTMLElement[]> {
  registryMap.apiFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages, hasMore: false }) }));
  const { container } = render(SearchPanel);
  (registryMap.openSearch as (sid: string) => void)('s1');
  const input = await waitFor(() => {
    const el = container.querySelector<HTMLInputElement>('.search-input');
    if (!el) throw new Error('panel not open');
    return el;
  });
  await fireEvent.input(input, { target: { value: 'kelime' } });
  return waitFor(() => {
    const authors = [...container.querySelectorAll<HTMLElement>('.result-author')];
    if (authors.length !== messages.length) throw new Error('results not rendered');
    return authors;
  }, { timeout: 2000 });
}

describe('SearchPanel — hesabı silinmiş yazar', () => {
  it('boş anlık görüntü "@" yerine yerelleştirilmiş Bilinmeyen etiketini gösterir', async () => {
    const [author] = await searchWith([{ _id: 'm1', content: 'kelime', channelId: 'c1', username: '', displayName: '', createdAt: 1 }]);
    expect(author.textContent).toBe(t('unknown_user'));
    expect(author.textContent).not.toBe('@');
  });

  it('KONTROL: normal yazar görünen adıyla, "@" önekiyle çizilir', async () => {
    const [named, userOnly] = await searchWith([
      { _id: 'm1', content: 'kelime', channelId: 'c1', username: 'ayse', displayName: 'Ayşe', createdAt: 1 },
      { _id: 'm2', content: 'kelime', channelId: 'c1', username: 'veli', displayName: '', createdAt: 2 },
    ]);
    expect(named.textContent).toBe('@Ayşe');
    expect(userOnly.textContent).toBe('@veli');
  });
});
