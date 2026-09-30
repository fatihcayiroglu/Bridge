// client/tests/dm-panel-daily-use.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DM PANELİ — GÜNLÜK KULLANIM (P3)
// ════════════════════════════════════════════════════════════════════════════
//
// P3 incelemesinde bire bir DM'de bulunan ve her biri eski kodda başarısız olan
// davranışlar:
//
//   · ENTER GÖNDERİR — kanal ve grup DM yazma alanlarında Enter gönderiyordu,
//     bire bir DM'de yalnız satır ekliyordu (Shift+Enter satır eklemeye devam
//     eder; IME birleştirmesi sırasındaki Enter göndermez).
//   · ESKİ GEÇMİŞ — istemci yalnız son 50 mesajı istiyordu; sunucunun
//     `before` + `beforeId` imleci hiç kullanılmıyordu, daha eski mesajlara
//     arayüzden ulaşılamıyordu.
//   · EN YENİ MESAJ — konuşma en eski yüklü mesajda (en üstte) açılıyor, gelen
//     ve gönderilen mesajlar görünür alana kaydırılmıyordu.
//   · YAN LİSTE — açık olmayan bir konuşmaya gelen mesaj okunmamış rozetini
//     panel yeniden açılana kadar güncellemiyordu.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import DmPanel from '../js/core/DmPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

type Handler = (payload: unknown) => void;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeSocket() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  return {
    sent,
    on(event: string, fn: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    off(event: string, fn: Handler) { handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== fn)); },
    emit(event: string, payload: unknown) { sent.push({ event, payload }); },
    fire(event: string, payload?: unknown) { for (const fn of [...(handlers.get(event) ?? [])]) fn(payload); },
  };
}

const OWNED = [
  'apiFetch', 'socket', 'getMe', 'recordNavigationLocation', 'toast', 'saveForLater',
  'showFriendsPanel', 'startDmCall', 'showDmPanel', 'openDmPanel', 'getDmConversations',
  'openDm', 'closeDmPanel',
];

/** Sunucu sırası: artan zaman. `n` mesaj, en yenisi `newest` ms. */
function history(n: number, newest: number, prefix = 'm'): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const at = newest - (n - 1 - i) * 1000;
    return { _id: `${prefix}-${at}`, dmId: 'dm-a', userId: 'user-a', displayName: 'Ada', content: `mesaj ${at}`, createdAt: at };
  });
}

let socket: ReturnType<typeof makeSocket>;
let apiFetch: ReturnType<typeof vi.fn>;
let conversations: Array<Record<string, unknown>>;
let pages: Map<string, unknown>;

// jsdom yerleşim hesaplamaz: mesaj listesinin yüksekliği satır sayısıyla
// orantılı modellenir (satır 40px, görünür alan 400px).
const ROW = 40;
const VIEWPORT = 400;
const scrollHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
const clientHeightDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) { await tick(); await Promise.resolve(); }
}

const list = (): HTMLDivElement => document.querySelector<HTMLDivElement>('.dm-messages')!;
const rowIds = (): string[] => [...document.querySelectorAll<HTMLElement>('.dm-message')].map(n => n.dataset.id ?? '');
const olderButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.dm-load-older');
const historyCalls = (): string[] => apiFetch.mock.calls.map(c => String(c[0])).filter(u => u.includes('/dm-a/messages'));
const listCalls = (): number => apiFetch.mock.calls.map(c => String(c[0])).filter(u => u.endsWith('/api/dm')).length;
const dmSends = () => socket.sent.filter(entry => entry.event === 'dm:send');

async function openConversation(): Promise<void> {
  render(DmPanel);
  await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(conversations.length));
  BridgeRegistry.call('openDm', 'user-a');
  await waitFor(() => expect(document.querySelector('.dm-composer textarea')).not.toBeNull());
  await flush();
}

function type(text: string): HTMLTextAreaElement {
  const box = document.querySelector<HTMLTextAreaElement>('.dm-composer textarea')!;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return box;
}

function press(box: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  box.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  if (!globalThis.CSS) Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });
  Object.defineProperty(globalThis.CSS, 'escape', { configurable: true, value: (value: string) => value });
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) { return this.classList.contains('dm-messages') ? this.querySelectorAll('.dm-message').length * ROW : 0; },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) { return this.classList.contains('dm-messages') ? VIEWPORT : 0; },
  });

  conversations = [
    { _id: 'row-a', dmId: 'dm-a', unreadCount: 0, other: { _id: 'user-a', displayName: 'Ada Lovelace' } },
    { _id: 'row-b', dmId: 'dm-b', unreadCount: 0, other: { _id: 'user-b', displayName: 'Grace Hopper' } },
  ];
  pages = new Map();
  apiFetch = vi.fn(async (urlValue: unknown) => {
    const url = String(urlValue);
    if (url.endsWith('/api/dm')) return json(conversations);
    if (url.includes('/dm-a/messages')) {
      const before = new URL(url, 'http://x').searchParams.get('before') ?? '';
      return json(pages.get(before) ?? []);
    }
    return json({});
  });
  socket = makeSocket();
  BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
  BridgeRegistry.register('getMe', () => ({ id: 'me', displayName: 'Ben', avatarColor: '#00ff00' }));
});

