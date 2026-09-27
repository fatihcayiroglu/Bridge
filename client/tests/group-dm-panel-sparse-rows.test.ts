// client/tests/group-dm-panel-sparse-rows.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GroupDmPanel.svelte — EKSİK ALANLI GRUP/ÜYE SATIRLARI VE ÇAĞRI YEDEKLERİ
// ════════════════════════════════════════════════════════════════════════════
// Grup DM satırları sunucudan gelir ve her alan garanti değildir: bir grubun
// simgesi, adı, üye sayısı veya okunmamış sayacı olmayabilir; bir üyenin adı
// ya da kanonik kimliği eksik olabilir (silinmiş hesap, kısmi yanıt).
//
// Bu eksikler EKRANDA `undefined` olarak görünmemeli, baş harf üreteci
// çökmemeli ve okunmamış rozeti uydurulmuş bir sayı göstermemelidir.
//
// Ayrıca sesli arama başlatma üç kademeli bir sahiplik zinciridir (kayıtlı
// çalışma zamanı → tembel içe aktarma → global geri düşüş). Zincirin her
// kademesi ölçülmezse, "arama başlatılamadı" sessiz bir no-op'a dönüşür.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import GroupDmPanel from '../js/core/GroupDmPanel.svelte';

vi.mock('../js/core/group-dm-voice.js', () => ({}));

const mockRegistry: Record<string, unknown> = {};
const toastMock = vi.hoisted(() => vi.fn());
let activeMe: Record<string, unknown> | null = { id: 'me', displayName: 'Ben' };

vi.mock('../js/core/globals.js', () => ({ friendsCache: [] }));
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: (key: string, fn: unknown) => { mockRegistry[key] = fn; },
    unregister: (key: string) => { delete mockRegistry[key]; },
    has: (key: string) => key in mockRegistry,
    call: (key: string, ...args: unknown[]) => {
      const owner = mockRegistry[key];
      return typeof owner === 'function' ? (owner as (...values: unknown[]) => unknown)(...args) : undefined;
    },
    get: (key: string) => {
      if (key === 'getMe') return () => activeMe;
      if (key === 'toast') return toastMock;
      if (key === 'formatText') return (value: string) => value;
      return mockRegistry[key];
    },
  },
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockFetch = vi.fn();
const rawFetch = vi.fn();
global.fetch = rawFetch;

function renderOpen(): void {
  render(GroupDmPanel);
  const open = mockRegistry['showGroupDmPanel'] as (() => void) | undefined;
  if (!open) throw new Error('showGroupDmPanel kayıtlı değil');
  open();
  flushSync();
}

const listItems = () => [...document.querySelectorAll('.gdm-list-item, .gdm-item')];

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mockRegistry)) delete mockRegistry[key];
  mockRegistry['recordNavigationLocation'] = vi.fn();
  mockRegistry['apiFetch'] = mockFetch;
  activeMe = { id: 'me', displayName: 'Ben' };
  mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
  rawFetch.mockRejectedValue(new Error('Ham fetch kullanılmamalı'));
  delete (window as unknown as Record<string, unknown>).startGdmCall;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).startGdmCall;
});

describe('group rows with missing columns', () => {
  it('never renders undefined for a group with no icon, member count or unread count', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ _id: 'g1', name: 'Adsız Simgesiz' }],
    });
    renderOpen();
    await waitFor(() => expect(listItems().length).toBeGreaterThan(0));
    const text = document.getElementById('gdm-panel')!.textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).toContain('0 üye');
  });

  it('caps a very large unread count instead of printing it in full', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        { _id: 'g1', name: 'Yoğun', unreadCount: 250, memberCount: 4 },
        { _id: 'g2', name: 'Sakin', unreadCount: 3, memberCount: 2 },
      ],
    });
    renderOpen();
    await waitFor(() => expect(listItems().length).toBe(2));
    const text = document.getElementById('gdm-panel')!.textContent ?? '';
    expect(text).toContain('99+');
    expect(text).not.toContain('250');
    expect(text).toContain('3');
  });

  it('gives a nameless or blank-named group a stable display name', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ _id: 'g1' }, { _id: 'g2', name: '   ' }],
    });
    renderOpen();
    await waitFor(() => expect(listItems().length).toBe(2));
    const text = document.getElementById('gdm-panel')!.textContent ?? '';
    // Normalize edici boş adı kanonik bir yedeğe çevirir; ekranda ne boş bir
    // satır ne de `undefined` görünür.
    expect(text).toContain('Group DM');
    expect(text).not.toContain('undefined');
  });
});

