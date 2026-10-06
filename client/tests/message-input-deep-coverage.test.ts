import { cleanup, fireEvent } from '@testing-library/svelte';
import { t } from '../js/core/i18n/index.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { resetOutboxMemory, type OutboxEntry } from '../js/core/outbox-store.ts';
import { LOCAL_OUTBOX_MAX_ENTRIES as MAX_OUTBOX_ENTRIES } from '../js/core/local-first/outbox.ts';
import {
  putLocalFirstOutboxEntry as putOutboxEntry,
  readLocalFirstOutbox as readOutbox,
  resetLocalFirstOutboxRuntimeForTests,
} from '../js/core/local-first/outbox-runtime.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function response(body: unknown, status = 200, rejectJson = false): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: rejectJson ? vi.fn(async () => { throw new Error('invalid json'); }) : vi.fn(async () => body),
  } as unknown as Response;
}

function file(name = 'proof.txt', size = 12, type = 'text/plain'): File {
  const value = new File(['bridge'], name, { type });
  Object.defineProperty(value, 'size', { configurable: true, value: size });
  return value;
}

const keys = [
  'apiFetch', 'socket', 'getSocketConnected', 'getCurrentChannel', 'getCurrentServer', 'getMe',
  'appendMessage', 'updateMessage', 'setDraft', 'getDraft', 'flushDraft', 'clearDraft',
  'setDraftAttachmentPending', 'getDraftAttachmentPending',
  'sendMessage', 'setReplyTarget', 'startEditMessage', 'deleteMessage',
  'retrySend', 'resolvePendingSend', 'failPendingSend',
];

let shell: HTMLDivElement;
let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | null;
let channel: { _id?: string; serverId?: string; name?: string; type?: string } | null;
let currentServer: { _id?: string } | null;
let user: Record<string, unknown>;
let connected: boolean | undefined;
let socket: { emit: ReturnType<typeof vi.fn> } | null;
let apiFetch: ReturnType<typeof vi.fn>;
let appendMessage: ReturnType<typeof vi.fn>;
let updateMessage: ReturnType<typeof vi.fn>;
let draft: string;
let attachmentPending: boolean;

const input = () => shell.querySelector<HTMLTextAreaElement>('#msg-input')!;
const sendButton = () => shell.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!;
const fileInput = () => shell.querySelector<HTMLInputElement>('#msg-file-input')!;
const preview = () => target.querySelector<HTMLElement>('.composer-attach');
const alertText = () => target.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? '';

