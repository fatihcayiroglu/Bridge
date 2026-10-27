// client/tests/message-resync-retry.test.ts
//
// N02 (#497 Android 40470478921): after a reconnect the missed message was on
// the server but never appeared. The re-read of the open channel is a single
// HTTP request. REST goes through the native HTTP stack, the socket through
// its own WebSocket, so right after a network change the re-read can fail
// while the socket is already back. The loader then showed the cached window
// and never asked again: nothing else re-reads while the socket stays up.
//
// A network failure while the socket is connected is now retried with a
// bounded backoff. With the socket down nothing is retried: the reconnect
// itself re-reads. Real AppState + real MessageLoader; only the network is
// faked.

import { cleanup, render, waitFor } from '@testing-library/svelte';
import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

import AppState from '../js/core/AppState.svelte';
import MessageLoader from '../js/core/MessageLoader.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

type Msg = Record<string, unknown> & { _id: string };

function apiResponse(messages: unknown[]) {
  return { ok: true, status: 200, url: 'https://bridge.invalid/x', headers: new Headers(), typed: async () => ({ messages, hasMore: false }) } as never;
}
const networkFailure = () => Promise.reject(new TypeError('Failed to fetch'));

function makeSocket(connected: boolean) {
  return { connected, on() {}, off() {}, emit() {} };
}

const CH = 'ch-1';
const msg = (id: string, at: number): Msg => ({ _id: id, channelId: CH, userId: 'u-1', displayName: 'Ada', content: id, createdAt: at });
const ids = (): string[] => (BridgeRegistry.call<Msg[]>('getMessages') ?? []).map(m => m._id);
const historyCalls = () => apiFetchMock.mock.calls.filter(([url]) => String(url).includes(`/channels/${CH}/messages`)).length;

let socket: ReturnType<typeof makeSocket>;
let appState: ReturnType<typeof mount> | null = null;

async function openChannel(initial: Msg[]): Promise<void> {
  apiFetchMock.mockResolvedValueOnce(apiResponse(initial));
  render(MessageLoader);
  document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
  document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: CH } }));
  await waitFor(() => expect(ids()).toEqual(initial.map(m => m._id)));
}

beforeEach(() => {
  apiFetchMock.mockReset();
  socket = makeSocket(true);
  appState = mount(AppState, { target: document.body });
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  if (appState) unmount(appState);
  appState = null;
  BridgeRegistry.unregister('socket');
  vi.restoreAllMocks();
});

describe('reconnect re-read after a transient network failure', () => {
  it('socket connected: a failed re-read is retried and the missed message appears', async () => {
    await openChannel([msg('m-old', 1_000)]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetchMock.mockImplementationOnce(networkFailure);
    apiFetchMock.mockResolvedValueOnce(apiResponse([msg('m-old', 1_000), msg('m-missed', 2_000)]));

    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await waitFor(() => expect(historyCalls()).toBe(2));
    expect(ids()).toEqual(['m-old']);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(ids()).toEqual(['m-old', 'm-missed']));
    expect(historyCalls()).toBe(3);
  });

  it('retries are bounded: three more attempts, then the loader stops', async () => {
    await openChannel([msg('m-old', 1_000)]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetchMock.mockImplementation(networkFailure);

    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await waitFor(() => expect(historyCalls()).toBe(2));
    for (const ms of [1_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(ms);
    await waitFor(() => expect(historyCalls()).toBe(5));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(historyCalls()).toBe(5);
  });

  it('socket down: no retry (the reconnect itself re-reads)', async () => {
    await openChannel([msg('m-old', 1_000)]);
    socket.connected = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetchMock.mockImplementation(networkFailure);

    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await waitFor(() => expect(historyCalls()).toBe(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(historyCalls()).toBe(2);
  });

  it('a newer load or another channel cancels the pending retry', async () => {
    await openChannel([msg('m-old', 1_000)]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetchMock.mockImplementationOnce(networkFailure);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await waitFor(() => expect(historyCalls()).toBe(2));

    apiFetchMock.mockResolvedValueOnce(apiResponse([{ ...msg('o-1', 3_000), channelId: 'ch-2' }]));
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: 'ch-2' } }));
    await waitFor(() => expect(ids()).toEqual(['o-1']));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(historyCalls()).toBe(2); // ch-1 was not read again
  });

  it('a server error (5xx) is not retried by this path', async () => {
    await openChannel([msg('m-old', 1_000)]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 503, url: 'https://bridge.invalid/x', headers: new Headers(), json: async () => ({}), clone() { return this; } } as never);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await waitFor(() => expect(historyCalls()).toBe(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(historyCalls()).toBe(2);
  });
});
