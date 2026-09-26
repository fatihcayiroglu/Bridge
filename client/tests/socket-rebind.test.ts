// client/tests/socket-rebind.test.ts
// Faz 10.4 — Socket kimliğine duyarlı yeniden bağlama.
//
// KANITLANMIŞ İKİ P1 HATA (bu testler geri gelmesini engeller):
//
//  1) DmPanel `dm:message` dinleyicisini yalnız onMount'ta, O ANKİ socket
//     nesnesine bağlıyordu.
//  2) MessageLoader `socketBound` boolean'ını bir kez true yapıp hiç
//     sıfırlamıyordu.
//
// SocketManager iki farklı yoldan "yeniden bağlanır":
//   A) Socket.IO iç reconnect → AYNI nesne (dinleyiciler yaşar)
//   B) Auth token yenilemesi → teardown() + connect() → YENİ io() nesnesi
//
// (B) gerçekleştiğinde her iki bileşen de ölü nesnede kalıyordu: DM ve kanal
// mesajları canlı olarak GELMİYORDU (REST yeniden yükleme kısmen maskeliyordu).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DmPanel from '../js/core/DmPanel.svelte';
import MessageLoader from '../js/core/MessageLoader.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

type Handler = (...args: unknown[]) => void;

/** Socket.IO benzeri test çifti — dinleyici sayısı ölçülebilir. */
function makeSocket(label: string) {
  const handlers = new Map<string, Handler[]>();
  return {
    label,
    handlers,
    on(event: string, fn: Handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn);
    },
    off(event: string, fn: Handler) {
      const list = handlers.get(event) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit() { /* giden mesajlar bu testin konusu değil */ },
    /** Sunucudan gelen olayı taklit eder. */
    fire(event: string, payload: unknown) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
    },
    count(event: string) { return (handlers.get(event) ?? []).length; },
  };
}

type TestSocket = ReturnType<typeof makeSocket>;

function setSocket(socket: TestSocket | null): void {
  if (socket) BridgeRegistry.register('socket', socket as unknown as AnyFn);
  else BridgeRegistry.unregister('socket');
}

/** Auth yenilemesini taklit eder: eski nesne gider, YENİ nesne gelir. */
function replaceSocketAndAnnounce(next: TestSocket): void {
  setSocket(next);
  document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
  flushSync();
}

/** Socket.IO iç reconnect: nesne AYNI kalır. */
function announceSameSocketReconnect(): void {
  document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
  flushSync();
}

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  host.innerHTML = '<div id="messages-area"></div>';
  document.body.appendChild(host);
  // MessageLoader'ın okuduğu asgari durum.
  BridgeRegistry.register('getCurrentChannel', () => null);
  BridgeRegistry.register('getMe', () => ({ _id: 'me' }));
  for (const n of ['setMessages', 'setMessagesLoading', 'setMessagesError', 'setMessageCursor',
                   'setMessagesHasMore', 'appendMessage', 'updateMessage', 'removeMessage',
                   'getMessages', 'replaceMessage', 'resolvePendingSend', 'failPendingSend',
                   'clearTypingUsers', 'setTypingUsers']) {
    BridgeRegistry.register(n, () => undefined);
  }
});

afterEach(() => {
  if (instance) { unmount(instance); instance = null; }
  host.remove();
  setSocket(null);
  vi.restoreAllMocks();
});

describe('DmPanel — socket yeniden bağlama', () => {
  it('mount anında MEVCUT sockete tam bir kez bağlanır', () => {
    const a = makeSocket('A');
    setSocket(a);

    instance = mount(DmPanel, { target: host });
    flushSync();

    expect(a.count('dm:message')).toBe(1);
  });

  it('socket sonradan hazır olursa yine bağlanır (mount → socket sırası)', () => {
    setSocket(null);
    instance = mount(DmPanel, { target: host });
    flushSync();

    const a = makeSocket('A');
    replaceSocketAndAnnounce(a);

    expect(a.count('dm:message')).toBe(1);
  });

  it('AYNI socket reconnect\'inde dinleyici ÇOĞALMAZ', () => {
    const a = makeSocket('A');
    setSocket(a);
    instance = mount(DmPanel, { target: host });
    flushSync();

    announceSameSocketReconnect();
    announceSameSocketReconnect();
    announceSameSocketReconnect();

    expect(a.count('dm:message')).toBe(1);
  });

  it('auth yenilemesi (YENİ socket) → eski nesne temizlenir, yeni nesnede tam bir dinleyici', () => {
    const a = makeSocket('A');
    setSocket(a);
    instance = mount(DmPanel, { target: host });
    flushSync();

    const b = makeSocket('B');
    replaceSocketAndAnnounce(b);

    expect(a.count('dm:message')).toBe(0);   // bayat nesne temiz
    expect(b.count('dm:message')).toBe(1);   // yeni nesnede tam bir tane
  });

  it('A→B→C→D→E tekrarlı değişimde dinleyici büyümesi = 0', () => {
    const sockets = ['A', 'B', 'C', 'D', 'E'].map(makeSocket);
    setSocket(sockets[0]);
    instance = mount(DmPanel, { target: host });
    flushSync();

    for (let i = 1; i < sockets.length; i += 1) replaceSocketAndAnnounce(sockets[i]);

    // Yalnız güncel nesnede bir dinleyici; hepsinin toplamı da 1.
    expect(sockets.at(-1)!.count('dm:message')).toBe(1);
    expect(sockets.reduce((sum, s) => sum + s.count('dm:message'), 0)).toBe(1);
  });

  it('unmount sonrası güncel sockette dinleyici kalmaz', () => {
    const a = makeSocket('A');
    setSocket(a);
    instance = mount(DmPanel, { target: host });
    flushSync();

    unmount(instance); instance = null;
    flushSync();

    expect(a.count('dm:message')).toBe(0);
  });

  it('socket değiştikten SONRA unmount edilirse bayat nesnede de dinleyici kalmaz', () => {
    const a = makeSocket('A');
    const b = makeSocket('B');
    setSocket(a);
    instance = mount(DmPanel, { target: host });
    flushSync();
    replaceSocketAndAnnounce(b);

    unmount(instance); instance = null;
    flushSync();

    expect(a.count('dm:message')).toBe(0);
    expect(b.count('dm:message')).toBe(0);
  });
});

