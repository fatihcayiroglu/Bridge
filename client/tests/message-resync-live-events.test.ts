// client/tests/message-resync-live-events.test.ts
//
// P3 — YENİDEN BAĞLANMA SENKRONU BAYAT ANLIK GÖRÜNTÜYLE CANLI OLAYLARI EZMEZ.
//
// Ölçüldü (e2e offline-queue, gecelik koşu ve yerelde 18 koşuda 7 düşüş):
// yeniden bağlanınca MessageLoader geçmişi yeniden ister ve MessageInputPanel
// kuyruktaki mesajı yeniden gönderir. Sunucu mesajı kaydedip `message:new` ve
// `message:ack` yolladıktan SONRA, ondan ÖNCE alınmış geçmiş yanıtı geldi ve
// listeyi ezdi: teslim edilmiş mesaj listeden düştü, kullanıcı onu "sırada"
// sandı. Aynı yarış, uçuş sırasında silinen bir mesajı geri getirir ve uçuş
// sırasında düzenlenen bir mesajı eski metnine döndürürdü.
//
// Gerçek AppState + gerçek MessageLoader birlikte çalışır; yalnız ağ taklittir.

import { cleanup, render, waitFor } from '@testing-library/svelte';
import { mount, unmount, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

import AppState from '../js/core/AppState.svelte';
import MessageLoader from '../js/core/MessageLoader.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

type Handler = (...args: unknown[]) => void;
type Msg = Record<string, unknown> & { _id: string };

function apiResponse(messages: unknown[]) {
  return { ok: true, status: 200, url: 'https://bridge.invalid/x', headers: new Headers(), typed: async () => ({ messages, hasMore: false }) } as never;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

function makeSocket() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, fn: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    off(event: string, fn: Handler) { handlers.set(event, (handlers.get(event) ?? []).filter(f => f !== fn)); },
    emit() {},
    fire(event: string, ...args: unknown[]) { for (const fn of [...(handlers.get(event) ?? [])]) fn(...args); },
  };
}

const CH = 'ch-1';
const msg = (id: string, at: number, content = id): Msg => ({ _id: id, channelId: CH, userId: 'u-1', displayName: 'Ada', content, createdAt: at });
const list = (): Msg[] => BridgeRegistry.call<Msg[]>('getMessages') ?? [];
const ids = (): string[] => list().map(m => m._id);

let socket: ReturnType<typeof makeSocket>;
let appState: ReturnType<typeof mount> | null = null;

async function openChannel(initial: Msg[]): Promise<void> {
  apiFetchMock.mockResolvedValueOnce(apiResponse(initial));
  render(MessageLoader);
  document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
  document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: CH } }));
  await waitFor(() => expect(ids()).toEqual(initial.map(m => m._id)));
}

/** Yeniden bağlanma senkronunu başlatır; geçmiş yanıtını test belirler. */
async function reconnectWithPendingHistory() {
  const history = deferred<unknown>();
  apiFetchMock.mockReturnValueOnce(history.promise);
  document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  return history;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  socket = makeSocket();
  appState = mount(AppState, { target: document.body });
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
  for (const key of ['resolvePendingSend', 'failPendingSend', 'rejectPendingSend', 'noteSpamWarning', 'resolveEditMutation', 'resolveDeleteMutation']) {
    BridgeRegistry.register(key, (() => undefined) as AnyFn);
  }
});

afterEach(() => {
  cleanup();
  if (appState) unmount(appState);
  appState = null;
  for (const key of ['socket', 'resolvePendingSend', 'failPendingSend', 'rejectPendingSend', 'noteSpamWarning', 'resolveEditMutation', 'resolveDeleteMutation']) {
    BridgeRegistry.unregister(key);
  }
  vi.restoreAllMocks();
});

describe('yeniden bağlanma senkronu — bayat anlık görüntü', () => {
  it('uçuşta teslim edilen (message:new + message:ack) mesaj listede kalır, "sırada" hayaleti kalmaz', async () => {
    await openChannel([msg('m-old', 1_000)]);
    BridgeRegistry.call('appendMessage', { _id: 'pending:a1', _key: 'pending:a1', ackId: 'a1', pending: true, queued: true, channelId: CH, userId: 'u-1', content: 'kuyruktaki', createdAt: 2_000 });

    const history = await reconnectWithPendingHistory();
    // Sunucu yeniden gönderilen mesajı kaydetti ve yayınladı…
    socket.fire('message:new', msg('m-new', 2_001, 'kuyruktaki'));
    socket.fire('message:ack', { ackId: 'a1', messageId: 'm-new', ts: 2_001 });
    await tick();
    expect(ids()).toEqual(['m-old', 'm-new']);
    // …ve ancak şimdi, mesajdan ÖNCE alınmış geçmiş yanıtı geliyor.
    history.resolve(apiResponse([msg('m-old', 1_000)]));
    await waitFor(() => expect(BridgeRegistry.call<boolean>('isMessagesLoading') ?? false).toBe(false));
    await tick();

    expect(ids()).toEqual(['m-old', 'm-new']);
    expect(list().some(m => m.pending || m.queued)).toBe(false);
  });

  it('uçuşta silinen mesaj bayat yanıtla geri gelmez', async () => {
    await openChannel([msg('m-1', 1_000), msg('m-2', 2_000)]);
    const history = await reconnectWithPendingHistory();
    socket.fire('message:deleted', { id: 'm-2' });
    await tick();
    history.resolve(apiResponse([msg('m-1', 1_000), msg('m-2', 2_000)]));
    await waitFor(() => expect(ids()).toEqual(['m-1']));
    await tick();
    expect(ids()).toEqual(['m-1']);
  });

  it('uçuşta yapılan düzenleme bayat yanıtla eski metne dönmez', async () => {
    await openChannel([msg('m-1', 1_000, 'eski')]);
    const history = await reconnectWithPendingHistory();
    socket.fire('message:edited', { ...msg('m-1', 1_000, 'yeni'), editedAt: 5_000 });
    await tick();
    history.resolve(apiResponse([msg('m-1', 1_000, 'eski')]));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    await new Promise(r => setTimeout(r, 0));
    await tick();
    expect(list().find(m => m._id === 'm-1')?.content).toBe('yeni');
  });

  it('KONTROL: uçuştan önce listede olup yanıtta olmayan (kopukken silinen) mesaj düşer', async () => {
    await openChannel([msg('m-1', 1_000), msg('m-gone', 1_500)]);
    const history = await reconnectWithPendingHistory();
    history.resolve(apiResponse([msg('m-1', 1_000)]));
    await waitFor(() => expect(ids()).toEqual(['m-1']));
  });
});
