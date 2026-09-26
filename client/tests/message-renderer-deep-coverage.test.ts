import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { t } from '../js/core/i18n/index.ts';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

import MessageRenderer, { type MessageData } from '../js/core/MessageRenderer.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { resetMediaRenewalState } from '../js/core/media-auth.ts';

function message(overrides: Partial<MessageData> = {}): MessageData {
  return {
    _id: 'm-1', userId: 'me', displayName: 'Ada Lovelace', content: 'Uzun basılacak güvenli metin',
    createdAt: 1_754_000_000_000, channelId: 'channel-1', serverId: 'server-1',
    ...overrides,
  };
}

function pointerEvent(type: string, values: Record<string, unknown>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

function longPress(article: HTMLElement): HTMLElement {
  article.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 12, clientY: 20 }));
  vi.advanceTimersByTime(451);
  flushSync();
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error('long press did not open the action sheet');
  return menu;
}

let clipboardWrite: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
  resetMediaRenewalState();
  clipboardWrite = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('toast');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MessageRenderer — real mobile action-sheet behavior', () => {
  it('runs every canonical own-message action and does not swallow the first sheet tap', async () => {
    const onReact = vi.fn();
    const onReply = vi.fn();
    const onSave = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const view = render(MessageRenderer, {
      props: { message: message(), currentUserId: 'me', onReact, onReply, onSave, onEdit, onDelete },
    });
    const article = view.container.querySelector<HTMLElement>('article.msg')!;

    let menu = longPress(article);
    await fireEvent.click(within(menu).getByRole('menuitem', { name: 'Tepki ekle' }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await fireEvent.click(view.getByRole('button', {
      name: t('reaction_toggle_aria', undefined, { emoji: '👍' }),
    }));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm-1' }), '👍');

    for (const [label, callback] of [
      ['Yanıtla', onReply], ['Sonra oku', onSave], ['Düzenle', onEdit], ['Sil', onDelete],
    ] as const) {
      menu = longPress(article);
      await fireEvent.click(within(menu).getByRole('menuitem', { name: label }));
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm-1' }));
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }

    menu = longPress(article);
    await fireEvent.click(within(menu).getByRole('menuitem', { name: 'Bağlantıyı kopyala' }));
    await Promise.resolve();
    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('#/servers/server-1/channels/channel-1/messages/m-1'));
  });

  it('mouse, movement, pointer-up, and pointer-cancel paths never create an accidental sheet', () => {
    const view = render(MessageRenderer, { props: { message: message() } });
    const article = view.container.querySelector<HTMLElement>('article.msg')!;

    article.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse', clientX: 0, clientY: 0 }));
    vi.advanceTimersByTime(500);
    flushSync();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    article.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 1, clientY: 1 }));

    article.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 }));
    article.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 2, clientY: 2 }));
    article.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 2, clientY: 11 }));
    article.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 11, clientY: 0 }));
    vi.advanceTimersByTime(500);
    flushSync();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    article.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'pen', clientX: 0, clientY: 0 }));
    article.dispatchEvent(pointerEvent('pointerup', { pointerType: 'pen', clientX: 0, clientY: 0 }));
    article.dispatchEvent(pointerEvent('pointercancel', { pointerType: 'pen', clientX: 0, clientY: 0 }));
    vi.advanceTimersByTime(500);
    flushSync();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('suppresses only the synthetic post-long-press click and cleans timers on unmount', () => {
    const onFocus = vi.fn();
    const view = render(MessageRenderer, { props: { message: message(), tabIndex: 0, onFocusMessage: onFocus } });
    const article = view.container.querySelector<HTMLElement>('article.msg')!;
    article.focus();
    expect(onFocus).toHaveBeenCalledWith('m-1');

    longPress(article);
    const synthetic = new MouseEvent('click', { bubbles: true, cancelable: true });
    article.dispatchEvent(synthetic);
    expect(synthetic.defaultPrevented).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    vi.runOnlyPendingTimers();
    flushSync();
    article.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 }));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not expose save/link/edit/delete for queued or failed optimistic rows', () => {
    const view = render(MessageRenderer, {
      props: { message: message({ queued: true, pending: true }), currentUserId: 'me' },
    });
    const menu = longPress(view.container.querySelector<HTMLElement>('article.msg')!);
    const labels = within(menu).getAllByRole('menuitem').map(item => item.textContent?.trim());
    // Final21 UX: teslim edilmemiş satırın sunucu kimliği yok — tepki/yanıt, var olmayan bir
    // mesaja komut olurdu. Metni kopyalamak her durumda anlamlıdır.
    expect(labels).toEqual(['Metni kopyala', 'İptal']);
  });

  it('a FAILED own row offers "Sil" in the sheet and next to "Yeniden dene"; both discard by ackId', () => {
    const onDiscard = vi.fn();
    const view = render(MessageRenderer, {
      props: { message: message({ failed: true, userId: 'me', ackId: 'ack-1', lastError: 'Aynı mesajı art arda gönderdin.' }), currentUserId: 'me', onDiscard, onRetry: vi.fn() },
    });
    const row = view.container.querySelector<HTMLElement>('.msg-delivery-failed')!;
    expect(row.textContent).toContain('Aynı mesajı art arda gönderdin.');
    expect(view.container.querySelector('.msg-actions')?.textContent?.trim() ?? '').toBe('');
    within(row).getByRole('button', { name: 'Sil' }).click();
    expect(onDiscard).toHaveBeenCalledWith('ack-1');
    const menu = longPress(view.container.querySelector<HTMLElement>('article.msg')!);
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent?.trim())).toEqual(['Metni kopyala', 'Sil', 'İptal']);
  });
});