afterEach(() => {
  cleanup();
  for (const key of OWNED) BridgeRegistry.unregister(key);
  if (scrollHeightDesc) Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeightDesc);
  if (clientHeightDesc) Object.defineProperty(Element.prototype, 'clientHeight', clientHeightDesc);
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('yazma alanı klavyesi', () => {
  it('Enter mesajı gönderir ve yeni satır eklemez', async () => {
    await openConversation();
    const box = type('merhaba');
    await flush(2);

    const event = press(box, {});
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(dmSends()).toHaveLength(1);
    expect(dmSends()[0]!.payload).toMatchObject({ toUserId: 'user-a', content: 'merhaba' });
  });

  it('Shift+Enter ve IME birleştirmesi sırasındaki Enter göndermez', async () => {
    await openConversation();
    const box = type('iki satır');
    await flush(2);

    expect(press(box, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(box, { isComposing: true }).defaultPrevented).toBe(false);
    await flush();

    expect(dmSends()).toHaveLength(0);
  });

  it('boş taslakta Enter hiçbir şey göndermez', async () => {
    await openConversation();
    const box = type('   ');
    await flush(2);

    press(box, {});
    await flush();

    expect(dmSends()).toHaveLength(0);
  });
});

describe('daha eski geçmiş', () => {
  it('tam bir sayfa geldiğinde bir önceki sayfa en eski mesajın bileşik imleciyle istenir', async () => {
    const newest = 1_700_000_100_000;
    const first = history(50, newest);
    const oldest = first[0]!;
    const older = history(12, Number(oldest.createdAt) - 1000, 'o');
    pages.set('', first);
    pages.set(String(oldest.createdAt), older);
    await openConversation();

    expect(rowIds()).toHaveLength(50);
    expect(historyCalls()).toHaveLength(1);
    expect(historyCalls()[0]).toContain('limit=50');
    expect(olderButton()).not.toBeNull();

    olderButton()!.click();
    await waitFor(() => expect(rowIds()).toHaveLength(62));

    const params = new URL(historyCalls()[1]!, 'http://x').searchParams;
    expect(params.get('limit')).toBe('50');
    expect(params.get('before')).toBe(String(oldest.createdAt));
    expect(params.get('beforeId')).toBe(String(oldest._id));
    // Eski sayfa ÖNE eklenir; sıra baştan sona artan zamandır.
    expect(rowIds().slice(0, 12)).toEqual(older.map(m => m._id));
    expect(rowIds().slice(12)).toEqual(first.map(m => m._id));
    // Kısa sayfa → geçmişin başı: düğme kalkar.
    expect(olderButton()).toBeNull();
  });

  it('50 mesajdan az geçmişte daha eski sayfa sunulmaz', async () => {
    pages.set('', history(7, 1_700_000_100_000));
    await openConversation();

    expect(rowIds()).toHaveLength(7);
    expect(olderButton()).toBeNull();
  });

  it('listenin en üstüne kaydırmak bir önceki sayfayı yükler ve okuma yerini korur', async () => {
    const first = history(50, 1_700_000_100_000);
    const oldestAt = String(first[0]!.createdAt);
    pages.set('', first);
    pages.set(oldestAt, history(50, Number(oldestAt) - 1000, 'o'));
    await openConversation();

    const el = list();
    el.scrollTop = 10;
    el.dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(rowIds()).toHaveLength(100));

    expect(new URL(historyCalls()[1]!, 'http://x').searchParams.get('before')).toBe(oldestAt);
    // Önceden 10px'teydik; 50 satır (50 × 40px) eklendi → aynı mesaj yerinde.
    expect(el.scrollTop).toBe(10 + 50 * ROW);
    // Tam sayfa geldi → daha eskisi olabilir.
    expect(olderButton()).not.toBeNull();
  });

  it('başka bir konuşmaya geçilince gecikmiş eski sayfa yeni konuşmaya karışmaz', async () => {
    const first = history(50, 1_700_000_100_000);
    const oldestAt = String(first[0]!.createdAt);
    pages.set('', first);
    let release: (() => void) | null = null;
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (urlValue: unknown) => {
      const url = String(urlValue);
      if (url.includes(`before=${oldestAt}`)) {
        await new Promise<void>(resolve => { release = resolve; });
        return json(history(50, Number(oldestAt) - 1000, 'late'));
      }
      if (url.includes('/dm-b/messages')) return json(history(50, 1_700_000_900_000, 'b').map(m => ({ ...m, dmId: 'dm-b' })));
      return base(urlValue);
    });
    await openConversation();

    olderButton()!.click();
    await waitFor(() => expect(release).not.toBeNull());
    BridgeRegistry.call('openDm', 'user-b');
    await waitFor(() => expect(rowIds()[0]).toMatch(/^b-/));
    // Yarım kalan istek yeni konuşmanın "daha eski" düğmesini kilitlemez.
    expect(olderButton()).not.toBeNull();
    expect(olderButton()!.disabled).toBe(false);
    release!();
    await flush();

    expect(rowIds()).toHaveLength(50);
    expect(rowIds().every(id => id.startsWith('b-'))).toBe(true);
  });
});

