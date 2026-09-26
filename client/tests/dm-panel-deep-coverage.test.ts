import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { t } from '../js/core/i18n/index.ts';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DmPanel from '../js/core/DmPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

type Handler = (payload: unknown) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSocket() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  return {
    sent,
    on(event: string, fn: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    off(event: string, fn: Handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== fn));
    },
    emit(event: string, payload: unknown) { sent.push({ event, payload }); },
    fire(event: string, payload: unknown) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
    },
    count(event: string) { return handlers.get(event)?.length ?? 0; },
  };
}

const conversations = [
  {
    _id: 'row-a', dmId: 'dm-a', unreadCount: 123,
    other: { _id: 'user-a', displayName: 'Ada Lovelace', avatarColor: '#123456' },
    lastMessage: { content: 'A son mesaj' },
  },
  {
    _id: 'row-b', dmId: 'dm-b', unreadCount: 0,
    other: { _id: 'user-b', username: 'grace' },
  },
];

const ownedKeys = [
  'apiFetch', 'socket', 'getMe', 'recordNavigationLocation', 'toast',
  'saveForLater', 'showFriendsPanel', 'startDmCall',
  'showDmPanel', 'openDmPanel', 'getDmConversations', 'openDm', 'closeDmPanel',
];

let socket: ReturnType<typeof makeSocket>;
let apiFetch: ReturnType<typeof vi.fn>;

function install(api: (...args: unknown[]) => Promise<Response>): void {
  apiFetch = vi.fn(api);
  socket = makeSocket();
  BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
  BridgeRegistry.register('getMe', () => ({ id: 'me', displayName: 'Ben' }));
}

function defaultApi(urlValue: unknown): Promise<Response> {
  const url = String(urlValue);
  if (url.endsWith('/api/dm')) return Promise.resolve(json(conversations));
  if (url.includes('/dm-a/messages')) {
    return Promise.resolve(json([{ _id: 'a-1', dmId: 'dm-a', userId: 'user-a', displayName: 'Ada', content: 'A geçmişi' }]));
  }
  if (url.includes('/dm-b/messages')) {
    return Promise.resolve(json([{ _id: 'b-1', dmId: 'dm-b', userId: 'user-b', displayName: 'Grace', content: 'B geçmişi' }]));
  }
  return Promise.resolve(json({ _id: 'created', dmId: 'dm-created', other: { _id: 'new-user', displayName: 'Yeni' } }));
}

beforeEach(() => {
  document.body.innerHTML = '<button data-bridge-action="showDmPanel" aria-label="Direkt mesajları aç"></button>';
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  if (!globalThis.CSS) Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });
  Object.defineProperty(globalThis.CSS, 'escape', { configurable: true, value: (value: string) => value });
});

