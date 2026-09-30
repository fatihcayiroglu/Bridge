// client/tests/group-dm-history-paging.test.ts
//
// GRUP DM — GÜNLÜK KULLANIM (P3).
//
// Eski kodda başarısız olan davranışlar:
//   · ESKİ GEÇMİŞ — istemci yalnız son 50 mesajı istiyordu; sunucunun
//     `before` + `beforeId` imleci (Faz 10.6B) hiç kullanılmıyordu.
//   · OKUMA YERİ — geçmişi okurken başkasından gelen mesaj listeyi en alta
//     atıyordu.
//   · YAN LİSTE — açık olmayan gruba gelen mesaj okunmamış rozetini panel
//     yeniden açılana kadar güncellemiyordu.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountGroupDmPanel, unmountGroupDmPanel } from '../js/core/group-dm-svelte.ts';

type Handler = (payload: unknown) => void;

const ok = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;
let groups: Array<Record<string, unknown>>;
let pages: Map<string, unknown>;
let handlers: Map<string, Handler[]>;

const ROW = 40;
const VIEWPORT = 400;
const scrollHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
const clientHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');

function history(n: number, newest: number, prefix = 'm'): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const at = newest - (n - 1 - i) * 1000;
    return { _id: `${prefix}-${at}`, groupId: 'gdm-A', userId: 'u2', displayName: 'Ada', content: `mesaj ${at}`, createdAt: at };
  });
}

function fire(event: string, payload: unknown): void {
  for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
}

const area = (): HTMLElement => document.getElementById('gdm-messages')!;
const rowIds = (): string[] => [...document.querySelectorAll<HTMLElement>('#gdm-messages .dm-msg')].map(n => n.dataset.id ?? '');
const olderButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.gdm-load-older');
const historyCalls = (): string[] => fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.includes('/gdm-A/messages'));
const listCalls = (): number => fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.endsWith('/api/gdm')).length;

async function openGroup(): Promise<void> {
  const root = document.createElement('div');
  root.id = 'gdm-root';
  document.body.appendChild(root);
  mountGroupDmPanel();
  flushSync();
  (BridgeRegistry.get('showGroupDmPanel') as () => void)();
  flushSync();
  await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('.gdm-item')).toHaveLength(groups.length); });
  const open = BridgeRegistry.get('groupDmPanel:openGroupDm') as (g: unknown) => Promise<boolean>;
  expect(await open(groups[0])).toBe(true);
  flushSync();
  await new Promise(resolve => setTimeout(resolve, 5));
  flushSync();
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).API = 'http://test';
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) { return this.id === 'gdm-messages' ? this.querySelectorAll('.dm-msg').length * ROW : 0; },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) { return this.id === 'gdm-messages' ? VIEWPORT : 0; },
  });
  groups = [
    { _id: 'gdm-A', name: 'Grup A', ownerId: 'u1', icon: '👥', memberCount: 2, unreadCount: 0 },
    { _id: 'gdm-B', name: 'Grup B', ownerId: 'u1', icon: '🎮', memberCount: 2, unreadCount: 0 },
  ];
  pages = new Map();
  handlers = new Map();
  fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/gdm-A/messages')) {
      const before = new URL(u).searchParams.get('before') ?? '';
      return ok(pages.get(before) ?? []);
    }
    if (u.endsWith('/api/gdm')) return ok(groups);
    return ok([]);
  });
  BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
  BridgeRegistry.register('getMe', () => ({ id: 'u1', displayName: 'Ben' }));
  BridgeRegistry.register('socket', {
    emit: vi.fn(),
    on: (e: string, fn: Handler) => { handlers.set(e, [...(handlers.get(e) ?? []), fn]); },
    off: (e: string, fn: Handler) => { handlers.set(e, (handlers.get(e) ?? []).filter(f => f !== fn)); },
  });
});