describe('en yeni mesaja kaydırma', () => {
  it('konuşma en yeni mesajda açılır', async () => {
    pages.set('', history(30, 1_700_000_100_000));
    await openConversation();

    expect(list().scrollTop).toBe(30 * ROW);
  });

  it('kendi gönderdiğim mesaj görünür alana kaydırılır', async () => {
    pages.set('', history(30, 1_700_000_100_000));
    await openConversation();
    list().scrollTop = 0; // geçmişi okuyordum

    type('yeni');
    await flush(2);
    document.querySelector<HTMLFormElement>('.dm-composer')!.requestSubmit();
    await flush();

    expect(list().scrollTop).toBe(31 * ROW);
  });

  it('altta okurken gelen mesaj görünür alana kaydırılır', async () => {
    pages.set('', history(30, 1_700_000_100_000));
    await openConversation();

    socket.fire('dm:message', { _id: 'in-1', dmId: 'dm-a', userId: 'user-a', displayName: 'Ada', content: 'yeni', createdAt: 1_700_000_200_000 });
    await flush();

    expect(list().scrollTop).toBe(31 * ROW);
  });

  it('geçmişi okurken gelen mesaj okuma yerini değiştirmez', async () => {
    pages.set('', history(30, 1_700_000_100_000));
    await openConversation();
    list().scrollTop = 120;

    socket.fire('dm:message', { _id: 'in-1', dmId: 'dm-a', userId: 'user-a', displayName: 'Ada', content: 'yeni', createdAt: 1_700_000_200_000 });
    await flush();

    expect(rowIds()).toContain('in-1');
    expect(list().scrollTop).toBe(120);
  });
});

describe('yan liste', () => {
  it('açık olmayan konuşmaya gelen mesaj okunmamış rozetini sunucudan tazeler', async () => {
    pages.set('', history(3, 1_700_000_100_000));
    await openConversation();
    const before = listCalls();
    expect(document.querySelector('.dm-unread')).toBeNull();

    conversations = conversations.map(c => (c.dmId === 'dm-b' ? { ...c, unreadCount: 2 } : c));
    // Çift teslim: sayaç yerelde artırılmaz, tek bir liste okuması yapılır.
    socket.fire('dm:message', { _id: 'b-1', dmId: 'dm-b', userId: 'user-b', content: 'selam', createdAt: 1_700_000_200_000 });
    socket.fire('dm:message', { _id: 'b-1', dmId: 'dm-b', userId: 'user-b', content: 'selam', createdAt: 1_700_000_200_000 });

    await waitFor(() => expect(document.querySelector('.dm-unread')?.textContent?.trim()).toBe('2'));
    expect(listCalls()).toBe(before + 1);
    // Açık konuşmanın satırları etkilenmez.
    expect(rowIds()).toHaveLength(3);
  });

  it('arka plan tazelemesi başarısız olursa açık konuşma ve mevcut liste korunur', async () => {
    pages.set('', history(3, 1_700_000_100_000));
    await openConversation();
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (urlValue: unknown) => (String(urlValue).endsWith('/api/dm') ? json({ error: 'x' }, 500) : base(urlValue)));

    socket.fire('dm:message', { _id: 'b-1', dmId: 'dm-b', userId: 'user-b', content: 'selam', createdAt: 1_700_000_200_000 });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(1));
    await flush();

    expect(document.querySelectorAll('.dm-conversation')).toHaveLength(2);
    expect(document.querySelector('.dm-sidebar .bridge-error')).toBeNull();
    expect(rowIds()).toHaveLength(3);
  });
});