afterEach(() => {
  cleanup();
  for (const key of ownedKeys) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DmPanel — async privacy and trust boundaries', () => {
  it('contains a missing API owner and follows socket absence, replacement, and removal', async () => {
    apiFetch = vi.fn(defaultApi);
    BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
    BridgeRegistry.register('getMe', () => ({ id: 'me' }));
    const view = render(DmPanel);
    await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(2));

    const firstSocket = makeSocket();
    const secondSocket = makeSocket();
    BridgeRegistry.register('socket', firstSocket as unknown as AnyFn);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(firstSocket.count('dm:message')).toBe(1);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(firstSocket.count('dm:message')).toBe(1);

    BridgeRegistry.register('socket', secondSocket as unknown as AnyFn);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(firstSocket.count('dm:message')).toBe(0);
    expect(secondSocket.count('dm:message')).toBe(1);

    BridgeRegistry.unregister('socket');
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(secondSocket.count('dm:message')).toBe(0);
    view.unmount();

    BridgeRegistry.unregister('apiFetch');
    const missing = render(DmPanel);
    BridgeRegistry.call('showDmPanel');
    // API sahibi yoksa istek hic gonderilmez; hata `Error(...)` olarak
    // siniflandirilamayan bir durumdur ve cagiranin kanonik yedek metni
    // gosterilir.
    await waitFor(() => expect(missing.getByRole('alert')).toHaveTextContent(t('dm_list_load_failed')));
  });

  it('a late history response cannot replace the newer active conversation', async () => {
    const oldHistory = deferred<Response>();
    install(async (urlValue) => {
      const url = String(urlValue);
      if (url.endsWith('/api/dm')) return json(conversations);
      if (url.includes('/dm-a/messages')) return oldHistory.promise;
      if (url.includes('/dm-b/messages')) return json([
        { _id: 'b-live', dmId: 'dm-b', userId: 'user-b', displayName: 'Grace', content: 'Yeni hedef' },
      ]);
      return defaultApi(urlValue);
    });
    const record = vi.fn();
    BridgeRegistry.register('recordNavigationLocation', record);
    const view = render(DmPanel);
    await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(2));

    const first = BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a')!;
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/dm-a/messages'), undefined));
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'user-b')).resolves.toBe(true);
    expect(view.container).toHaveTextContent('Yeni hedef');

    oldHistory.resolve(json([
      { _id: 'a-stale', dmId: 'dm-a', userId: 'user-a', displayName: 'Ada', content: 'ÖZEL BAYAT İÇERİK' },
    ]));
    await expect(first).resolves.toBe(false);
    await tick();

    expect(view.container).toHaveTextContent('Grace');
    expect(view.container).toHaveTextContent('Yeni hedef');
    expect(view.container).not.toHaveTextContent('ÖZEL BAYAT İÇERİK');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ _id: 'user-b' }) }));
  });

  it('logout invalidates an in-flight list response instead of restoring the previous account', async () => {
    const list = deferred<Response>();
    install(async (urlValue) => String(urlValue).endsWith('/api/dm') ? list.promise : defaultApi(urlValue));
    render(DmPanel);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    list.resolve(json(conversations));
    await tick();
    await tick();

    expect(BridgeRegistry.call('getDmConversations')).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('logout also invalidates list JSON and rejection stages', async () => {
    const body = deferred<unknown>();
    const parse = vi.fn(() => body.promise);
    install(async () => ({ ok: true, status: 200, json: parse } as Response));
    const firstView = render(DmPanel);
    await waitFor(() => expect(parse).toHaveBeenCalled());
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    body.resolve(conversations);
    await tick();
    await tick();
    expect(BridgeRegistry.call('getDmConversations')).toEqual([]);
    firstView.unmount();

    const failure = deferred<Response>();
    install(() => failure.promise);
    render(DmPanel);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    failure.reject(new Error('late private failure'));
    await tick();
    await tick();
    expect(BridgeRegistry.call('getDmConversations')).toEqual([]);
  });

  it('rejects stale create responses both before and after JSON parsing', async () => {
    const oldResponse = deferred<Response>();
    install(async (urlValue) => {
      const url = String(urlValue);
      if (url.endsWith('/api/dm')) return json([]);
      if (url.endsWith('/user-a')) return oldResponse.promise;
      if (url.endsWith('/user-b')) return json({ _id: 'new-b', dmId: 'new-b', other: { _id: 'user-b', displayName: 'Grace' } });
      if (url.includes('/new-b/messages')) return json([]);
      return json([]);
    });
    const view = render(DmPanel);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const first = BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a')!;
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/user-a'), { method: 'POST' }));
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'user-b')).resolves.toBe(true);
    oldResponse.resolve(json({ _id: 'old-a', dmId: 'old-a', other: { _id: 'user-a' } }));
    await expect(first).resolves.toBe(false);
    expect(view.container).toHaveTextContent('Grace');
    view.unmount();

    const oldBody = deferred<unknown>();
    const parseOld = vi.fn(() => oldBody.promise);
    install(async (urlValue) => {
      const url = String(urlValue);
      if (url.endsWith('/api/dm')) return json([]);
      if (url.endsWith('/user-a')) return { ok: true, status: 200, json: parseOld } as Response;
      if (url.endsWith('/user-b')) return json({ _id: 'json-b', dmId: 'json-b', other: { _id: 'user-b', displayName: 'Grace JSON' } });
      if (url.includes('/json-b/messages')) return json([]);
      return json([]);
    });
    const secondView = render(DmPanel);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const parsing = BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a')!;
    await waitFor(() => expect(parseOld).toHaveBeenCalled());
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'user-b')).resolves.toBe(true);
    oldBody.resolve({ _id: 'json-a', dmId: 'json-a', other: { _id: 'user-a' } });
    await expect(parsing).resolves.toBe(false);
    expect(secondView.container).toHaveTextContent('Grace JSON');
  });

  it('close invalidates a pending open and never resurrects the private shell', async () => {
    const history = deferred<Response>();
    install(async (urlValue) => {
      const url = String(urlValue);
      if (url.endsWith('/api/dm')) return json(conversations);
      if (url.includes('/dm-a/messages')) return history.promise;
      return defaultApi(urlValue);
    });
    render(DmPanel);
    await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(2));
    const opening = BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a')!;
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/dm-a/messages'), undefined));

    BridgeRegistry.call('closeDmPanel');
    history.resolve(json([{ _id: 'secret', dmId: 'dm-a', userId: 'user-a', content: 'secret' }]));
    await expect(opening).resolves.toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('rejects malformed socket payloads and handles inactive/active delivery without duplication', async () => {
    install(defaultApi);
    const view = render(DmPanel);
    await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(2));
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a')).resolves.toBe(true);

    expect(() => socket.fire('dm:message', null)).not.toThrow();
    expect(() => socket.fire('dm:message', { dmId: 'dm-a', userId: 'user-a', content: 'id yok' })).not.toThrow();
    expect(view.container).not.toHaveTextContent('id yok');

    socket.fire('dm:message', { _id: 'elsewhere', dmId: 'dm-b', userId: 'user-b', content: 'başka konuşma' });
    await tick();
    expect(document.querySelector('.h-unread')).toHaveTextContent('1');
    expect(view.container).not.toHaveTextContent('başka konuşma');

    const textarea = view.getByRole('textbox', { name: 'DM mesajı' });
    await fireEvent.input(textarea, { target: { value: 'aynı içerik' } });
    await fireEvent.submit(view.container.querySelector('form')!);
    socket.fire('dm:message', {
      _id: 'server-copy', dmId: 'dm-a', userId: 'me', displayName: 'Ben', content: 'aynı içerik', createdAt: Date.now(),
    });
    socket.fire('dm:message', {
      _id: 'incoming', dmId: 'dm-a', userId: 'user-a', displayName: 'Ada', content: '<img src=x onerror=alert(1)>',
    });
    await tick();

    expect(view.container.querySelectorAll('.dm-message')).toHaveLength(3);
    expect(view.container.querySelectorAll('.dm-message p')).toHaveLength(3);
    expect(view.container.querySelector('.dm-message img')).toBeNull();
    expect(socket.sent).toContainEqual({ event: 'dm:read', payload: { dmId: 'dm-a' } });
  });

  it('rejects every malformed message field and maintains the shell badge without a mounted button', async () => {
    document.body.innerHTML = '';
    install(defaultApi);
    const view = render(DmPanel);
    await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(2));

    const invalid = [
      {},
      { _id: '', dmId: 'dm-a', userId: 'user-a', content: 'x' },
      { _id: 'x', userId: 'user-a', content: 'x' },
      { _id: 'x', dmId: '', userId: 'user-a', content: 'x' },
      { _id: 'x', dmId: 'dm-a', content: 'x' },
      { _id: 'x', dmId: 'dm-a', userId: '', content: 'x' },
      { _id: 'x', dmId: 'dm-a', userId: 'user-a', content: 42 },
    ];
    for (const payload of invalid) expect(() => socket.fire('dm:message', payload)).not.toThrow();
    expect(view.container.querySelectorAll('.dm-message')).toHaveLength(0);

    for (let index = 0; index < 10; index += 1) {
      socket.fire('dm:message', { _id: `other-${index}`, dmId: 'dm-b', userId: 'user-b', content: `m${index}` });
    }
    await tick();
    expect(document.querySelector('.h-unread')).toBeNull();
    view.unmount();

    const button = document.createElement('button');
    button.dataset.bridgeAction = 'showDmPanel';
    document.body.appendChild(button);
    render(DmPanel);
    await waitFor(() => expect(socket.count('dm:message')).toBe(1));
    for (let index = 0; index < 10; index += 1) {
      socket.fire('dm:message', { _id: `badge-${index}`, dmId: 'dm-b', userId: 'user-b', content: `badge ${index}` });
    }
    await tick();
    expect(button.querySelector('.h-unread')).toHaveTextContent('9+');

    BridgeRegistry.register('getMe', () => ({ _id: 'self-alt' }));
    socket.fire('dm:message', { _id: 'self', dmId: 'dm-b', userId: 'self-alt', content: 'own' });
    await tick();
    expect(button.getAttribute('aria-label')).toContain('10 yeni mesaj');
    BridgeRegistry.call('openDmPanel');
    await waitFor(() => expect(button.querySelector('.h-unread')).toBeNull());
    expect(button).toHaveAttribute('aria-label', 'Direkt mesajları aç');
  });
});