afterEach(() => {
  unmountGroupDmPanel();
  for (const k of ['apiFetch', 'getMe', 'socket', 'showGroupDmPanel', 'openGroupDmPanel', 'closeGroupDmPanel', 'toast']) {
    BridgeRegistry.unregister(k);
  }
  if (scrollHeightDesc) Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeightDesc);
  if (clientHeightDesc) Object.defineProperty(Element.prototype, 'clientHeight', clientHeightDesc);
  delete (window as unknown as Record<string, unknown>).API;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('grup DM — daha eski geçmiş', () => {
  it('tam bir sayfa geldiğinde bir önceki sayfa en eski mesajın bileşik imleciyle istenir', async () => {
    const first = history(50, 1_700_000_100_000);
    const oldest = first[0]!;
    const older = history(9, Number(oldest.createdAt) - 1000, 'o');
    pages.set('', first);
    pages.set(String(oldest.createdAt), older);
    await openGroup();

    expect(rowIds()).toHaveLength(50);
    expect(historyCalls()[0]).toContain('limit=50');
    expect(olderButton()).not.toBeNull();

    olderButton()!.click();
    await vi.waitFor(() => { flushSync(); expect(rowIds()).toHaveLength(59); });

    const params = new URL(historyCalls()[1]!).searchParams;
    expect(params.get('limit')).toBe('50');
    expect(params.get('before')).toBe(String(oldest.createdAt));
    expect(params.get('beforeId')).toBe(String(oldest._id));
    expect(rowIds().slice(0, 9)).toEqual(older.map(m => m._id));
    expect(rowIds().slice(9)).toEqual(first.map(m => m._id));
    expect(olderButton()).toBeNull();
  });

  it('50 mesajdan az geçmişte daha eski sayfa sunulmaz', async () => {
    pages.set('', history(4, 1_700_000_100_000));
    await openGroup();

    expect(rowIds()).toHaveLength(4);
    expect(olderButton()).toBeNull();
  });

  it('listenin üstüne kaydırmak bir önceki sayfayı yükler ve okuma yerini korur', async () => {
    const first = history(50, 1_700_000_100_000);
    const oldestAt = String(first[0]!.createdAt);
    pages.set('', first);
    pages.set(oldestAt, history(50, Number(oldestAt) - 1000, 'o'));
    await openGroup();

    area().scrollTop = 20;
    area().dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => { flushSync(); expect(rowIds()).toHaveLength(100); });

    expect(area().scrollTop).toBe(20 + 50 * ROW);
    expect(olderButton()).not.toBeNull();
  });
});

describe('grup DM — okuma yeri ve yan liste', () => {
  it('geçmişi okurken başkasından gelen mesaj okuma yerini değiştirmez', async () => {
    pages.set('', history(30, 1_700_000_100_000));
    await openGroup();
    area().scrollTop = 100;

    fire('gdm:message', { _id: 'in-1', groupId: 'gdm-A', userId: 'u2', displayName: 'Ada', content: 'yeni', createdAt: 1_700_000_200_000 });
    flushSync();
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(rowIds()).toContain('in-1');
    expect(area().scrollTop).toBe(100);
  });

  it('altta okurken gelen mesaj görünür alana kaydırılır', async () => {
    pages.set('', history(30, 1_700_000_100_000));
    await openGroup();
    expect(area().scrollTop).toBe(30 * ROW);

    fire('gdm:message', { _id: 'in-1', groupId: 'gdm-A', userId: 'u2', displayName: 'Ada', content: 'yeni', createdAt: 1_700_000_200_000 });
    flushSync();
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(area().scrollTop).toBe(31 * ROW);
  });

  it('açık olmayan gruba gelen mesaj okunmamış rozetini sunucudan tazeler', async () => {
    pages.set('', history(3, 1_700_000_100_000));
    await openGroup();
    const before = listCalls();
    expect(document.querySelector('.gdm-unread')).toBeNull();

    groups = groups.map(g => (g._id === 'gdm-B' ? { ...g, unreadCount: 3 } : g));
    fire('gdm:message', { _id: 'b-1', groupId: 'gdm-B', userId: 'u2', content: 'selam', createdAt: 1_700_000_200_000 });
    fire('gdm:message', { _id: 'b-1', groupId: 'gdm-B', userId: 'u2', content: 'selam', createdAt: 1_700_000_200_000 });

    await vi.waitFor(() => { flushSync(); expect(document.querySelector('.gdm-unread')?.textContent?.trim()).toBe('3'); });
    expect(listCalls()).toBe(before + 1);
    expect(rowIds()).toHaveLength(3);
  });
});