function choose(value: File): void {
  Object.defineProperty(fileInput(), 'files', { configurable: true, value: [value] });
  fileInput().dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

function type(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function send(): void {
  BridgeRegistry.call('sendMessage');
  flushSync();
}

function installSocket(value: typeof socket): void {
  socket = value;
  if (socket) BridgeRegistry.register('socket', socket as unknown as AnyFn);
  else BridgeRegistry.unregister('socket');
}

function mountComposer(): void {
  instance = mount(MessageInputPanel, { target });
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  channel = { _id: 'channel-a', serverId: 'server-a', name: 'genel', type: 'text' };
  currentServer = { _id: 'server-a' };
  user = { _id: 'user-a', username: 'ada', displayName: 'Ada' };
  connected = true;
  draft = '';
  attachmentPending = false;
  shell = document.createElement('div');
  shell.innerHTML = `
    <div id="msg-input-wrap">
      <input id="msg-file-input" type="file" hidden>
      <button id="btn-attach" type="button">attach</button>
      <textarea id="msg-input"></textarea>
      <button type="button" data-bridge-action="sendMessage">send</button>
    </div>`;
  target = document.createElement('div');
  document.body.append(shell, target);

  apiFetch = vi.fn(async () => response({
    url: '/uploads/proof.txt', fileName: 'proof.txt', fileType: 'text/plain',
  }));
  appendMessage = vi.fn();
  updateMessage = vi.fn();
  BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
  BridgeRegistry.register('getSocketConnected', () => connected);
  BridgeRegistry.register('getCurrentChannel', () => channel);
  BridgeRegistry.register('getCurrentServer', () => currentServer);
  BridgeRegistry.register('getMe', () => user);
  BridgeRegistry.register('appendMessage', appendMessage);
  BridgeRegistry.register('updateMessage', updateMessage);
  BridgeRegistry.register('setDraft', (value: string) => { draft = value; });
  BridgeRegistry.register('getDraft', () => draft);
  BridgeRegistry.register('flushDraft', vi.fn());
  BridgeRegistry.register('clearDraft', vi.fn(() => { draft = ''; }));
  BridgeRegistry.register('setDraftAttachmentPending', (value: boolean) => { attachmentPending = value; });
  BridgeRegistry.register('getDraftAttachmentPending', () => attachmentPending);
  installSocket({ emit: vi.fn() });
  mountComposer();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  cleanup();
  shell.remove();
  target.remove();
  for (const key of keys) BridgeRegistry.unregister(key);
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MessageInputPanel — identity, destination, and editing failures', () => {
  it('keeps text when identity, destination, or server context is missing', () => {
    user = {};
    type('kimliksiz metin');
    send();
    expect(alertText()).toMatch(/Oturum kimliği/);
    expect(input()).toHaveValue('kimliksiz metin');
    expect(socket?.emit).not.toHaveBeenCalledWith('message:send', expect.anything());

    user = { id: 'fallback-id' };
    channel = null;
    send();
    expect(alertText()).toMatch(/Önce bir kanal seç/);
    channel = { _id: 'channel-a', type: 'text' };
    currentServer = null;
    send();
    expect(alertText()).toMatch(/Sunucu bağlamı/);
    expect(readOutbox('fallback-id')).toEqual([]);
  });

  it('blocks offline edits, emits connected edits/deletes, and restores the pre-edit draft', () => {
    draft = 'korunan taslak';
    type('korunan taslak');
    BridgeRegistry.call('startEditMessage', { _id: 'message-edit', content: 'eski içerik' });
    flushSync();
    connected = false;
    type('yeni içerik');
    send();
    expect(alertText()).toMatch(/düzenleme gönderilemedi/);
    expect(socket?.emit).not.toHaveBeenCalledWith('message:edit', expect.anything());

    connected = true;
    send();
    // Uretim duzenlemeye bir `clientNonce` ekler (idempotent tekrar/eslestirme
    // icin); degeri uretim tarafinda uretildigi icin SEKLI dogrulanir.
    expect(socket?.emit).toHaveBeenCalledWith('message:edit', expect.objectContaining({
      messageId: 'message-edit', channelId: 'channel-a', content: 'yeni içerik',
    }));
    const editCall = socket!.emit.mock.calls.find(([event]) => event === 'message:edit');
    const nonce = (editCall?.[1] as { clientNonce?: string }).clientNonce;
    expect(typeof nonce).toBe('string');

    // Duzenleme artik SUNUCU ONAYINA kadar bekler: metin kutuda kalir ki
    // onay gelmezse kullanicinin yazdigi kaybolmasin. Taslak, ancak onay
    // geldiginde geri yuklenir. (Eskiden emit ile birlikte hemen geri
    // yukleniyordu; bu, onaylanmamis bir duzenlemeyi sessizce kaybediyordu.)
    expect(input()).toHaveValue('yeni içerik');
    BridgeRegistry.call('resolveEditMutation', nonce, 'message-edit');
    flushSync();
    expect(input()).toHaveValue('korunan taslak');

    BridgeRegistry.call('deleteMessage', '');
    BridgeRegistry.call('deleteMessage', 'message-delete');
    // Silme de idempotent eslestirme icin bir `clientNonce` tasir.
    expect(socket?.emit).toHaveBeenCalledWith('message:delete', expect.objectContaining({
      messageId: 'message-delete', channelId: 'channel-a',
    }));
  });

  it('preserves reply metadata, truncates its snapshot, and separates Shift+Enter from send', () => {
    BridgeRegistry.call('setReplyTarget', {});
    expect(target.querySelector('[data-composer-mode="reply"]')).toBeNull();
    BridgeRegistry.call('setReplyTarget', {
      _id: 'parent', username: 'grace', content: 'x'.repeat(140),
    });
    flushSync();
    expect(target.querySelector('[data-composer-mode="reply"]')).toHaveTextContent('grace');

    type('yanıt');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(socket?.emit).not.toHaveBeenCalledWith('message:send', expect.anything());
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    const payload = socket?.emit.mock.calls.find(call => call[0] === 'message:send')?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ replyToId: 'parent', content: 'yanıt' });
    const optimistic = appendMessage.mock.calls.find(call => (call[0] as Record<string, unknown>).ackId === payload.ackId)?.[0] as Record<string, unknown>;
    expect((optimistic.replyTo as { content: string }).content).toHaveLength(100);
    expect(target.querySelector('[data-composer-mode="reply"]')).toBeNull();
  });

  it('surfaces a full durable queue without clearing the user draft', () => {
    for (let index = 0; index < MAX_OUTBOX_ENTRIES; index += 1) {
      const entry: OutboxEntry = {
        ackId: `full-${index}`, userId: 'user-a', channelId: 'other', serverId: 'server-a',
        draftKind: 'channel', messageType: 'normal', content: `queued ${index}`,
        createdAt: index + 1, state: 'queued', attempts: 0,
      };
      expect(putOutboxEntry(entry)).toBe(true);
    }
    type('kaybolmaması gereken metin');
    send();
    expect(alertText()).toMatch(/kuyruğu dolu|depolama kullanılamıyor/i);
    expect(input()).toHaveValue('kaybolmaması gereken metin');
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('typing is single-start, restarts its stop timer, and stops on empty input', () => {
    type('a');
    type('ab');
    expect(socket?.emit.mock.calls.filter(call => call[0] === 'typing:start')).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    type('abc');
    vi.advanceTimersByTime(1_500);
    expect(socket?.emit).not.toHaveBeenCalledWith('typing:stop', expect.anything());
    type('');
    expect(socket?.emit).toHaveBeenCalledWith('typing:stop', { channelId: 'channel-a' });
  });
});

describe('MessageInputPanel — attachment trust and lifecycle', () => {
  it('ignores a completed upload after logout so another session cannot inherit/send it', async () => {
    const pending = deferred<Response>();
    apiFetch.mockReturnValueOnce(pending.promise);
    choose(file('private.pdf', 512, 'application/pdf'));
    send();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    user = { _id: 'user-b' };
    pending.resolve(response({ url: '/uploads/private.pdf', fileName: 'private.pdf', fileType: 'application/pdf' }));
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    expect(socket?.emit).not.toHaveBeenCalledWith('message:send', expect.objectContaining({ type: 'file' }));
    expect(readOutbox('user-a')).toEqual([]);
    expect(readOutbox('user-b')).toEqual([]);
    expect(preview()).toBeNull();
  });

  it('ignores a completed upload after unmount and leaves no delayed send behind', async () => {
    const pending = deferred<Response>();
    apiFetch.mockReturnValueOnce(pending.promise);
    choose(file());
    send();
    unmount(instance!);
    instance = null;
    pending.resolve(response({ url: '/uploads/proof.txt', fileName: 'proof.txt', fileType: 'text/plain' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket?.emit).not.toHaveBeenCalledWith('message:send', expect.objectContaining({ type: 'file' }));
    expect(readOutbox('user-a')).toEqual([]);
  });

  it('rejects an untrusted upload URL instead of placing it in the durable outbox', async () => {
    apiFetch.mockResolvedValueOnce(response({
      url: 'javascript:alert(document.cookie)', fileName: 'proof.txt', fileType: 'text/plain',
    }));
    choose(file());
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    expect(alertText()).toMatch(/güvenilir bir dosya adresi/i);
    expect(readOutbox('user-a')).toEqual([]);
    expect(socket?.emit).not.toHaveBeenCalledWith('message:send', expect.objectContaining({ type: 'file' }));
    expect(preview()).not.toBeNull();
  });

  // `uploadErrorText(status)` yalnizca DURUM KODUNA bakar: sunucunun `error`
  // govdesi kullaniciya asla gosterilmez ("private stack" gibi bir ic ayrinti
  // da, "Dosya adi gecersiz" gibi bir metin de). Bu testler eskiden tam
  // tersini bekliyordu.
  it.each([
    [400, { error: 'Dosya adı geçersiz' }, () => t('upload_rejected')],
    [500, { error: 'private stack' }, () => t('upload_failed')],
    [413, {}, () => t('error_upload_size')],
    [422, {}, () => t('upload_security_failed')],
  ])('maps HTTP %i upload failure without dropping the selected file', async (status, body, expected) => {
    apiFetch.mockResolvedValueOnce(response(body, status));
    choose(file());
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(alertText()).toBe(expected());
    expect(alertText()).not.toContain('private stack');
    expect(preview()).not.toBeNull();
    expect(readOutbox('user-a')).toEqual([]);
  });

  it('handles absent upload client, invalid JSON, missing server, missing socket, and duplicate clicks', async () => {
    choose(file());
    BridgeRegistry.unregister('apiFetch');
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(alertText()).toMatch(/Yükleme istemcisi hazır değil/);

    BridgeRegistry.register('apiFetch', ((...args: unknown[]) => apiFetch(...args)) as AnyFn);
    apiFetch.mockResolvedValueOnce(response({}, 400, true));
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(alertText()).toMatch(/Dosya kabul edilmedi/);

    apiFetch.mockResolvedValueOnce(response({ url: '/uploads/proof.txt' }));
    channel = { _id: 'channel-a', type: 'text' };
    currentServer = null;
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(alertText()).toMatch(/Sunucu bağlamı bulunamadı/);

    channel = { _id: 'channel-a', serverId: 'server-a', type: 'text' };
    installSocket(null);
    send();
    expect(target).toHaveTextContent(/Bağlantı yok.*dosya/i);

    installSocket({ emit: vi.fn() });
    const pending = deferred<Response>();
    apiFetch.mockReturnValueOnce(pending.promise);
    send();
    send();
    expect(apiFetch.mock.calls.filter(call => String(call[0]).includes('/api/upload'))).toHaveLength(3);
    pending.resolve(response({ url: '/uploads/proof.txt' }));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('accepts drag/drop, preserves recovery hints across channels, and hides non-text destinations', () => {
    const transfer = { types: ['Files'], files: [file('drop.bin', 999, 'application/octet-stream')], dropEffect: 'none' };
    const drag = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drag, 'dataTransfer', { configurable: true, value: transfer });
    shell.querySelector('#msg-input-wrap')!.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { configurable: true, value: transfer });
    shell.querySelector('#msg-input-wrap')!.dispatchEvent(drop);
    flushSync();
    expect(drop.defaultPrevented).toBe(true);
    expect(preview()).toHaveTextContent('drop.bin');
    expect(preview()).toHaveTextContent('999 B');

    channel = { _id: 'channel-b', serverId: 'server-a', name: 'ikinci', type: 'text' };
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: 'channel-b' } }));
    flushSync();
    expect(preview()).toHaveTextContent(/Ek dosya yeniden seçilmeli/);

    channel = { _id: 'voice', serverId: 'server-a', name: 'ses', type: 'voice' };
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: 'voice' } }));
    flushSync();
    expect(shell.querySelector<HTMLElement>('#msg-input-wrap')!.style.display).toBe('none');
  });
});

