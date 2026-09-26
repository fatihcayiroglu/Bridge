// Phase 9 — direct production messaging surface contracts.
import { t } from '../js/core/i18n/index.ts';
// These tests mount the active Svelte components; no archived renderer is used.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { flushSync, mount, unmount } from 'svelte';
import MessageRenderer, { type MessageData } from '../js/core/MessageRenderer.svelte';
import MessageListPanel from '../js/core/MessageListPanel.svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.js';

const registryKeys = [
  'getMessages', 'getMessagesLoading', 'getMessagesError', 'getMessagesHasMore',
  'getCurrentChannel', 'getCurrentServer', 'getMe', 'getSocketConnected', 'socket',
  'loadMessages', 'loadOlderMessages', 'appendMessage', 'updateMessage',
  'setDraft', 'getDraft', 'flushDraft', 'clearDraft', 'sendMessage',
  'setReplyTarget', 'startEditMessage', 'deleteMessage', 'retrySend',
  'resolvePendingSend', 'failPendingSend',
];

function message(overrides: Partial<MessageData> = {}): MessageData {
  return {
    _id: 'm-1', userId: 'u-1', displayName: 'Ada Lovelace',
    content: 'Merhaba Bridge', createdAt: 1_754_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});

afterEach(() => {
  for (const key of registryKeys) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
});