describe('DmPanel — failure, navigation, and UI behavior', () => {
  it.each([
    // Panel artik `safeApiErrorMessage` kullanir: durum kodu KULLANICIYA
    // GOSTERILMEZ ama hata TURU (sunucu / gecersiz veri / siniflandirilamaz)
    // ayirt edilebilir kalir.
    ['HTTP list failure', async () => json({ error: 'secret server detail' }, 500), () => t('error_server')],
    ['malformed list', async () => json({ conversations: [] }), () => t('dm_list_load_failed')],
    ['non-Error rejection', async () => Promise.reject('broken'), () => t('dm_list_load_failed')],
  ])('%s stays inside the panel with a safe error', async (_name, implementation, expected) => {
    install(implementation);
    const view = render(DmPanel);
    BridgeRegistry.call('showDmPanel');
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(expected()));
    expect(view.container).not.toHaveTextContent('secret server detail');
    expect(view.container).not.toHaveTextContent('500');
  });

  it('reports create/history failures and supplies a safe fallback user for valid create responses', async () => {
    let mode: 'create-denied' | 'history-invalid' | 'success' = 'create-denied';
    install(async (urlValue) => {
      const url = String(urlValue);
      if (url.endsWith('/api/dm')) return json([]);
      if (!url.includes('/messages')) {
        if (mode === 'create-denied') return json({}, 403);
        return json({ _id: 'created', dmId: 'dm-created' });
      }
      if (mode === 'history-invalid') return json({ messages: [] });
      return json([]);
    });
    const view = render(DmPanel);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'new-user', 'Yeni')).resolves.toBe(false);
    expect(view.getByRole('alert')).toHaveTextContent(/başlatılamadı/);

    mode = 'history-invalid';
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'new-user', 'Yeni', 'missing')).resolves.toBe(false);
    expect(view.getByRole('alert')).toHaveTextContent(/açılamadı/);

    mode = 'success';
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'new-user', 'Yeni')).resolves.toBe(true);
    expect(view.container).toHaveTextContent('Yeni');
  });

  it('removes an inaccessible history shell and ignores history JSON after close', async () => {
    const historyBody = deferred<unknown>();
    const parseHistory = vi.fn(() => historyBody.promise);
    let mode: 'gone' | 'delayed' = 'gone';
    install(async (urlValue) => {
      const url = String(urlValue);
      if (url.endsWith('/api/dm')) return json(conversations);
      if (url.includes('/dm-a/messages')) {
        if (mode === 'gone') return json({}, 410);
        return { ok: true, status: 200, json: parseHistory } as Response;
      }
      return defaultApi(urlValue);
    });
    const view = render(DmPanel);
    await waitFor(() => expect(BridgeRegistry.call<unknown[]>('getDmConversations')).toHaveLength(2));
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a')).resolves.toBe(false);
    expect(view.getByRole('alert')).toHaveTextContent('artık kullanılamıyor');
    expect(view.container.querySelector('.dm-chat-header')).toBeNull();

    mode = 'delayed';
    const opening = BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a')!;
    await waitFor(() => expect(parseHistory).toHaveBeenCalled());
    BridgeRegistry.call('closeDmPanel');
    historyBody.resolve([{ _id: 'private-late', dmId: 'dm-a', userId: 'user-a', content: 'late' }]);
    await expect(opening).resolves.toBe(false);
    expect(view.container).not.toHaveTextContent('late');
  });

  it('covers fallback identities, local conversation ids, composer guards, and reduced-motion jumps', async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const localConversation = [{
      _id: 'local-only', unreadCount: 3, lastMessage: null,
      other: { _id: 'fallback-user' },
    }];
    install(async (urlValue) => {
      const url = String(urlValue);
      if (url.endsWith('/api/dm')) return json(localConversation);
      if (url.includes('/local-only/messages')) return json([
        { _id: 'fallback-message', userId: 'fallback-user', content: 'fallback body' },
      ]);
      return json([]);
    });
    BridgeRegistry.unregister('getMe');
    const save = vi.fn();
    BridgeRegistry.register('saveForLater', save);
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    const view = render(DmPanel);
    await vi.runAllTimersAsync();
    BridgeRegistry.call('showDmPanel');
    await vi.runAllTimersAsync();
    expect(view.container.querySelector('.dm-unread')).toHaveAttribute('aria-label', '3 okunmamış mesaj');
    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'fallback-user', undefined, undefined, 'fallback-message')).resolves.toBe(true);
    await vi.runAllTimersAsync();

    expect(view.container).toHaveTextContent(t('ui_bridge_user'));
    expect(view.container).toHaveTextContent('?');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });

    const form = view.container.querySelector('form')!;
    await fireEvent.submit(form);
    const textarea = view.getByRole('textbox', { name: 'DM mesajı' });
    await fireEvent.input(textarea, { target: { value: 'x'.repeat(2001) } });
    await fireEvent.submit(form);
    expect(view.getByRole('alert')).toHaveTextContent('en fazla 2000');

    await fireEvent.input(textarea, { target: { value: 'fallback send' } });
    await fireEvent.submit(form);
    await fireEvent.submit(form);
    expect(view.container.querySelector('.dm-message.pending')).toHaveTextContent('Sen');
    expect(socket.sent).toContainEqual({ event: 'dm:send', payload: expect.objectContaining({ toUserId: 'fallback-user', content: 'fallback send', clientNonce: expect.any(String) }) });

    await fireEvent.click(view.getByRole('button', { name: t('msg_action_save') }));
    expect(save).toHaveBeenCalledWith({ destinationType: 'dm', destinationId: 'local-only', messageId: 'fallback-message' });
    await fireEvent.keyDown(window, { key: 'Enter' });
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('drives unread caps, friends/call/save actions, scrolling, and Escape from the real surface', async () => {
    vi.useFakeTimers();
    install(defaultApi);
    const friends = vi.fn();
    const call = vi.fn();
    const save = vi.fn();
    const toast = vi.fn();
    BridgeRegistry.register('showFriendsPanel', friends);
    BridgeRegistry.register('startDmCall', call);
    BridgeRegistry.register('saveForLater', save);
    BridgeRegistry.register('toast', toast);
    const view = render(DmPanel);
    await vi.runAllTimersAsync();
    BridgeRegistry.call('showDmPanel');
    await vi.runAllTimersAsync();
    await tick();

    expect(view.container).toHaveTextContent('99+');
    await fireEvent.click(view.getByRole('button', { name: /Arkadaşlar/ }));
    expect(friends).toHaveBeenCalled();
    // Arkadaslar paneline gecmek DM panelini KAPATIR (ozel yuzey kurali,
    // DmPanel.openFriends -> close()). Test eskiden kapanmis panelde
    // etkilesime devam etmeye calisiyordu.
    expect(view.container.querySelector('.dm-conversation')).toBeNull();
    BridgeRegistry.call('showDmPanel');
    await vi.runAllTimersAsync();
    await tick();

    await fireEvent.click(view.getByRole('button', { name: /Ada Lovelace/ }));
    await vi.runAllTimersAsync();
    await tick();

    await fireEvent.click(view.getByRole('button', { name: /sesli arama/ }));
    await fireEvent.click(view.getByRole('button', { name: /görüntülü arama/ }));
    expect(call).toHaveBeenNthCalledWith(1, 'user-a', 'voice');
    expect(call).toHaveBeenNthCalledWith(2, 'user-a', 'video');

    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true, value: scrollIntoView,
    });
    await fireEvent.click(view.getByRole('button', { name: t('msg_action_save') }));
    expect(save).toHaveBeenCalledWith({ destinationType: 'dm', destinationId: 'dm-a', messageId: 'a-1' });

    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a', undefined, undefined, 'a-1')).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });

    await expect(BridgeRegistry.call<Promise<boolean>>('openDm', 'user-a', undefined, undefined, 'not-loaded')).resolves.toBe(true);
    await vi.runAllTimersAsync();
    expect(toast).toHaveBeenCalledWith('Kaydedilen mesaj son geçmiş sayfasında değil.', 'warning');

    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('unmount removes the live socket listener and every public registry entry', async () => {
    install(defaultApi);
    const view = render(DmPanel);
    await waitFor(() => expect(socket.count('dm:message')).toBe(1));
    view.unmount();
    expect(socket.count('dm:message')).toBe(0);
    for (const key of ['showDmPanel', 'openDmPanel', 'getDmConversations', 'openDm', 'closeDmPanel']) {
      expect(BridgeRegistry.has(key)).toBe(false);
    }
  });
});
