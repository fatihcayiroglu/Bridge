import { cleanup, render, waitFor } from '@testing-library/svelte';
import { t } from '../js/core/i18n/index.ts';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

import MessageLoader from '../js/core/MessageLoader.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

type Handler = (...args: unknown[]) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function apiResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://bridge.invalid/private-path',
    // ÜRETİM `response.headers.get('X-Bridge-First-Unread-Id')` OKUR.
    // Çift bu alanı taşımadığı için her başarılı yükleme `TypeError` ile
    // catch dalına düşüyordu: `setMessages` hiç çağrılmıyor, liste boş
    // kalıyordu. Yani testler ürünün başarı yolunu HİÇ ölçmüyordu.
    headers: new Headers(headers),
    typed: async () => body,
  } as never;
}

function makeSocket() {
  const handlers = new Map<string, Handler[]>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  return {
    emitted,
    on(event: string, fn: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    off(event: string, fn: Handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== fn));
    },
    emit(event: string, ...args: unknown[]) { emitted.push({ event, args }); },
    fire(event: string, ...args: unknown[]) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
    },
    count(event: string) { return handlers.get(event)?.length ?? 0; },
  };
}

const keys = [
  'socket', 'getCurrentChannel', 'setMessagesLoading', 'setMessagesError',
  'setMessages', 'setMessageCursor', 'setMessagesHasMore', 'getMessageCursor',
  'prependMessages', 'appendMessage', 'replaceMessage', 'resolvePendingSend',
  'failPendingSend', 'updateMessage', 'removeMessage', 'getMessages',
  'setTypingUser', 'clearTypingUser', 'clearTypingUsers', 'getTypingUsers', 'toast',
  'loadMessages', 'loadOlderMessages', 'getActiveChannelId',
];

let socket: ReturnType<typeof makeSocket>;
let currentChannel: { _id?: string } | null;
let messages: Array<Record<string, unknown>>;
let cursor: string | null;
let hasMore: boolean;
let loading: boolean;
let errorText: string;
let typing: Map<string, string>;
let updated: ReturnType<typeof vi.fn>;
let calls: Record<string, ReturnType<typeof vi.fn>>;

function registerState(): void {
  calls = {};
  const spy = (name: string, implementation: (...args: unknown[]) => unknown = () => undefined) => {
    const fn = vi.fn(implementation);
    calls[name] = fn;
    BridgeRegistry.register(name, fn as never);
    return fn;
  };

  BridgeRegistry.register('socket', socket as unknown as AnyFn);
  spy('getCurrentChannel', () => currentChannel);
  spy('setMessagesLoading', value => { loading = Boolean(value); });
  spy('setMessagesError', value => { errorText = String(value); });
  spy('setMessages', value => { messages = value as Array<Record<string, unknown>>; });
  spy('setMessageCursor', value => { cursor = value as string | null; });
  spy('setMessagesHasMore', value => { hasMore = Boolean(value); });
  spy('getMessageCursor', () => cursor);
  spy('prependMessages', value => {
    const incoming = value as Array<Record<string, unknown>>;
    messages = [...incoming, ...messages];
    return incoming.length;
  });
  spy('appendMessage', value => {
    const incoming = value as Record<string, unknown>;
    if (messages.some(item => item._id === incoming._id)) return false;
    messages.push(incoming);
    return true;
  });
  spy('replaceMessage');
  spy('resolvePendingSend');
  spy('failPendingSend');
  spy('updateMessage', () => true);
  spy('removeMessage', () => false);
  spy('getMessages', () => messages);
  spy('setTypingUser', (id, label) => { typing.set(String(id), String(label)); });
  spy('clearTypingUser', id => { typing.delete(String(id)); });
  spy('clearTypingUsers', () => { typing.clear(); });
  spy('getTypingUsers', () => typing);
  spy('toast');
}

function select(channelId?: string): void {
  currentChannel = channelId ? { _id: channelId } : null;
  document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: channelId ? { channelId } : {} }));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="typing-bar" style="display:none"><span id="typing-text"></span></div>';
  apiFetchMock.mockReset();
  socket = makeSocket();
  currentChannel = null;
  messages = [];
  cursor = null;
  hasMore = false;
  loading = false;
  errorText = '';
  typing = new Map();
  updated = vi.fn();
  document.addEventListener('bridge:messages-updated', updated);
  registerState();
});