describe('MessageLoader — socket yeniden bağlama', () => {
  const OWNED = ['message:new', 'message:ack', 'error:message', 'message:edited', 'message:deleted'];

  it('mount anında sahip olduğu olaylara tam birer kez bağlanır', () => {
    const a = makeSocket('A');
    setSocket(a);

    instance = mount(MessageLoader, { target: host });
    flushSync();

    for (const e of OWNED) expect(a.count(e), e).toBe(1);
  });

  it('AYNI socket reconnect\'i gereksiz yeniden bağlama üretmez', () => {
    const a = makeSocket('A');
    setSocket(a);
    instance = mount(MessageLoader, { target: host });
    flushSync();

    announceSameSocketReconnect();
    announceSameSocketReconnect();

    for (const e of OWNED) expect(a.count(e), e).toBe(1);
  });

  it('auth yenilemesi → bayat sockette 0, yeni sockette 1 (asıl hata)', () => {
    const a = makeSocket('A');
    setSocket(a);
    instance = mount(MessageLoader, { target: host });
    flushSync();

    const b = makeSocket('B');
    replaceSocketAndAnnounce(b);

    for (const e of OWNED) {
      expect(a.count(e), `bayat ${e}`).toBe(0);
      expect(b.count(e), `yeni ${e}`).toBe(1);
    }
  });

  it('tekrarlı socket değişiminde toplam dinleyici sayısı sabit kalır', () => {
    const sockets = ['A', 'B', 'C', 'D'].map(makeSocket);
    setSocket(sockets[0]);
    instance = mount(MessageLoader, { target: host });
    flushSync();

    for (let i = 1; i < sockets.length; i += 1) replaceSocketAndAnnounce(sockets[i]);

    for (const e of OWNED) {
      const total = sockets.reduce((sum, s) => sum + s.count(e), 0);
      expect(total, e).toBe(1);
    }
  });

  it('bayat sockete gelen mesaj artık İŞLENMEZ, yeni sockete gelen bir kez işlenir', () => {
    const appended: string[] = [];
    BridgeRegistry.register('appendMessage', (m: unknown) => {
      appended.push((m as { _id: string })._id); return true;
    });
    BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'ch-1' }));

    const a = makeSocket('A');
    setSocket(a);
    instance = mount(MessageLoader, { target: host });
    flushSync();
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: 'ch-1' } }));
    flushSync();

    const b = makeSocket('B');
    replaceSocketAndAnnounce(b);

    a.fire('message:new', { _id: 'stale', channelId: 'ch-1' });
    b.fire('message:new', { _id: 'live', channelId: 'ch-1' });

    expect(appended).not.toContain('stale');
    expect(appended.filter(id => id === 'live')).toHaveLength(1);
  });

  it('ACK socket değişiminden sonra TAM BİR KEZ işlenir', () => {
    const resolved: string[] = [];
    BridgeRegistry.register('resolvePendingSend', (k: unknown) => { resolved.push(String(k)); });

    const a = makeSocket('A');
    setSocket(a);
    instance = mount(MessageLoader, { target: host });
    flushSync();

    const b = makeSocket('B');
    replaceSocketAndAnnounce(b);

    b.fire('message:ack', { ackId: 'ack-1', messageId: 'm-1' });

    expect(resolved).toEqual(['ack-1']);   // çift ACK işleme yok
  });

  it('unmount sahip olunan tüm dinleyicileri bırakır', () => {
    const a = makeSocket('A');
    setSocket(a);
    instance = mount(MessageLoader, { target: host });
    flushSync();

    unmount(instance); instance = null;
    flushSync();

    for (const e of OWNED) expect(a.count(e), e).toBe(0);
  });
});