describe('MessageRenderer — channel text as typed, with formatting (Final21 Phase 15)', () => {
  // Measured in Chromium before: "if a < b && c > d" was shown "if a &lt; b &amp;&amp; c &gt; d"
  // and **bold** as raw asterisks. Channel content is stored HTML-sanitized by the server.
  it('shows what was typed, not the stored entities', () => {
    const rendered = render(MessageRenderer, { props: { message: message({ content: 'if a &lt; b &amp;&amp; c &gt; d — https://x.test/s?q=1&amp;l=tr' }) } });
    expect(rendered.container.querySelector('.msg-content')?.textContent).toBe('if a < b && c > d — https://x.test/s?q=1&l=tr');
  });

  it('renders formatting as real elements and code literally', () => {
    const content = ['**bold** *it* ~~no~~ `a **b**`', '```', 'x &lt; y', '```'].join(String.fromCharCode(10));
    const rendered = render(MessageRenderer, { props: { message: message({ content }) } });
    const shown = rendered.container.querySelector(".msg-content")!;
    expect(shown.querySelector('strong')?.textContent).toBe('bold');
    expect(shown.querySelector('em')?.textContent).toBe('it');
    expect(shown.querySelector('s')?.textContent).toBe('no');
    expect(shown.querySelector('code.md-code')?.textContent).toBe('a **b**');
    expect(shown.querySelector('pre.md-pre code')?.textContent).toBe('x < y');
  });

  it('links open safely; other schemes and markup stay inert text', () => {
    const rendered = render(MessageRenderer, { props: { message: message({
      content: 'go https://example.test/p and javascript:alert(1) &lt;img src=x onerror=alert(1)&gt; &lt;script&gt;alert(2)&lt;/script&gt;',
    }) } });
    const shown = rendered.container.querySelector(".msg-content")!;
    const links = [...shown.querySelectorAll('a')];
    expect(links.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]))
      .toEqual([['https://example.test/p', '_blank', 'noopener noreferrer']]);
    expect(shown.querySelector('img, script')).toBeNull();
    expect(shown.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('decodes the reply preview and the system text too', () => {
    const reply = render(MessageRenderer, { props: { message: message({ replyTo: { _id: 'r', displayName: 'Bob', content: 'a &amp; b' } }) } });
    expect(reply.container.querySelector('.reply-content')?.textContent).toBe('a & b');
    cleanup();
    const system = render(MessageRenderer, { props: { message: message({ type: 'system', content: 'Rol &lt;Mod&gt; verildi' }) } });
    expect(system.container.querySelector('.sys-text')?.textContent).toBe('Rol <Mod> verildi');
  });
});

describe('MessageRenderer — bot and webhook authorship (Final21 Phase 14)', () => {
  // A bot or webhook chooses its own display name. Without a marker, a bot named
  // after a moderator was indistinguishable from that moderator.
  it('marks messages the server attributes to a bot or a webhook', () => {
    for (const overrides of [{ botId: 'bot-1', userId: 'bot:bot-1' }, { isWebhook: true }]) {
      const rendered = render(MessageRenderer, { props: { message: message({ displayName: 'Moderator', ...overrides }) } });
      const head = rendered.container.querySelector('.msg-head')!;
      expect(head.querySelector('.msg-author')?.textContent).toBe('Moderator');
      expect(head.querySelector('.msg-app-badge')?.textContent).toBe(t('message_bot_badge'));
      cleanup();
    }
  });

  it('never marks a person, whatever their name or message says', () => {
    for (const overrides of [
      { displayName: 'BOT' },
      { content: '[BOT] official announcement' },
      { botId: '', isWebhook: false },
      { botId: null, isWebhook: 'true' as unknown as boolean },
    ]) {
      const rendered = render(MessageRenderer, { props: { message: message(overrides) } });
      expect(rendered.container.querySelector('.msg-app-badge')).toBeNull();
      cleanup();
    }
  });
});

describe('MessageRenderer — author whose account was deleted (Final21 Phase 19)', () => {
  // Account deletion empties the author snapshot (username/displayName are NOT NULL, so '')
  // and drops the avatar URL and colour. The row must read as an unknown person, not blank.
  it('renders the localized unknown label and the neutral colour avatar, never an image', () => {
    const rendered = render(MessageRenderer, { props: { message: message({
      userId: 'deleted-user', username: '', displayName: '', avatarUrl: null, avatarColor: '#2d9cdb',
    }) } });
    expect(rendered.container.querySelector('.msg-author')?.textContent).toBe(t('unknown_user'));
    expect(rendered.container.querySelector('.msg-avatar img')).toBeNull();
    expect(rendered.container.querySelector('.msg-content')?.textContent).toBe('Uzun basılacak güvenli metin');
  });

  it('a reply to that person keeps the quoted text and shows the unknown label as its heading', () => {
    const rendered = render(MessageRenderer, { props: { message: message({
      replyTo: { _id: 'gone-1', content: 'eski söz' },
    }) } });
    expect(rendered.container.querySelector('.reply-author')?.textContent).toBe(t('unknown_user'));
    expect(rendered.container.querySelector('.reply-content')?.textContent).toBe('eski söz');
  });
});

describe('MessageRenderer — permalink, URL, and protected-file failures', () => {
  it('shows copied state, resets it, and reports clipboard denial without leaking silently', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    const view = render(MessageRenderer, { props: { message: message() } });
    const link = view.getByRole('button', { name: 'Mesaj bağlantısını kopyala' });
    await fireEvent.click(link);
    await Promise.resolve();
    flushSync();
    expect(view.getByRole('button', { name: 'Bağlantı kopyalandı' })).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Bağlantı kopyalandı' }));
    await Promise.resolve();
    flushSync();
    expect(clipboardWrite).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_801);
    flushSync();
    expect(view.getByRole('button', { name: 'Mesaj bağlantısını kopyala' })).toBeInTheDocument();

    clipboardWrite.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await fireEvent.click(view.getByRole('button', { name: 'Mesaj bağlantısını kopyala' }));
    await Promise.resolve();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Bağlantı kopyalanamadı:'), 'warning');
  });

  it('fails closed for malformed schemes/colors while rendering valid avatars and reaction counts', async () => {
    const onReact = vi.fn();
    const invalid = render(MessageRenderer, {
      props: {
        message: message({
          avatarColor: 'red;background:url(javascript:alert(1))',
          avatarUrl: 'data:text/html,<script>alert(1)</script>',
          fileUrl: 'http://[::broken', fileType: 'text/html',
          reactions: { '👍': ['a', 'b'], '👀': 2, '❌': 0, 'x': 'not-a-number' },
          createdAt: 'not-a-date' as unknown as number,
        }),
        onReact,
      },
    });
    expect(invalid.container.querySelector('.msg-attachment')).toBeNull();
    expect(invalid.container.querySelector('.msg-avatar img')).toBeNull();
    expect(invalid.container.querySelector('.msg-avatar')?.getAttribute('style')).toContain('var(--brand)');
    expect(invalid.container.querySelector('time')?.getAttribute('datetime')).toBeNull();
    expect(invalid.container.querySelectorAll('.msg-reaction')).toHaveLength(2);
    await fireEvent.click(invalid.getByRole('button', { name: '👍 tepkisini değiştir' }));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ _id: 'm-1' }), '👍');

    cleanup();
    const valid = render(MessageRenderer, {
      props: { message: message({ avatarColor: '#abc' }) },
    });
    expect(valid.container.querySelector('.msg-avatar')?.getAttribute('style')).toContain('rgb(170, 187, 204)');
  });

  // ── Final21 Faz 8 — F21-8-02 ───────────────────────────────────────────────
  // Mesaj avatarı bir ANLIK GÖRÜNTÜDÜR; dosya meşru biçimde yok olabilir
  // (açık avatar kaldırma, depolama kesintisi). Eskiden `onerror` yoktu ve
  // kırık bir resim çiziliyordu. Yüklenemeyen avatar renk + baş harf avatarına
  // düşmelidir.
  it('falls back to the color avatar when the snapshot avatar image fails to load', async () => {
    const view = render(MessageRenderer, {
      props: { message: message({ avatarUrl: '/uploads/avatars/removed.png', avatarColor: '#abc' }) },
    });
    const img = view.container.querySelector('.msg-avatar img');
    expect(img).not.toBeNull();

    await fireEvent.error(img as HTMLImageElement);

    const avatar = view.container.querySelector('.msg-avatar');
    expect(avatar?.querySelector('img')).toBeNull();
    expect(avatar?.getAttribute('style')).toContain('rgb(170, 187, 204)');
    expect((avatar?.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('renders sparse system, reply, delivery, and attachment metadata with bounded fallbacks', async () => {
    const onRetry = vi.fn();
    const system = render(MessageRenderer, { props: { message: message({ type: 'system', content: undefined }) } });
    expect(system.container.querySelector('.sys-text')?.textContent).toBe('');
    cleanup();

    const reply = render(MessageRenderer, { props: { message: message({ replyTo: {} }) } });
    expect(reply.container.querySelector('.reply-author')?.textContent).toBe(t('unknown_user'));
    expect(reply.container.querySelector('.reply-content')?.textContent).toBe('');
    cleanup();

    const failed = render(MessageRenderer, {
      props: { message: message({ failed: true, lastError: undefined, ackId: undefined }), onRetry },
    });
    expect(failed.getByRole('alert')).toHaveTextContent('Gönderilemedi');
    await fireEvent.click(failed.getByRole('button', { name: 'Yeniden dene' }));
    expect(onRetry).toHaveBeenCalledWith('');
    cleanup();

    for (const [fileType, selector] of [
      ['image/png', '.msg-image'],
      ['video/mp4', '.msg-video'],
      ['audio/ogg', '.msg-audio'],
      [undefined, '.msg-file'],
    ] as const) {
      const rendered = render(MessageRenderer, {
        props: { message: message({ fileUrl: '/uploads/sparse', fileName: undefined, fileType }) },
      });
      expect(rendered.container.querySelector(selector)).not.toBeNull();
      cleanup();
    }
  });

  it('cancels a protected-media recovery result when the rendered attachment changes', async () => {
    let releaseRenewal!: (response: Response) => void;
    apiFetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { releaseRenewal = resolve; }));
    const view = render(MessageRenderer, {
      props: { message: message({ fileUrl: '/uploads/first.png', fileType: 'image/png' }) },
    });
    await fireEvent.error(view.container.querySelector('.msg-image')!);
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce());

    await view.rerender({ message: message({ fileUrl: '/uploads/second.png', fileType: 'image/png' }) });
    releaseRenewal({ ok: true, status: 200 } as Response);
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(view.container.querySelector<HTMLImageElement>('.msg-image')?.src).toContain('/uploads/second.png');
  });

  it('opens a protected file only after a successful credentialed probe', async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const popup = { opener: window, location: { replace }, close };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(MessageRenderer, {
      props: { message: message({ fileUrl: '/uploads/report.pdf', fileName: 'report.pdf', fileType: 'application/pdf' }) },
    });

    await fireEvent.click(view.container.querySelector('.msg-file')!);
    await Promise.resolve();
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(popup.opener).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/uploads/report.pdf', { method: 'HEAD', credentials: 'include' });
    expect(replace).toHaveBeenCalledWith('/uploads/report.pdf');
    expect(close).not.toHaveBeenCalled();
  });

  it('renews once after a 401, retries the probe, and closes the popup on final denial/network failure', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const firstPopup = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
    const secondPopup = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open')
      .mockReturnValueOnce(firstPopup as unknown as Window)
      .mockReturnValueOnce(secondPopup as unknown as Window);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(MessageRenderer, {
      props: { message: message({ fileUrl: '/uploads/private.bin', fileName: 'private.bin', fileType: 'application/octet-stream' }) },
    });

    await fireEvent.click(view.container.querySelector('.msg-file')!);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(firstPopup.location.replace).toHaveBeenCalledWith(expect.stringContaining('_bridge_media_retry=1'));

    await fireEvent.click(view.container.querySelector('.msg-file')!);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(secondPopup.close).toHaveBeenCalled();
    expect(view.getByRole('alert')).toHaveTextContent(/Ek yüklenemedi/);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves modified clicks to the browser and fails closed when a popup is blocked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403 } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(MessageRenderer, {
      props: { message: message({ fileUrl: '/uploads/report.bin', fileType: 'application/octet-stream' }) },
    });
    const link = view.container.querySelector('.msg-file')!;
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    await Promise.resolve();
    expect(modified.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    await fireEvent.click(link);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(open).toHaveBeenCalled();
    expect(view.getByRole('alert')).toHaveTextContent(/Ek yüklenemedi/);
  });

  it('closes the placeholder popup when credential renewal is denied', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 401 });
    const popup = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 } as Response)));
    const view = render(MessageRenderer, {
      props: { message: message({ fileUrl: '/uploads/denied.bin', fileType: 'application/octet-stream' }) },
    });

    await fireEvent.click(view.container.querySelector('.msg-file')!);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(apiFetchMock).toHaveBeenCalledOnce();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
    expect(view.getByRole('alert')).toHaveTextContent(/Ek yüklenemedi/);
  });
});