afterEach(() => {
  cleanup();
  document.removeEventListener('bridge:messages-updated', updated);
  for (const key of keys) BridgeRegistry.unregister(key);
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('MessageLoader — request state machine', () => {
  it('no-ops without a channel/cursor and can reload the active channel through the public bridge', async () => {
    apiFetchMock.mockResolvedValue(apiResponse({ messages: [], hasMore: false }));
    render(MessageLoader);

    BridgeRegistry.call('loadMessages');
    cursor = 'orphan-cursor';
    await BridgeRegistry.call<Promise<void>>('loadOlderMessages');
    expect(apiFetchMock).not.toHaveBeenCalled();

    select('active');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    apiFetchMock.mockClear();
    BridgeRegistry.call('loadMessages');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('/channels/active/messages?limit=50'));

    cursor = null;
    await BridgeRegistry.call<Promise<void>>('loadOlderMessages');
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes omitted message-page fields and tolerates an owner that reports no prepend count', async () => {
    apiFetchMock.mockResolvedValueOnce(apiResponse({}));
    render(MessageLoader);
    select('active');
    // İkinci argüman: istek uçuştayken canlı gelen mesaj kimlikleri (P3) — burada hiçbiri.
    await waitFor(() => expect(calls.setMessages).toHaveBeenCalledWith([], new Set()));
    expect(cursor).toBeNull();
    expect(hasMore).toBe(false);

    cursor = 'older';
    const prepend = vi.fn(() => undefined);
    BridgeRegistry.register('prependMessages', prepend);
    apiFetchMock.mockResolvedValueOnce(apiResponse({}));
    await BridgeRegistry.call<Promise<void>>('loadOlderMessages');

    expect(prepend).toHaveBeenCalledWith([]);
    expect(cursor).toBeNull();
    expect(hasMore).toBe(false);
  });

  it('loads the selected channel, joins/leaves rooms, and exposes pagination state', async () => {
    apiFetchMock.mockResolvedValue(apiResponse({
      messages: [{ _id: 'm-1', channelId: 'chan/a', content: 'hello' }],
      prevCursor: 'older cursor', hasMore: true,
    }));
    render(MessageLoader);

    select();
    expect(apiFetchMock).not.toHaveBeenCalled();
    select('chan/a');
    await waitFor(() => expect(messages.map(item => item._id)).toEqual(['m-1']));

    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('/channels/chan%2Fa/messages?limit=50'));
    expect(socket.emitted).toContainEqual({ event: 'channel:join', args: ['chan/a'] });
    expect(cursor).toBe('older cursor');
    expect(hasMore).toBe(true);
    expect(loading).toBe(false);
    expect(errorText).toBe('');
    expect(BridgeRegistry.call('getActiveChannelId')).toBe('chan/a');

    apiFetchMock.mockResolvedValueOnce(apiResponse({ messages: [], prevCursor: null, hasMore: false }));
    select('chan-b');
    await waitFor(() => expect(BridgeRegistry.call('getActiveChannelId')).toBe('chan-b'));
    expect(socket.emitted).toContainEqual({ event: 'channel:leave', args: ['chan/a'] });
    expect(socket.emitted).toContainEqual({ event: 'channel:join', args: ['chan-b'] });
  });

  it('commits only the newest channel response when requests resolve out of order', async () => {
    const old = deferred<ReturnType<typeof apiResponse>>();
    const fresh = deferred<ReturnType<typeof apiResponse>>();
    apiFetchMock.mockImplementation((url: string) => url.includes('/old/') ? old.promise : fresh.promise);
    render(MessageLoader);

    select('old');
    select('fresh');
    fresh.resolve(apiResponse({ messages: [{ _id: 'fresh-message', channelId: 'fresh' }], hasMore: false }));
    await waitFor(() => expect(messages[0]?._id).toBe('fresh-message'));
    old.resolve(apiResponse({ messages: [{ _id: 'PRIVATE-STALE', channelId: 'old' }], hasMore: true }));
    await tick();
    await tick();

    expect(messages.map(item => item._id)).toEqual(['fresh-message']);
    expect(loading).toBe(false);
  });

  it('invalidates an in-flight request on unmount so it cannot write into a later session', async () => {
    const pending = deferred<ReturnType<typeof apiResponse>>();
    apiFetchMock.mockReturnValue(pending.promise);
    const view = render(MessageLoader);
    select('private-old');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    view.unmount();
    // Simulate a new application owner registering the same shared setters.
    const nextSessionSet = vi.fn();
    BridgeRegistry.register('setMessages', nextSessionSet);
    pending.resolve(apiResponse({ messages: [{ _id: 'old-account-secret', channelId: 'private-old' }] }));
    await tick();
    await tick();

    expect(nextSessionSet).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it('maps HTTP/network/malformed responses to safe inline errors', async () => {
    apiFetchMock.mockResolvedValueOnce(apiResponse({}, 403));
    render(MessageLoader);
    select('secret-channel');
    await waitFor(() => expect(errorText).toMatch(/yetkin yok/i));
    expect(errorText).not.toContain('private-path');
    expect(calls.toast).not.toHaveBeenCalled();

    apiFetchMock.mockRejectedValueOnce(new Error('Failed to fetch https://token.invalid/secret'));
    await BridgeRegistry.call<Promise<void>>('loadMessages', 'network-channel');
    await waitFor(() => expect(errorText).toMatch(/bağlan/i));
    expect(errorText).not.toContain('token.invalid');

    apiFetchMock.mockResolvedValueOnce(apiResponse({ messages: { not: 'an array' } }));
    await BridgeRegistry.call<Promise<void>>('loadMessages', 'bad-shape');
    await waitFor(() => expect(errorText).toMatch(/Bir hata oluştu/i));
  });

  it('prepends older messages and suppresses a stale pagination failure after navigation', async () => {
    apiFetchMock.mockResolvedValueOnce(apiResponse({
      messages: [{ _id: 'new', channelId: 'a' }], prevCursor: 'cursor/1', hasMore: true,
    }));
    render(MessageLoader);
    select('a');
    await waitFor(() => expect(cursor).toBe('cursor/1'));

    apiFetchMock.mockResolvedValueOnce(apiResponse({
      messages: [{ _id: 'old', channelId: 'a' }], prevCursor: null, hasMore: false,
    }));
    await BridgeRegistry.call<Promise<void>>('loadOlderMessages');
    expect(messages.map(item => item._id)).toEqual(['old', 'new']);
    expect(cursor).toBeNull();
    expect(hasMore).toBe(false);

    cursor = 'again';
    const stale = deferred<ReturnType<typeof apiResponse>>();
    apiFetchMock.mockReturnValueOnce(stale.promise);
    const older = BridgeRegistry.call<Promise<void>>('loadOlderMessages')!;
    apiFetchMock.mockResolvedValueOnce(apiResponse({ messages: [], hasMore: false }));
    select('b');
    stale.resolve(apiResponse({}, 500));
    await older;
    expect(calls.toast).not.toHaveBeenCalled();
  });

  it('rejects a malformed current page but suppresses a successful stale page after navigation', async () => {
    apiFetchMock.mockResolvedValueOnce(apiResponse({
      messages: [{ _id: 'new', channelId: 'a' }], prevCursor: 'cursor-1', hasMore: true,
    }));
    render(MessageLoader);
    select('a');
    await waitFor(() => expect(cursor).toBe('cursor-1'));

    apiFetchMock.mockResolvedValueOnce(apiResponse({ messages: { private: 'not-an-array' } }));
    await BridgeRegistry.call<Promise<void>>('loadOlderMessages');
    expect(calls.toast).toHaveBeenCalledTimes(1);

    cursor = 'cursor-2';
    const stale = deferred<ReturnType<typeof apiResponse>>();
    apiFetchMock.mockReturnValueOnce(stale.promise);
    const older = BridgeRegistry.call<Promise<void>>('loadOlderMessages')!;
    apiFetchMock.mockResolvedValueOnce(apiResponse({ messages: [], hasMore: false }));
    select('b');
    stale.resolve(apiResponse({ messages: [{ _id: 'private-old', channelId: 'a' }], hasMore: false }));
    await older;

    expect(messages.some(item => item._id === 'private-old')).toBe(false);
  });
});

describe('MessageLoader — socket mutations and typing lifecycle', () => {
  async function activate(): Promise<void> {
    apiFetchMock.mockResolvedValue(apiResponse({ messages: [], hasMore: false }));
    render(MessageLoader);
    select('active');
    await waitFor(() => expect(BridgeRegistry.call('getActiveChannelId')).toBe('active'));
  }

  it('validates socket identities and reconciles new/edit/ack/error events exactly once', async () => {
    await activate();
    socket.fire('message:new', null);
    socket.fire('message:new', { _id: {}, channelId: 'active' });
    socket.fire('message:new', { _id: 'wrong', channelId: 'other' });
    socket.fire('message:new', { _id: 'live', channelId: 'active', content: '<img onerror=alert(1)>' });
    socket.fire('message:new', { _id: 'live', channelId: 'active' });
    expect(messages.map(item => item._id)).toEqual(['live']);

    socket.fire('message:ack', { ackId: {}, messageId: 'bad' });
    socket.fire('message:ack', { tmpId: 'ack-1', messageId: 'real-1', ts: 123 });
    expect(calls.replaceMessage).toHaveBeenCalledWith('pending:ack-1', {
      _id: 'real-1', pending: false, queued: false, failed: false, createdAt: 123,
    });
    expect(calls.resolvePendingSend).toHaveBeenCalledWith('ack-1');

    socket.fire('error:message', { ackId: {} });
    // Sunucunun `message` alani KULLANILMAZ: teslim hatasi `code` uzerinden
    // kanonik ve cevrilmis metne eslenir (message-delivery-error.ts).
    socket.fire('error:message', { ackId: 'ack-1', code: 'MISSING_PERMISSION', message: 'permission denied' });
    expect(calls.failPendingSend).toHaveBeenCalledTimes(1);
    expect(calls.failPendingSend).toHaveBeenCalledWith('ack-1', t('delivery_channel_permission'));
    expect(calls.failPendingSend).not.toHaveBeenCalledWith('ack-1', 'permission denied');

    socket.fire('message:edited', { _id: {} });
    socket.fire('message:edited', { _id: 'live', content: 'edited' });
    expect(calls.updateMessage).toHaveBeenCalledWith({ _id: 'live', content: 'edited' });
  });

  it('supports tmpId acknowledgements and does not announce mutations rejected by the state owner', async () => {
    await activate();
    updated.mockClear();

    socket.fire('message:ack', { tmpId: 'tmp-only', messageId: 'real-without-ts' });
    expect(calls.replaceMessage).toHaveBeenCalledWith('pending:tmp-only', {
      _id: 'real-without-ts', pending: false, queued: false, failed: false,
    });
    socket.fire('error:message', { tmpId: 'tmp-only' });
    // Kod yoksa bile kullaniciya BOS DEGIL, kanonik bir teslim hatasi verilir.
    expect(calls.failPendingSend).toHaveBeenCalledWith('tmp-only', t('delivery_send_failed'));

    const rejectUpdate = vi.fn(() => false);
    BridgeRegistry.register('updateMessage', rejectUpdate);
    socket.fire('message:edited', { _id: 'edited-but-not-owned' });
    socket.fire('message:reaction', { messageId: 'reaction-but-not-owned' });
    socket.fire('message:pinned', { messageId: 'pin-but-not-owned', pinned: false });
    socket.fire('message:embedUpdate', { messageId: 'embed-but-not-owned', embeds: [] });
    expect(rejectUpdate).toHaveBeenCalledTimes(4);
    expect(updated).toHaveBeenCalledTimes(1); // only the acknowledgement above

    socket.fire('message:pinned', { messageId: {} });
    socket.fire('message:embedUpdate', { messageId: {} });
    expect(rejectUpdate).toHaveBeenCalledTimes(4);
  });

  it('cascades deletes and applies reaction/pin/embed mutations while ignoring malformed payloads', async () => {
    await activate();
    messages = [
      { _id: 'parent', channelId: 'active' },
      { _id: 'reply', channelId: 'active', replyTo: { _id: 'parent', content: 'snapshot' } },
      { _id: 'already', channelId: 'active', replyTo: { _id: 'parent', deleted: true } },
    ];
    socket.fire('message:deleted', { id: {} });
    socket.fire('message:deleted', { id: 'parent' });
    expect(calls.updateMessage).toHaveBeenCalledWith({
      _id: 'reply', replyTo: { _id: 'parent', content: 'snapshot', deleted: true },
    });
    expect(calls.removeMessage).toHaveBeenCalledWith('parent');

    socket.fire('message:reaction', { messageId: {} });
    socket.fire('message:reaction', { messageId: 'reply' });
    socket.fire('message:pinned', { messageId: 'reply', pinned: true });
    socket.fire('message:embedUpdate', { messageId: 'reply' });
    expect(calls.updateMessage).toHaveBeenCalledWith(expect.objectContaining({ _id: 'reply', reactions: {} }));
    expect(calls.updateMessage).toHaveBeenCalledWith(expect.objectContaining({ _id: 'reply', pinned: true }));
    expect(calls.updateMessage).toHaveBeenCalledWith(expect.objectContaining({ _id: 'reply', embeds: [] }));
  });

  it('announces a direct removal even when the message owner has no loaded snapshot', async () => {
    await activate();
    updated.mockClear();
    BridgeRegistry.register('getMessages', vi.fn(() => undefined));
    const remove = vi.fn(() => true);
    BridgeRegistry.register('removeMessage', remove);

    socket.fire('message:deleted', { id: 'gone' });

    expect(remove).toHaveBeenCalledWith('gone');
    expect(updated).toHaveBeenCalledTimes(1);

    updated.mockClear();
    remove.mockReturnValue(false);
    socket.fire('message:deleted', { id: 'already-absent' });
    expect(updated).not.toHaveBeenCalled();
  });

  it('renders one/two/many typers, filters other channels, and expires lost stop events', async () => {
    vi.useFakeTimers();
    await activate();
    const bar = document.getElementById('typing-bar')!;
    const text = document.getElementById('typing-text')!;

    socket.fire('typing:update', null);
    socket.fire('typing:update', { userId: {}, typing: true });
    socket.fire('typing:update', { channelId: 'other', userId: 'x', displayName: 'Wrong', typing: true });
    expect(typing.size).toBe(0);

    socket.fire('typing:update', { channelId: 'active', userId: 'a', displayName: 'Ada', typing: true });
    expect(text).toHaveTextContent('Ada yazıyor');
    expect(bar.style.display).toBe('');
    socket.fire('typing:update', { userId: 'b', username: 'Grace', typing: true });
    expect(text).toHaveTextContent('Ada ve Grace yazıyor');
    socket.fire('typing:update', { userId: 'c', typing: true });
    expect(text).toHaveTextContent('3 kişi yazıyor');

    socket.fire('typing:update', { userId: 'b', typing: false });
    expect(typing.has('b')).toBe(false);
    vi.advanceTimersByTime(8_001);
    await tick();
    expect(typing.size).toBe(0);
    expect(bar.style.display).toBe('none');
    expect(text.textContent).toBe('');
  });

  it('keeps typing updates safe while shell nodes or the typing-state owner are temporarily absent', async () => {
    await activate();
    document.getElementById('typing-bar')?.remove();
    socket.fire('typing:update', { userId: 'a', displayName: 'Ada', typing: true });

    document.body.insertAdjacentHTML('afterbegin', '<div id="typing-bar"></div>');
    document.getElementById('typing-text')?.remove();
    socket.fire('typing:update', { userId: 'b', displayName: 'Grace', typing: true });

    document.getElementById('typing-bar')!.insertAdjacentHTML('beforeend', '<span id="typing-text">stale</span>');
    BridgeRegistry.register('getTypingUsers', vi.fn(() => undefined));
    socket.fire('typing:update', { userId: 'c', displayName: 'Lin', typing: true });
    expect(document.getElementById('typing-bar')!.style.display).toBe('none');
    expect(document.getElementById('typing-text')).toHaveTextContent('');
  });

  it('binds a late socket, joins the selected channel once, and releases it if the socket disappears', async () => {
    BridgeRegistry.unregister('socket');
    apiFetchMock.mockResolvedValue(apiResponse({ messages: [], hasMore: false }));
    render(MessageLoader);
    select('late-channel');
    await waitFor(() => expect(BridgeRegistry.call('getActiveChannelId')).toBe('late-channel'));

    const lateSocket = makeSocket();
    BridgeRegistry.register('socket', lateSocket as unknown as AnyFn);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    await tick();
    expect(lateSocket.emitted).toContainEqual({ event: 'channel:join', args: ['late-channel'] });
    expect(lateSocket.count('message:new')).toBe(1);

    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(lateSocket.count('message:new')).toBe(1);

    BridgeRegistry.unregister('socket');
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(lateSocket.count('message:new')).toBe(0);
  });

  it('loads and joins a channel that was already active before mount', async () => {
    currentChannel = { _id: 'boot-channel' };
    apiFetchMock.mockResolvedValue(apiResponse({ messages: [], hasMore: false }));
    render(MessageLoader);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/channels/boot-channel/messages?limit=50'),
    ));
    expect(socket.emitted).toContainEqual({ event: 'channel:join', args: ['boot-channel'] });
  });

  it('rejoins and refreshes after reconnect, then tears down all handlers/timers/bridges', async () => {
    vi.useFakeTimers();
    await activate();
    socket.fire('typing:update', { userId: 'a', displayName: 'Ada', typing: true });
    apiFetchMock.mockClear();

    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await tick();
    expect(socket.emitted).toContainEqual({ event: 'channel:join', args: ['active'] });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    cleanup();
    for (const event of [
      'message:new', 'message:ack', 'error:message', 'message:edited',
      'message:deleted', 'message:reaction', 'message:pinned', 'message:embedUpdate', 'typing:update',
    ]) expect(socket.count(event), event).toBe(0);
    expect(typing.size).toBe(0);
    expect(BridgeRegistry.has('loadMessages')).toBe(false);
    expect(BridgeRegistry.has('loadOlderMessages')).toBe(false);
    expect(BridgeRegistry.has('getActiveChannelId')).toBe(false);
  });
});