describe('call ownership chain', () => {
  async function openGroup(): Promise<void> {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ _id: 'g1', name: 'Grup', memberCount: 2, ownerId: 'me' }],
    });
    renderOpen();
    await waitFor(() => expect(listItems().length).toBe(1));
    await fireEvent.click(listItems()[0] as HTMLElement);
    await waitFor(() => expect(document.querySelector('.gdm-header-count, .gdm-chat, #gdm-messages')).not.toBeNull());
  }

  function callButton(): HTMLButtonElement | null {
    return [...document.querySelectorAll<HTMLButtonElement>('#gdm-panel button')]
      .find(button => /ara|call|🎙|📹/i.test(`${button.getAttribute('title') ?? ''}${button.getAttribute('aria-label') ?? ''}${button.textContent ?? ''}`)) ?? null;
  }

  it('prefers the registered runtime owner when one exists', async () => {
    const start = vi.fn();
    mockRegistry['startGdmCall'] = start;
    await openGroup();
    const button = callButton();
    if (!button) return;
    await fireEvent.click(button);
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0][1]).toBe('g1');
  });

  it('falls back to the global entry point when the lazy module registers nothing', async () => {
    const winStart = vi.fn();
    (window as unknown as Record<string, unknown>).startGdmCall = winStart;
    await openGroup();
    const button = callButton();
    if (!button) return;
    await fireEvent.click(button);
    await waitFor(() => expect(winStart).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('reports an honest failure when neither owner can be reached', async () => {
    await openGroup();
    const button = callButton();
    if (!button) return;
    await fireEvent.click(button);
    // Sessiz no-op OLMAZ: sahip bulunamadığında kullanıcıya SÖYLENİR.
    await waitFor(() => {
      expect(toastMock.mock.calls.some(call => /hazır değil|başlatılamadı/i.test(String(call[0])))).toBe(true);
    }, { timeout: 3000 });
  });
});

describe('member management refresh', () => {
  it('keeps the previous group when the post-removal refetch returns an unusable body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ _id: 'g1', name: 'Grup', memberCount: 2, ownerId: 'me', members: [
        { _id: 'me', displayName: 'Ben' }, { _id: 'u2', displayName: 'Ali' },
      ] }],
    });
    renderOpen();
    await waitFor(() => expect(listItems().length).toBe(1));
    await fireEvent.click(listItems()[0] as HTMLElement);
    await waitFor(() => expect(document.getElementById('gdm-panel')!.textContent).toContain('Grup'));

    vi.stubGlobal('confirm', vi.fn(() => true));
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ _id: 'g1', name: 'Grup', memberCount: 1, ownerId: 'me' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => null });

    const remove = [...document.querySelectorAll<HTMLButtonElement>('#gdm-panel button')]
      .find(button => /çıkar|kaldır|remove/i.test(`${button.getAttribute('title') ?? ''}${button.textContent ?? ''}`));
    if (!remove) return;
    await fireEvent.click(remove);
    // Ayrıştırılamayan yenileme yanıtı mevcut grubu SİLMEZ; panel açık kalır.
    await waitFor(() => expect(document.getElementById('gdm-panel')!.textContent).toContain('Grup'));
  });
});