describe('MessageRenderer — Phase 9 presentation contracts', () => {
  it('renders a semantic article and machine-readable timestamp', () => {
    const view = render(MessageRenderer, { props: { message: message() } });
    const article = view.container.querySelector('article.msg');
    const time = view.container.querySelector('time.msg-time');
    expect(article).toHaveAttribute('data-delivery-state', 'sent');
    expect(article).toHaveAccessibleName(/Ada Lovelace/);
    expect(time).toHaveAttribute('datetime', new Date(1_754_000_000_000).toISOString());
    expect(time?.getAttribute('title')).toBeTruthy();
  });

  it('keeps compact messages aligned through the timestamp gutter', () => {
    const view = render(MessageRenderer, { props: { message: message(), compact: true } });
    expect(view.container.querySelector('.msg')).toHaveClass('msg-compact');
    expect(view.container.querySelector('time.msg-gutter')).toBeInTheDocument();
    expect(view.container.querySelector('.msg-avatar')).not.toBeInTheDocument();
  });

  it('uses labelled dependency-free action buttons with own-message ownership', () => {
    const onReply = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onSave = vi.fn();
    const view = render(MessageRenderer, {
      props: { message: message(), currentUserId: 'u-1', onReply, onEdit, onDelete, onSave },
    });
    const actions = view.container.querySelectorAll('.msg-actions button');
    // UX/P1 GUNCELLEMESI: eylem sayisi 3 -> 5. "Tepki ekle" ve kişisel
    // "Save for Later" eylemleri kalıcı mesajlarda erişilebilir olmalı.
    // Onceki hal urun kusuruydu: `MessageRenderer` tepki CIPLERINI zaten
    // render ediyordu ama kullanicinin tepki EKLEMESININ hicbir yolu yoktu
    // (`ReactionPicker`/`MessageReactions` uretim girisinden ERISILEMEZ).
    // Sunucudaki kanonik `message:react` olayi ise TAM olarak calisiyordu.
    expect(actions).toHaveLength(5);
    expect(view.getByRole('button', { name: 'Tepki ekle' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Yanıtla' }).querySelector('svg')).toBeInTheDocument();
    void fireEvent.click(view.getByRole('button', { name: t('msg_action_save') }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm-1' }));
    void fireEvent.click(view.getByRole('button', { name: 'Düzenle' }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it('preserves jumpable, snapshot, and deleted reply states', async () => {
    const source = { content: 'Güncel içerik', displayName: 'Grace' };
    const onJump = vi.fn();
    const base = message({ replyTo: { _id: 'parent', displayName: 'Eski', content: 'Eski içerik' } });
    const view = render(MessageRenderer, { props: { message: base, replySource: source, onJumpToReply: onJump } });
    expect(view.container.querySelector('[data-reply-state="jumpable"]')).toHaveTextContent('Güncel içerik');
    await fireEvent.click(view.getByRole('button', { name: /Grace/ }));
    expect(onJump).toHaveBeenCalledWith('parent');

    await view.rerender({ message: base, replySource: null, onJumpToReply: onJump });
    expect(view.container.querySelector('[data-reply-state="snapshot"]')).toBeInTheDocument();

    await view.rerender({ message: { ...base, replyTo: { ...base.replyTo!, deleted: true } }, replySource: null, onJumpToReply: onJump });
    expect(view.container.querySelector('[data-reply-state="deleted"]')).toHaveTextContent(/orijinal mesaj silindi/i);
  });

  it.each([
    ['image/png', 'img.msg-image'],
    ['video/mp4', 'video.msg-video'],
    ['audio/mpeg', 'audio.msg-audio'],
    ['application/pdf', 'a.msg-file'],
  ])('renders safe %s attachments with the correct media surface', (fileType, selector) => {
    const view = render(MessageRenderer, {
      props: { message: message({ fileUrl: '/uploads/example', fileName: 'example', fileType }) },
    });
    expect(view.container.querySelector(selector)).toBeInTheDocument();
    if (fileType === 'image/png') expect(view.container.querySelector('img')).toHaveAttribute('loading', 'lazy');
    if (fileType.startsWith('video/') || fileType.startsWith('audio/')) {
      expect(view.container.querySelector(selector)).toHaveAttribute('preload', 'metadata');
    }
  });

  it('rejects unsafe attachment schemes and keeps user content escaped', () => {
    const view = render(MessageRenderer, {
      props: { message: message({ content: '<img src=x onerror=alert(1)>', fileUrl: 'javascript:alert(1)', fileType: 'image/png', avatarColor: 'red;background:url(https://attacker.invalid/x)' }) },
    });
    expect(view.container.querySelector('.msg-attachment')).not.toBeInTheDocument();
    expect(view.container.querySelector('.msg-content')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(view.container.querySelector('.msg-content img')).not.toBeInTheDocument();
    expect(view.container.querySelector('.msg-avatar')?.getAttribute('style')).not.toContain('url(');
  });

  it('renders reactions as INTERACTIVE pills and exposes stable pending/failed retry states', async () => {
    const onRetry = vi.fn();
    const view = render(MessageRenderer, {
      props: { message: message({ reactions: { '🌉': ['u-1', 'u-2'] }, pending: true, ackId: 'ack-1' }), onRetry },
    });
    expect(view.container.querySelector('.msg-reaction')).toHaveTextContent('🌉2');
    // UX/P1 GUNCELLEMESI: cipler artik PASIF DEGIL. Discord'da bir tepki cipine
    // tiklamak o tepkiyi ac/kapat yapar; Bridge'de cip `<span>` oldugu icin
    // kullanici kendi tepkisini ne EKLEYEBILIYOR ne de GERI ALABILIYORDU.
    // Cip artik kanonik `message:react` toggle'ina baglanan bir <button>.
    expect(view.container.querySelector('.msg-reaction')).toBeInstanceOf(HTMLButtonElement);
    expect(view.container.querySelector('.msg-reaction')).toHaveAttribute('aria-label');
    expect(view.container.querySelector('[data-delivery="pending"]')).toHaveTextContent(/gönderiliyor/i);

    await view.rerender({
      message: message({
        failed: true,
        ackId: 'ack-1',
        lastError: 'Bu kanal sunucu rol izinleriyle kısıtlanmış.',
      }),
      onRetry,
    });
    expect(view.container.querySelector('[data-delivery="failed"]'))
      .toHaveTextContent('Bu kanal sunucu rol izinleriyle kısıtlanmış.');
    await fireEvent.click(view.getByRole('button', { name: 'Yeniden dene' }));
    expect(onRetry).toHaveBeenCalledWith('ack-1');
    expect(view.container.querySelector('article.msg')).toHaveAttribute('data-delivery-state', 'failed');
  });
});

describe('MessageListPanel — state, grouping, pagination, and navigation', () => {
  let messages: MessageData[];
  let loading: boolean;
  let error: string;
  let hasMore: boolean;
  let currentChannel: { _id: string } | null;
  let host: HTMLDivElement;
  let instance: ReturnType<typeof mount>;
  const loadMessages = vi.fn();
  const loadOlder = vi.fn(async () => undefined);

  function mountList(): void {
    BridgeRegistry.register('getMessages', () => messages);
    BridgeRegistry.register('getMessagesLoading', () => loading);
    BridgeRegistry.register('getMessagesError', () => error);
    BridgeRegistry.register('getMessagesHasMore', () => hasMore);
    BridgeRegistry.register('getCurrentChannel', () => currentChannel);
    BridgeRegistry.register('getMe', () => ({ _id: 'u-me' }));
    BridgeRegistry.register('loadMessages', loadMessages);
    BridgeRegistry.register('loadOlderMessages', loadOlder);
    host = document.createElement('div');
    host.id = 'messages-area';
    document.body.appendChild(host);
    instance = mount(MessageListPanel, { target: host });
    flushSync();
  }

  beforeEach(() => {
    messages = [];
    loading = false;
    error = '';
    hasMore = false;
    currentChannel = { _id: 'ch-1' };
    loadMessages.mockClear();
    loadOlder.mockClear();
  });

  afterEach(async () => {
    if (instance) await unmount(instance);
  });

  it('renders coherent loading, error, retry, and empty states in a semantic log', async () => {
    loading = true;
    mountList();
    expect(host.querySelector('[role="log"]')).toHaveAttribute('aria-busy', 'true');
    expect(host).toHaveTextContent(/mesajlar yükleniyor/i);

    loading = false;
    error = 'Bağlantı zaman aşımına uğradı.';
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
    flushSync();
    expect(host).toHaveTextContent('Bağlantı zaman aşımına uğradı.');
    await fireEvent.click(host.querySelector('.msg-state-error button')!);
    expect(loadMessages).toHaveBeenCalledOnce();

    error = '';
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
    flushSync();
    expect(host).toHaveTextContent(/sohbet burada başlıyor/i);
  });

  it('groups only eligible consecutive same-author messages', () => {
    const start = 1_754_000_000_000;
    messages = [
      message({ _id: 'm-1', createdAt: start }),
      message({ _id: 'm-2', createdAt: start + 60_000 }),
      message({ _id: 'm-3', createdAt: start + 90_000, replyTo: { _id: 'm-1', content: 'x' } }),
    ];
    mountList();
    expect(host.querySelector('[data-id="m-1"]')).not.toHaveClass('msg-compact');
    expect(host.querySelector('[data-id="m-2"]')).toHaveClass('msg-compact');
    expect(host.querySelector('[data-id="m-3"]')).not.toHaveClass('msg-compact');
  });

  it('loads older messages near the top without changing pagination ownership', async () => {
    messages = [message()];
    hasMore = true;
    mountList();
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 300 },
    });
    host.scrollTop = 0;
    host.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(loadOlder).toHaveBeenCalledOnce());
  });

  it('shows an away-from-bottom affordance and honors reduced motion', async () => {
    messages = [message()];
    mountList();
    const scrollTo = vi.fn();
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    host.scrollTop = 100;
    host.dispatchEvent(new Event('scroll'));
    flushSync();
    await fireEvent.click(host.querySelector('.jump-latest')!);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
  });

  it('uses instant reply jumps when reduced motion is requested', async () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    messages = [
      message({ _id: 'parent' }),
      message({ _id: 'reply', userId: 'u-2', replyTo: { _id: 'parent', displayName: 'Ada', content: 'Merhaba' } }),
    ];
    mountList();
    const parent = host.querySelector<HTMLElement>('[data-id="parent"]')!;
    parent.scrollIntoView = vi.fn();
    await fireEvent.click(host.querySelector('[data-reply-state="jumpable"]')!);
    expect(parent.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });
});

describe('MessageInputPanel — shell state, limits, and edit/draft transitions', () => {
  let host: HTMLDivElement;
  let componentHost: HTMLDivElement;
  let instance: ReturnType<typeof mount>;
  let draft = '';
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const socket = { emit: vi.fn((event: string, payload: Record<string, unknown>) => emitted.push({ event, payload })) };

  function input(): HTMLTextAreaElement { return host.querySelector('#msg-input')!; }
  function sendButton(): HTMLButtonElement { return host.querySelector('[data-bridge-action="sendMessage"]')!; }
  function type(value: string): void {
    input().value = value;
    input().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  }

  beforeEach(() => {
    emitted.length = 0;
    draft = '';
    host = document.createElement('div');
    host.innerHTML = '<div id="msg-input-wrap"><div class="msg-input-box"><textarea id="msg-input"></textarea><button type="button" class="msg-input-btn send" data-bridge-action="sendMessage">Send</button></div></div>';
    componentHost = document.createElement('div');
    document.body.append(componentHost, host);
    BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'ch-1', name: 'general', type: 'text' }));
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-1' }));
    BridgeRegistry.register('getMe', () => ({ _id: 'u-me', displayName: 'Me' }));
    BridgeRegistry.register('getSocketConnected', () => true);
    BridgeRegistry.register('socket', socket as never);
    BridgeRegistry.register('setDraft', (value: string) => { draft = value; });
    BridgeRegistry.register('getDraft', () => draft);
    BridgeRegistry.register('flushDraft', () => undefined);
    BridgeRegistry.register('clearDraft', () => { draft = ''; });
    BridgeRegistry.register('appendMessage', () => true);
    BridgeRegistry.register('updateMessage', () => true);
    instance = mount(MessageInputPanel, { target: componentHost });
    flushSync();
  });

  afterEach(async () => {
    await unmount(instance);
  });

  it('sets the 2000-character DOM contract and drives send affordance from real input', () => {
    expect(input()).toHaveAttribute('maxlength', '2000');
    expect(input()).toHaveStyle({ height: '38px' });
    expect(sendButton()).toBeDisabled();
    type('Merhaba');
    expect(sendButton()).toBeEnabled();
    expect(sendButton()).toHaveClass('send-has-content');
    type('');
    expect(sendButton()).toBeDisabled();
  });

  it('preserves an over-limit restored draft, exposes its count, and prevents sending', () => {
    const longDraft = 'x'.repeat(2001);
    // Programmatic draft restoration may exceed maxlength; it must not be truncated.
    input().value = longDraft;
    input().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(input()).toHaveValue(longDraft);
    expect(componentHost).toHaveTextContent('2001/2000');
    expect(sendButton()).toBeDisabled();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(componentHost).toHaveTextContent(/en fazla 2000 karakter/i);
    expect(socket.emit).not.toHaveBeenCalledWith('message:send', expect.anything());
  });

  it('restores the channel draft after cancelling an edit', () => {
    type('Korunan taslak');
    BridgeRegistry.call('startEditMessage', { _id: 'm-edit', content: 'Düzenlenen mesaj' });
    flushSync();
    expect(input()).toHaveValue('Düzenlenen mesaj');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(input()).toHaveValue('Korunan taslak');
    expect(componentHost.querySelector('[data-composer-mode="edit"]')).not.toBeInTheDocument();
  });

  it('does not leak edit content when transitioning directly into reply mode', () => {
    type('Asıl taslak');
    BridgeRegistry.call('startEditMessage', { _id: 'm-edit', content: 'Düzenleme içeriği' });
    BridgeRegistry.call('setReplyTarget', { _id: 'm-parent', displayName: 'Lin', content: 'Yanıt bağlamı' });
    flushSync();
    expect(input()).toHaveValue('Asıl taslak');
    expect(componentHost.querySelector('[data-composer-mode="edit"]')).not.toBeInTheDocument();
    expect(componentHost.querySelector('[data-composer-mode="reply"]')).toHaveTextContent('Lin');
  });

  it('keeps the existing optimistic send protocol and clears visible input', () => {
    type('Gönderilecek mesaj');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    const send = emitted.find(item => item.event === 'message:send');
    expect(send?.payload).toMatchObject({ channelId: 'ch-1', serverId: 'srv-1', content: 'Gönderilecek mesaj' });
    expect(send?.payload.ackId).toBeTruthy();
    expect(send?.payload._tmpId).toBe(send?.payload.ackId);
    expect(input()).toHaveValue('');
    expect(sendButton()).toBeDisabled();
  });
});
