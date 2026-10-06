import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { fireEvent } from '@testing-library/svelte';
import { flushSync, mount, unmount } from 'svelte';
import MessageListPanel from '../js/core/MessageListPanel.svelte';
import type { MessageData } from '../js/core/MessageRenderer.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.js';
import { resetMessageOperationSyncForTests } from '../js/core/local-first/message-operation-sync.ts';

const registryKeys = [
  'getMessages', 'getMessagesLoading', 'getMessagesError', 'getMessagesHasMore',
  'getCurrentChannel', 'getMe', 'loadMessages', 'loadOlderMessages',
  'jumpToMessage', 'retrySend', 'setReplyTarget', 'startEditMessage',
  'deleteMessage', 'saveForLater', 'socket',
];

function makeMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    _id: 'm-1',
    userId: 'u-1',
    displayName: 'Ada',
    content: 'Bridge message',
    createdAt: 1_754_000_000_000,
    channelId: 'ch-1',
    ...overrides,
  };
}

describe('MessageListPanel deep state and lifecycle behavior', () => {
  let messages: MessageData[];
  let loading: boolean;
  let error: string;
  let hasMore: boolean;
  let currentChannel: { _id: string } | null;
  let me: { _id?: string; id?: string } | null;
  let host: HTMLDivElement;
  let instance: ReturnType<typeof mount> | null;
  let loadOlder: ReturnType<typeof vi.fn>;

  function registerBase(): void {
    BridgeRegistry.register('getMessages', () => messages);
    BridgeRegistry.register('getMessagesLoading', () => loading);
    BridgeRegistry.register('getMessagesError', () => error);
    BridgeRegistry.register('getMessagesHasMore', () => hasMore);
    BridgeRegistry.register('getCurrentChannel', () => currentChannel);
    BridgeRegistry.register('getMe', () => me);
    BridgeRegistry.register('loadMessages', vi.fn());
    BridgeRegistry.register('loadOlderMessages', loadOlder);
  }

  function mountList(): void {
    host = document.createElement('div');
    host.id = 'messages-area';
    document.body.appendChild(host);
    instance = mount(MessageListPanel, { target: host });
    flushSync();
  }

  beforeEach(() => {
    for (const key of registryKeys) BridgeRegistry.unregister(key);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    messages = [];
    loading = false;
    error = '';
    hasMore = false;
    currentChannel = { _id: 'ch-1' };
    me = { _id: 'u-me' };
    instance = null;
    loadOlder = vi.fn(async () => undefined);
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    resetMessageOperationSyncForTests();
    registerBase();
  });

  afterEach(async () => {
    if (instance) await unmount(instance);
    resetMessageOperationSyncForTests();
    for (const key of registryKeys) BridgeRegistry.unregister(key);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('recognizes the supported id-only user shape and delegates owned-message actions', async () => {
    me = { id: 'u-me' };
    messages = [
      makeMessage({ _id: 'owned', userId: 'u-me' }),
      makeMessage({ _id: 'failed', userId: 'u-me', failed: true, ackId: 'ack-1' }),
    ];
    const reply = vi.fn();
    const edit = vi.fn();
    const remove = vi.fn();
    const save = vi.fn();
    const retry = vi.fn();
    const emit = vi.fn();
    BridgeRegistry.register('setReplyTarget', reply);
    BridgeRegistry.register('startEditMessage', edit);
    BridgeRegistry.register('deleteMessage', remove);
    BridgeRegistry.register('saveForLater', save);
    BridgeRegistry.register('retrySend', retry);
    BridgeRegistry.register('socket', { emit } as never);

    mountList();
    const owned = host.querySelector<HTMLElement>('[data-id="owned"]')!;
    await fireEvent.click(owned.querySelector('[aria-label="Yanıtla"]')!);
    await fireEvent.click(owned.querySelector('[aria-label="Düzenle"]')!);
    await fireEvent.click(owned.querySelector('[aria-label="Sil"]')!);
    await fireEvent.click(owned.querySelector(`[aria-label="${t('msg_action_save')}"]`)!);
    await fireEvent.click(owned.querySelector('[aria-label="Tepki ekle"]')!);
    flushSync();
    await fireEvent.click(owned.querySelector('.msg-emoji-row button')!);
    await fireEvent.click(host.querySelector('[data-id="failed"] button')!);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ _id: 'owned' }));
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ _id: 'owned' }));
    expect(remove).toHaveBeenCalledWith('owned');
    expect(save).toHaveBeenCalledWith({ destinationType: 'channel', destinationId: 'ch-1', messageId: 'owned' });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(
      'message:react',
      expect.objectContaining({
        messageId: 'owned',
        channelId: 'ch-1',
        active: true,
        clientNonce: expect.any(String),
      }),
    ));
    expect(retry).toHaveBeenCalledWith('ack-1');
  });

  it('fails closed when a save races with channel removal and tolerates a missing socket owner', async () => {
    messages = [makeMessage({ _id: 'race', channelId: undefined })];
    const save = vi.fn();
    const emit = vi.fn();
    BridgeRegistry.register('saveForLater', save);
    BridgeRegistry.register('socket', { emit } as never);
    mountList();

    currentChannel = null;
    const article = host.querySelector<HTMLElement>('[data-id="race"]')!;
    await fireEvent.click(article.querySelector(`[aria-label="${t('msg_action_save')}"]`)!);
    BridgeRegistry.unregister('socket');
    await fireEvent.click(article.querySelector('[aria-label="Tepki ekle"]')!);
    flushSync();
    await expect(fireEvent.click(article.querySelector('.msg-emoji-row button')!)).resolves.toBe(true);

    expect(save).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps grouping boundaries for systems, replies, missing authors, and expired windows', () => {
    const start = 1_754_000_000_000;
    messages = [
      makeMessage({ _id: 'a', userId: 'u-1', createdAt: start }),
      makeMessage({ _id: 'different', userId: 'u-2', createdAt: start + 1 }),
      makeMessage({ _id: 'compact', userId: 'u-2', createdAt: start + 2 }),
      makeMessage({ _id: 'system', userId: 'u-2', type: 'system', createdAt: start + 3 }),
      makeMessage({ _id: 'after-system', userId: 'u-2', createdAt: start + 4 }),
      makeMessage({ _id: 'reply', userId: 'u-2', createdAt: start + 5, replyTo: { _id: 'a', content: 'a' } }),
      makeMessage({ _id: 'anonymous', userId: '', createdAt: start + 6 }),
      makeMessage({ _id: 'expired', userId: '', createdAt: start + 5 * 60_000 + 7 }),
    ];
    mountList();

    expect(host.querySelector('[data-id="different"]')).not.toHaveClass('msg-compact');
    expect(host.querySelector('[data-id="compact"]')).toHaveClass('msg-compact');
    expect(host.querySelector('[data-id="after-system"]')).not.toHaveClass('msg-compact');
    expect(host.querySelector('[data-id="reply"]')).not.toHaveClass('msg-compact');
    expect(host.querySelector('[data-id="anonymous"]')).not.toHaveClass('msg-compact');
    expect(host.querySelector('[data-id="expired"]')).not.toHaveClass('msg-compact');
  });

  it('contains synchronous pagination failures, releases the lock, and allows retry', async () => {
    const failure = new Error('page unavailable');
    loadOlder.mockImplementationOnce(() => { throw failure; }).mockResolvedValueOnce(undefined);
    messages = [makeMessage()];
    hasMore = true;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mountList();
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 300 },
    });

    await Promise.resolve(); // drain the initial stick-to-bottom microtask
    host.scrollTop = 0;
    host.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('[MessageListPanel]', 'Eski mesaj sayfası yüklenemedi', failure));
    await Promise.resolve(); // allow the finally block to release the lock
    host.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(2));
  });

  it('coalesces concurrent older-page requests and preserves the scroll anchor', async () => {
    let resolvePage!: () => void;
    const page = new Promise<void>((resolve) => { resolvePage = resolve; });
    loadOlder.mockReturnValue(page);
    messages = [makeMessage()];
    hasMore = true;
    let scrollHeight = 800;
    mountList();
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 300 },
    });
    await Promise.resolve(); // drain the initial stick-to-bottom microtask
    host.scrollTop = 10;

    host.dispatchEvent(new Event('scroll'));
    host.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(loadOlder).toHaveBeenCalledOnce());
    scrollHeight = 1000;
    resolvePage();
    await vi.waitFor(() => expect(host.scrollTop).toBe(210));
  });

  it('retries a pending reply jump when the target arrives and clears its highlight timer', async () => {
    vi.useFakeTimers();
    const clearTimer = vi.spyOn(window, 'clearTimeout');
    messages = [makeMessage({ _id: 'existing' })];
    mountList();
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');

    BridgeRegistry.call('jumpToMessage', 'late');
    messages = [...messages, makeMessage({ _id: 'late', userId: 'u-2' })];
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
    await Promise.resolve();
    flushSync();
    await Promise.resolve();

    const late = host.querySelector<HTMLElement>('[data-id="late"]')!;
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(late).toHaveClass('msg-jump-highlight');
    BridgeRegistry.call('jumpToMessage', 'late');
    expect(clearTimer).toHaveBeenCalled();
    vi.advanceTimersByTime(1600);
    expect(late).not.toHaveClass('msg-jump-highlight');
  });

  it('implements one-tab-stop arrow, Home, and End navigation without stealing child focus', async () => {
    messages = [
      makeMessage({ _id: 'm-1', userId: 'u-1' }),
      makeMessage({ _id: 'm-2', userId: 'u-2' }),
      makeMessage({ _id: 'm-3', userId: 'u-3' }),
    ];
    mountList();
    const articles = [...host.querySelectorAll<HTMLElement>('article.msg')];
    expect(articles.map((article) => article.tabIndex)).toEqual([-1, -1, 0]);

    articles[2].focus();
    await fireEvent.keyDown(articles[2], { key: 'ArrowUp' });
    await Promise.resolve();
    flushSync();
    expect(document.activeElement).toBe(articles[1]);

    await fireEvent.keyDown(articles[1], { key: 'Home' });
    await Promise.resolve();
    expect(document.activeElement).toBe(articles[0]);

    await fireEvent.keyDown(articles[0], { key: 'End' });
    await Promise.resolve();
    expect(document.activeElement).toBe(articles[2]);

    await fireEvent.keyDown(articles[2], { key: 'ArrowDown' });
    await Promise.resolve();
    expect(document.activeElement).toBe(articles[2]);
    await fireEvent.keyDown(articles[2], { key: 'PageDown' });
    expect(document.activeElement).toBe(articles[2]);

    const reply = articles[2].querySelector<HTMLButtonElement>('[aria-label="Yanıtla"]')!;
    reply.focus();
    await fireEvent.keyDown(reply, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(reply);
  });

  it('resynchronizes from the channel-selected event and maintains the welcome owner', () => {
    const welcome = document.createElement('div');
    welcome.id = 'ch-welcome';
    document.body.appendChild(welcome);
    currentChannel = null;
    messages = [makeMessage()];
    mountList();
    expect(welcome.style.display).toBe('');
    expect(host.querySelector('[data-id="m-1"]')).not.toBeInTheDocument();

    currentChannel = { _id: 'ch-1' };
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    flushSync();
    expect(welcome.style.display).toBe('none');
    expect(host.querySelector('[data-id="m-1"]')).toBeInTheDocument();
  });

  it('uses the scrollTop fallback when smooth scrolling is unavailable', async () => {
    messages = [makeMessage()];
    mountList();
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTo: { configurable: true, value: undefined },
    });
    host.scrollTop = 100;
    host.dispatchEvent(new Event('scroll'));
    flushSync();

    await fireEvent.click(host.querySelector('.jump-latest')!);
    expect(host.scrollTop).toBe(1000);
  });

  it('does not force-scroll an updated list while the reader is away from the bottom', async () => {
    messages = [
      makeMessage({ _id: 'parent', content: 'Loaded parent' }),
      makeMessage({ _id: 'snapshot', userId: 'u-2', replyTo: { _id: 'missing', content: 'Stored snapshot' } }),
    ];
    mountList();
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 300 },
    });
    await Promise.resolve();
    host.scrollTop = 100;
    host.dispatchEvent(new Event('scroll'));
    expect(host.querySelector('[data-id="snapshot"] [data-reply-state="snapshot"]')).toHaveTextContent('Stored snapshot');

    messages = [...messages, makeMessage({ _id: 'new', userId: 'u-3' })];
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
    await Promise.resolve();
    flushSync();
    expect(host.scrollTop).toBe(100);
  });

  it('selects reduced-motion and default smooth jump behavior when media-query support changes', async () => {
    messages = [makeMessage()];
    mountList();
    const scrollTo = vi.fn();
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    await Promise.resolve();

    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    host.scrollTop = 100;
    host.dispatchEvent(new Event('scroll'));
    flushSync();
    await fireEvent.click(host.querySelector('.jump-latest')!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' });

    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: undefined });
    host.scrollTop = 100;
    host.dispatchEvent(new Event('scroll'));
    flushSync();
    await fireEvent.click(host.querySelector('.jump-latest')!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'smooth' });
  });

  it('does not mutate a relinquished scroller when an older-page request resolves after unmount', async () => {
    let resolvePage!: () => void;
    loadOlder.mockReturnValue(new Promise<void>((resolve) => { resolvePage = resolve; }));
    messages = [makeMessage()];
    hasMore = true;
    mountList();
    let scrollHeight = 800;
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 300 },
    });
    await Promise.resolve();
    host.scrollTop = 0;
    host.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(loadOlder).toHaveBeenCalledOnce());
    await unmount(instance!);
    instance = null;

    scrollHeight = 1000;
    resolvePage();
    await Promise.resolve();
    await Promise.resolve();
    expect(BridgeRegistry.has('jumpToMessage')).toBe(false);
    expect(host.scrollTop).toBe(0);
  });

  it('uses safe empty defaults when registry owners are unavailable', async () => {
    if (instance) await unmount(instance);
    instance = null;
    for (const key of registryKeys) BridgeRegistry.unregister(key);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const welcome = document.createElement('div');
    welcome.id = 'ch-welcome';
    document.body.appendChild(welcome);
    mountList();

    expect(host.querySelector('[role="log"]')).toHaveAttribute('aria-busy', 'false');
    expect(host.querySelector('article')).not.toBeInTheDocument();
    expect(welcome.style.display).toBe('');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('getMessages'));
  });

  // Final21 UX (U-11): sıradaki (yerel zamanlı) mesaj, ondan önce yazılıp SONRA teslim edilen
  // (sunucu zamanlı) mesajların ÜSTÜNDE kalıyordu (ölçüldü). Teslim edilmemişler hep en altta.
  it('renders undelivered rows after every delivered row, each group in its own order', () => {
    messages = [
      makeMessage({ _id: 'a', content: 'A', createdAt: 100 }),
      makeMessage({ _id: 'pending:b', content: 'B', createdAt: 50, pending: true, queued: true }),
      makeMessage({ _id: 'c', content: 'C', createdAt: 200 }),
      makeMessage({ _id: 'pending:d', content: 'D', createdAt: 60, failed: true }),
    ];
    mountList();
    expect([...host.querySelectorAll('article.msg')].map((a) => a.getAttribute('data-id'))).toEqual(['a', 'c', 'pending:b', 'pending:d']);
  });

  it('a failed row\'s "Sil" discards through the composer owner', () => {
    const discard = vi.fn();
    BridgeRegistry.register('discardSend', discard);
    me = { _id: 'u-me' };
    messages = [makeMessage({ _id: 'pending:x', userId: 'u-me', failed: true, ackId: 'ack-x' })];
    mountList();
    (host.querySelector<HTMLButtonElement>('.msg-delivery-discard'))!.click();
    expect(discard).toHaveBeenCalledWith('ack-x');
    BridgeRegistry.unregister('discardSend');
  });

  // Final21 UX (U-06): yeni sunucu kuran ve orada TEK başına olan kullanıcıya boş kanal,
  // "ilk mesajı sen gönder" yerine asıl sonraki adımı (davet) sunar.
  describe('empty channel in a single-member server', () => {
    let members: Array<{ _id: string }>;
    let invite: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      members = [{ _id: 'u-me' }];
      invite = vi.fn();
      BridgeRegistry.register('getCurrentServerMembers', () => members);
      BridgeRegistry.register('openInvitePanel', invite);
    });
    afterEach(() => {
      BridgeRegistry.unregister('getCurrentServerMembers');
      BridgeRegistry.unregister('openInvitePanel');
    });

    it('offers the invite and opens the canonical invite panel', () => {
      mountList();
      const cta = host.querySelector<HTMLButtonElement>('.msg-state-cta');
      expect(cta?.textContent).toBe('Arkadaşlarını davet et');
      expect(host.querySelector('.msg-state-empty')?.textContent).toMatch(/şimdilik yalnızsın/);
      cta!.click();
      expect(invite).toHaveBeenCalledTimes(1);
    });

    it('keeps the plain empty state once someone else is in the server (members event)', () => {
      mountList();
      expect(host.querySelector('.msg-state-cta')).not.toBeNull();
      members = [{ _id: 'u-me' }, { _id: 'u-2' }];
      document.dispatchEvent(new CustomEvent('bridge:members-updated', { detail: { serverId: 's' } }));
      flushSync();
      expect(host.querySelector('.msg-state-cta')).toBeNull();
      expect(host.querySelector('.msg-state-empty')?.textContent).toMatch(/ilk mesajı sen gönder/);
    });

    it('no invite owner, no dead button', () => {
      BridgeRegistry.unregister('openInvitePanel');
      mountList();
      expect(host.querySelector('.msg-state-cta')).toBeNull();
    });
  });
});