describe('MessageInputPanel — defensive branch contracts', () => {
  it('remains inert when the static composer shell is absent', () => {
    unmount(instance!);
    instance = null;
    shell.innerHTML = '';
    mountComposer();

    expect(() => BridgeRegistry.call('sendMessage')).not.toThrow();
    expect(() => BridgeRegistry.call('startEditMessage', { _id: 'm1', content: 'x' })).not.toThrow();
    expect(() => document.dispatchEvent(new CustomEvent('bridge:channel-selected'))).not.toThrow();
    expect(() => document.dispatchEvent(new CustomEvent('bridge:auth-logout'))).not.toThrow();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('ignores empty file, paste, drag, drop, retry, failure, and send inputs', () => {
    const click = vi.spyOn(fileInput(), 'click');
    shell.querySelector<HTMLButtonElement>('#btn-attach')!.click();
    expect(click).toHaveBeenCalledOnce();

    Object.defineProperty(fileInput(), 'files', { configurable: true, value: [] });
    fileInput().dispatchEvent(new Event('change', { bubbles: true }));

    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    input().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);

    const drag = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drag, 'dataTransfer', { configurable: true, value: { types: [], files: [], dropEffect: 'none' } });
    shell.querySelector('#msg-input-wrap')!.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(false);

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { configurable: true, value: { types: ['Files'], files: [] } });
    shell.querySelector('#msg-input-wrap')!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);

    type('   ');
    send();
    BridgeRegistry.call('retrySend', 'missing');
    BridgeRegistry.call('failPendingSend', 'missing');
    expect(socket?.emit).not.toHaveBeenCalledWith('message:send', expect.anything());
  });

  it('uses supported fallback identity/socket fields and converges across disconnect and auth recovery', () => {
    vi.stubGlobal('crypto', {});
    BridgeRegistry.unregister('getSocketConnected');
    user = { id: 'fallback-user', username: 'Fallback' };
    type('fallback payload');
    send();

    const messageCall = socket?.emit.mock.calls.find((call) => call[0] === 'message:send');
    expect(messageCall).toBeTruthy();
    expect((messageCall![1] as { ackId: string }).ackId).toMatch(/^ack-/);
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'fallback-user', username: 'Fallback', displayName: 'Fallback',
    }));

    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    connected = true;
    BridgeRegistry.register('getSocketConnected', () => connected);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));

    const ackId = (messageCall![1] as { ackId: string }).ackId;
    BridgeRegistry.call('resolvePendingSend', ackId);
    BridgeRegistry.call('resolvePendingSend', 'server-only-ack');
    user = {};
    BridgeRegistry.call('resolvePendingSend', 'anonymous-ack');
    expect(readOutbox('fallback-user')).toEqual([]);
  });

  it.each(['group-dm', 'group_dm', 'gdm'] as const)('persists %s destinations as group-DM drafts', (kind) => {
    channel = { _id: `channel-${kind}`, type: kind };
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    type(`hello ${kind}`);
    send();
    const stored = readOutbox('user-a').find((entry) => entry.channelId === `channel-${kind}`);
    expect(stored?.draftKind).toBe('gdm');
    expect(stored?.serverId).toBe('server-a');
    if (stored) BridgeRegistry.call('resolvePendingSend', stored.ackId);
  });

  it('uses current-server fallback and handles channel/attachment context transitions', () => {
    channel = { _id: 'fallback-server', type: 'text', name: '' };
    type('fallback server');
    send();
    expect(readOutbox('user-a').some((entry) => entry.serverId === 'server-a')).toBe(true);

    choose(file('same.txt', 2_048));
    expect(preview()).toHaveTextContent('2 KB');
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    flushSync();
    expect(preview()).toHaveTextContent('same.txt');

    channel = null;
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    flushSync();
    expect(shell.querySelector<HTMLElement>('#msg-input-wrap')!.style.display).toBe('none');
    expect(input().placeholder).toContain('Mesaj gönder');
    expect(preview()).toHaveTextContent(/yeniden seçilmeli/i);
  });

  it('covers invalid edit/reply targets, nested edit transitions, buttons, and idle Escape', async () => {
    BridgeRegistry.call('startEditMessage', {});
    expect(target.querySelector('[data-composer-mode="edit"]')).toBeNull();

    draft = 'draft';
    type('draft');
    BridgeRegistry.call('startEditMessage', { _id: 'm1' });
    BridgeRegistry.call('startEditMessage', { _id: 'm2', content: 'second' });
    flushSync();
    expect(input()).toHaveValue('second');
    await fireEvent.click(target.querySelector('[data-composer-mode="edit"] button')!);
    expect(target.querySelector('[data-composer-mode="edit"]')).toBeNull();

    BridgeRegistry.call('startEditMessage', { _id: 'm3', content: 'third' });
    BridgeRegistry.call('setReplyTarget', { _id: 'reply-no-label' });
    flushSync();
    expect(target.querySelector('[data-composer-mode="edit"]')).toBeNull();
    expect(target.querySelector('[data-composer-mode="reply"]')).toHaveTextContent('Mesaj');
    await fireEvent.click(target.querySelector('[data-composer-mode="reply"] button')!);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(target.querySelector('[data-composer-mode="reply"]')).toBeNull();
  });

  it('clears an over-limit error after correction and exercises disconnected delete/typing guards', () => {
    type('x'.repeat(2_001));
    send();
    expect(alertText()).toMatch(/çok uzun/);
    type('fixed');
    expect(alertText()).toBe('');

    channel = null;
    BridgeRegistry.call('deleteMessage', 'm1');
    type('typing without channel');
    channel = { _id: 'channel-a', serverId: 'server-a', type: 'text' };
    installSocket(null);
    type('typing without socket');
    expect(() => BridgeRegistry.call('deleteMessage', 'm2')).not.toThrow();
  });

  it('covers missing registry identity, default channel type, and unauthenticated recovery', () => {
    BridgeRegistry.unregister('getMe');
    channel = null;
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(readOutbox('user-a')).toEqual([]);
    expect(shell.querySelector<HTMLElement>('#msg-input-wrap')!.style.display).toBe('none');
  });

  it('exercises connected-state fallback, reply fallbacks, retry timer replacement, and timerless failure', () => {
    BridgeRegistry.unregister('getSocketConnected');
    type('draft');
    BridgeRegistry.call('startEditMessage', { _id: 'edit', content: 'before' });
    type('after');
    send();
    expect(socket?.emit).toHaveBeenCalledWith('message:edit', expect.objectContaining({ messageId: 'edit' }));

    BridgeRegistry.call('setReplyTarget', { _id: 'reply-empty' });
    type('reply body');
    send();
    const payload = socket?.emit.mock.calls.find((call) => call[0] === 'message:send' && (call[1] as { replyToId?: string }).replyToId)?.[1] as { ackId: string };
    expect(payload).toBeTruthy();
    BridgeRegistry.call('retrySend', payload.ackId);
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    BridgeRegistry.call('failPendingSend', payload.ackId, 'rejected after disconnect');
    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ failed: true, lastError: 'rejected after disconnect' }));
  });

  it('retains an attachment long enough to report a missing destination', () => {
    choose(file('orphan.txt'));
    channel = null;
    send();
    expect(alertText()).toMatch(/Önce bir kanal seç/);
    expect(preview()).toHaveTextContent('orphan.txt');
  });

  it('handles an attachment context with neither channel nor current-server identity', () => {
    channel = { _id: 'no-server', type: 'text' };
    currentServer = null;
    choose(file('contextless.txt'));
    expect(preview()).toHaveTextContent('contextless.txt');
    channel = { _id: 'next', type: 'text' };
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    flushSync();
    expect(preview()).toHaveTextContent('contextless.txt');
  });

  it('closes a reply with Escape and renders a below-limit warning counter', () => {
    BridgeRegistry.call('setReplyTarget', { _id: 'escape-reply' });
    flushSync();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(target.querySelector('[data-composer-mode="reply"]')).toBeNull();

    type('x'.repeat(1_800));
    expect(target.querySelector('.composer-counter')).toHaveTextContent('1800/2000');
    expect(target.querySelector('.composer-counter')).not.toHaveClass('over-limit');
  });
});