// Final21 UX (U-11): gönderim retleri ackId ile bekleyen gönderime eşlenir. Eskiden
// `error:spam`, `error:slowmode`, `error:timeout`, `warn:spam` hiç dinlenmiyordu; reddedilen
// mesaj 10 sn sonra yanıltıcı "sunucu onayı zaman aşımına uğradı" ile düşüyordu.
describe('MessageLoader — send rejections reach the pending send', () => {
  async function activateForRejections(): Promise<{ reject: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }> {
    apiFetchMock.mockResolvedValue(apiResponse({ messages: [], hasMore: false }));
    const reject = vi.fn();
    const warn = vi.fn();
    BridgeRegistry.register('rejectPendingSend', reject as never);
    BridgeRegistry.register('noteSpamWarning', warn as never);
    render(MessageLoader);
    select('active');
    await waitFor(() => expect(BridgeRegistry.call('getActiveChannelId')).toBe('active'));
    return { reject, warn };
  }
  afterEach(() => { BridgeRegistry.unregister('rejectPendingSend'); BridgeRegistry.unregister('noteSpamWarning'); });

  it('maps rate / duplicate spam, slow mode and member timeout by ackId (or tmpId)', async () => {
    const { reject } = await activateForRejections();
    socket.fire('error:spam', { reason: 'spam_rate', remainingMs: 30_000, ackId: 'a-1' });
    socket.fire('error:spam', { reason: 'spam_muted', remainingMs: 12_000, tmpId: 't-2' });
    socket.fire('error:spam', { reason: 'spam_duplicate', remainingMs: 30_000, ackId: 'a-3' });
    socket.fire('error:slowmode', { remaining: 9, channelId: 'active', ackId: 'a-4' });
    socket.fire('error:timeout', { remaining: 120, ackId: 'a-5' });
    expect(reject.mock.calls).toEqual([
      ['a-1', 'rate', 30_000],
      ['t-2', 'rate', 12_000],
      ['a-3', 'duplicate', 30_000],
      ['a-4', 'slowmode', 9],
      ['a-5', 'timeout', 120],
    ]);
  });

  it('ignores rejections without a usable identity and forwards the delivered-but-warned case', async () => {
    const { reject, warn } = await activateForRejections();
    socket.fire('error:spam', { reason: 'spam_rate', remainingMs: 30_000 });
    socket.fire('error:spam', { reason: 'spam_rate', ackId: {} });
    socket.fire('error:slowmode', { remaining: 3 });
    socket.fire('error:timeout', {});
    socket.fire('error:spam', null);
    expect(reject).not.toHaveBeenCalled();
    socket.fire('warn:spam', { message: 'yavaşla', ackId: 'a-9' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
