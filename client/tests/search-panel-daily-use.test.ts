// client/tests/search-panel-daily-use.test.ts
//
// SUNUCU İÇİ ARAMA — GÜNLÜK KULLANIM (P3).
//
// Eski kodda başarısız olan davranışlar:
//   · BAYAT YANIT — istekler sıra numarası taşımıyordu: "ab" yanıtı "abc"den
//     SONRA gelirse "abc" sorgusunun altında "ab" sonuçları kalıyordu.
//   · YAPI — sonuçlar `role="listbox"` içinde `role="option"
//     aria-selected="false"` düğmelerdi; ne seçim ne ok tuşları vardı.
//   · KLAVYE — aramadan sonuçlara ve sonuçlar arasında ok tuşlarıyla
//     geçilemiyordu.

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

afterEach(() => { cleanup(); for (const k of Object.keys(registryMap)) delete registryMap[k]; vi.useRealTimers(); });

type Pending = { q: string; resolve: (messages: unknown[]) => void };

function message(id: string, content: string): Record<string, unknown> {
  return { _id: id, content, channelId: 'c1', channelName: 'genel', username: 'ayse', displayName: 'Ayşe', createdAt: 1 };
}

/** apiFetch'i elle çözülen isteklere bağlar: yanıtların SIRASINI test belirler. */
function controlledFetch(): Pending[] {
  const pending: Pending[] = [];
  registryMap.apiFetch = vi.fn((url: string) => new Promise(resolve => {
    const q = new URL(url, 'http://x').searchParams.get('q') ?? '';
    pending.push({
      q,
      resolve: (messages: unknown[]) => resolve({ ok: true, status: 200, json: async () => ({ messages, hasMore: false }) }),
    });
  }));
  return pending;
}

async function openPanel(): Promise<{ container: HTMLElement; input: HTMLInputElement }> {
  const { container } = render(SearchPanel);
  (registryMap.openSearch as (sid: string) => void)('s1');
  const input = await waitFor(() => {
    const el = container.querySelector<HTMLInputElement>('.search-input');
    if (!el) throw new Error('panel not open');
    return el;
  });
  return { container, input };
}

const contents = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.result-content')].map(n => n.textContent ?? '');

describe('SearchPanel — bayat yanıt', () => {
  it('eski sorgunun GEÇ gelen yanıtı yeni sorgunun sonuçlarını ezmez', async () => {
    const pending = controlledFetch();
    const { container, input } = await openPanel();

    await fireEvent.input(input, { target: { value: 'ab' } });
    await waitFor(() => expect(pending.map(p => p.q)).toEqual(['ab']), { timeout: 2000 });
    await fireEvent.input(input, { target: { value: 'abc' } });
    await waitFor(() => expect(pending.map(p => p.q)).toEqual(['ab', 'abc']), { timeout: 2000 });

    pending[1]!.resolve([message('m-abc', 'abc sonucu')]);
    await waitFor(() => expect(contents(container)).toEqual(['abc sonucu']));
    pending[0]!.resolve([message('m-ab', 'ab sonucu')]);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(contents(container)).toEqual(['abc sonucu']);
    expect(input.value).toBe('abc');
  });

  it('temizlenen paneli uçuştaki yanıt yeniden doldurmaz', async () => {
    const pending = controlledFetch();
    const { container, input } = await openPanel();

    await fireEvent.input(input, { target: { value: 'kelime' } });
    await waitFor(() => expect(pending).toHaveLength(1), { timeout: 2000 });
    await fireEvent.input(input, { target: { value: 'k' } });
    pending[0]!.resolve([message('m1', 'kelime sonucu')]);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(contents(container)).toEqual([]);
  });
});

describe('SearchPanel — yapı ve klavye', () => {
  async function withResults(): Promise<{ container: HTMLElement; input: HTMLInputElement; buttons: HTMLButtonElement[] }> {
    const pending = controlledFetch();
    const { container, input } = await openPanel();
    await fireEvent.input(input, { target: { value: 'kelime' } });
    await waitFor(() => expect(pending).toHaveLength(1), { timeout: 2000 });
    pending[0]!.resolve([message('m1', 'bir'), message('m2', 'iki'), message('m3', 'üç')]);
    const buttons = await waitFor(() => {
      const found = [...container.querySelectorAll<HTMLButtonElement>('.search-result-item')];
      if (found.length !== 3) throw new Error('results not rendered');
      return found;
    });
    return { container, input, buttons };
  }

  it('sonuçlar düğmelerden oluşan bir listedir; sahte listbox/option rolleri yoktur', async () => {
    const { container, buttons } = await withResults();

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[role="option"]')).toBeNull();
    const list = container.querySelector('ul.search-result-list');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll(':scope > li > button.search-result-item')).toHaveLength(3);
    for (const button of buttons) expect(button.getAttribute('type')).toBe('button');
  });

  it('↓ aramadan ilk sonuca, sonuçlar arasında ↓/↑, Home/End; ilk sonuçta ↑ aramaya döner', async () => {
    const { input, buttons } = await withResults();
    input.focus();

    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[0]);
    await fireEvent.keyDown(buttons[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    await fireEvent.keyDown(buttons[1]!, { key: 'End' });
    expect(document.activeElement).toBe(buttons[2]);
    await fireEvent.keyDown(buttons[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[2]);
    await fireEvent.keyDown(buttons[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
    await fireEvent.keyDown(buttons[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);
  });

  it('Enter odaktaki sonuca gider (düğme davranışı)', async () => {
    const navigate = vi.fn();
    registryMap.navigateToChannel = navigate;
    const { input, buttons } = await withResults();
    input.focus();
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(buttons[0]!, { key: 'ArrowDown' });

    (document.activeElement as HTMLButtonElement).click();

    expect(navigate).toHaveBeenCalledWith('c1', 'm2');
  });
});