describe('MessageInputPanel — upload cancellation and queue boundaries', () => {
  it('ignores a rejected response body that finishes after logout', async () => {
    // Bu test eskiden hata GOVDESININ ayristirilmasini bekliyor ve "cikistan
    // sonra gelen govde sizmasin" diyordu. Uretim artik govdeyi HIC OKUMUYOR:
    // `uploadErrorText(res.status)` yalnizca duruma bakar. Sozlesme bu yuzden
    // daha da guclu ifade edilir — sizacak bir govde OKUNMAZ bile.
    const body = deferred<{ error: string }>();
    const parse = vi.fn(() => body.promise);
    apiFetch.mockResolvedValueOnce({
      ok: false, status: 400, json: parse,
    } as unknown as Response);
    choose(file());
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(parse).not.toHaveBeenCalled();

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    body.resolve({ error: 'old-session' });
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(alertText()).not.toContain('old-session');
    expect(preview()).toBeNull();
  });

  it('ignores a successful response body that finishes after logout', async () => {
    const body = deferred<{ url: string }>();
    const parse = vi.fn(() => body.promise);
    apiFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: parse,
    } as unknown as Response);
    choose(file());
    send();
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    body.resolve({ url: '/uploads/old.txt' });
    await vi.advanceTimersByTimeAsync(0);
    expect(readOutbox('user-a')).toEqual([]);
  });

  it.each([
    [415, {}, () => t('upload_type_unsupported')],
    [403, {}, () => t('upload_forbidden')],
    [413, { error: 'custom large' }, () => t('error_upload_size')],
    [422, { error: 'custom scan' }, () => t('upload_security_failed')],
  ])('maps additional authoritative HTTP %i upload failures', async (status, body, expected) => {
    apiFetch.mockResolvedValueOnce(response(body, status));
    choose(file());
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(alertText()).toBe(expected());
  });

  it('preserves an uploaded attachment when the durable outbox is full', async () => {
    for (let index = 0; index < MAX_OUTBOX_ENTRIES; index += 1) {
      expect(putOutboxEntry({
        ackId: `attachment-full-${index}`, userId: 'user-a', channelId: 'other', serverId: 'server-a',
        draftKind: 'channel', messageType: 'normal', content: `queued ${index}`,
        createdAt: index + 1, state: 'queued', attempts: 0,
      })).toBe(true);
    }
    choose(file('bounded.bin', 2_000, 'application/octet-stream'));
    send();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(alertText()).toMatch(/kuyruğuna alınamadı/i);
    expect(preview()).toHaveTextContent('bounded.bin');
  });
});
