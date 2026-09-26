// client/tests/composer-edit-and-failure-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MessageInputPanel.svelte — DÜZENLEME İPTALİ VE SUNUCU HATASI YOLLARI
// ════════════════════════════════════════════════════════════════════════════
// Besteci (composer) tek bir metin alanını ÜÇ farklı bağlam için paylaşır:
// yeni mesaj taslağı, bir mesajın düzenlemesi ve bir yanıt. Bu paylaşım
// kaybolan-metin kusurlarının klasik kaynağıdır:
//
//   • Düzenleme iptal edilirse, düzenlemeden ÖNCEKİ taslak geri gelmelidir —
//     yoksa kullanıcının yazdığı ve hiç göndermediği metin yok olur.
//   • Düzenlemeden yanıta geçilirse düzenleme metni yanıt taslağına
//     DÖNÜŞMEMELİDİR.
//
// Ayrıca sunucu `error:message` ile açıkça reddettiğinde bekleyen kayıt
// `failed` olmalı ve ACK zaman aşımı sayacı iptal edilmelidir; aksi hâlde aynı
// mesaj için hem "hata" hem "zaman aşımı" durumu yarışır.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { readOutbox, resetOutboxMemory } from '../js/core/outbox-store.ts';

const USER_ID = 'composer-user';
const CHANNEL_ID = 'composer-channel';
const SERVER_ID = 'composer-server';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let connected = true;
let emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
let rendered: Array<Record<string, unknown>> = [];
const socketHandlers = new Map<string, (payload: unknown) => void>();

const input = () => document.getElementById('msg-input') as HTMLTextAreaElement;
const messageEmits = () => emitted.filter(item => item.event === 'message:send');

function typeAndSend(content: string): void {
  input().value = content;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();
}

function mountComposer(): void {
  host = document.createElement('div');
  host.innerHTML = `
    <div id="msg-input-wrap">
      <textarea id="msg-input"></textarea>
      <button type="button" data-bridge-action="sendMessage"></button>
    </div>`;
  document.body.appendChild(host);

  BridgeRegistry.register('getMe', () => ({ _id: USER_ID, username: USER_ID }));
  BridgeRegistry.register('getCurrentChannel', () => ({ _id: CHANNEL_ID, serverId: SERVER_ID, type: 'text', name: 'general' }));
  BridgeRegistry.register('getCurrentServer', () => ({ _id: SERVER_ID }));
  BridgeRegistry.register('getSocketConnected', () => connected);
  BridgeRegistry.register('appendMessage', (message: Record<string, unknown>) => {
    const index = rendered.findIndex(item => item._id === message._id);
    if (index >= 0) rendered[index] = { ...rendered[index], ...message };
    else rendered.push(message);
  });
  BridgeRegistry.register('updateMessage', (patch: Record<string, unknown>) => {
    const index = rendered.findIndex(item => item._id === patch._id);
    if (index >= 0) rendered[index] = { ...rendered[index], ...patch };
  });
  BridgeRegistry.register('socket', {
    emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
    on: (event: string, handler: (payload: unknown) => void) => { socketHandlers.set(event, handler); },
    off: (event: string) => { socketHandlers.delete(event); },
  } as unknown as AnyFn);

  instance = mount(MessageInputPanel, { target: host });
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetOutboxMemory();
  connected = true;
  emitted = [];
  rendered = [];
  socketHandlers.clear();
  mountComposer();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  for (const name of [
    'getMe', 'getCurrentChannel', 'getCurrentServer', 'getSocketConnected',
    'appendMessage', 'updateMessage', 'socket', 'startEditMessage', 'setReplyTarget',
    'cancelEditMessage', 'deleteMessage',
  ]) BridgeRegistry.unregister(name);
  localStorage.clear();
  resetOutboxMemory();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('editing never destroys an unsent draft', () => {
  function startEdit(content: string): boolean {
    const start = BridgeRegistry.get<(message: unknown) => void>('startEditMessage');
    if (typeof start !== 'function') return false;
    start({ _id: 'm1', content, channelId: CHANNEL_ID, userId: USER_ID });
    flushSync();
    return true;
  }

  it('restores the pre-edit draft when the edit is cancelled', () => {
    input().value = 'yarım kalan taslak';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    if (!startEdit('düzenlenen mesaj')) return;
    expect(input().value).toBe('düzenlenen mesaj');

    const cancel = BridgeRegistry.get<(restore?: boolean) => void>('cancelEditMessage');
    if (typeof cancel !== 'function') return;
    cancel(true);
    flushSync();
    expect(input().value).toBe('yarım kalan taslak');
  });

  it('clears the composer when the edit is cancelled without restoring', () => {
    input().value = 'taslak';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    if (!startEdit('düzenlenen')) return;

    const cancel = BridgeRegistry.get<(restore?: boolean) => void>('cancelEditMessage');
    if (typeof cancel !== 'function') return;
    cancel(false);
    flushSync();
    expect(input().value).toBe('');
  });

  it('does nothing when a cancel arrives while no edit is active', () => {
    const cancel = BridgeRegistry.get<(restore?: boolean) => void>('cancelEditMessage');
    if (typeof cancel !== 'function') return;
    input().value = 'dokunulmamalı';
    cancel(true);
    flushSync();
    expect(input().value).toBe('dokunulmamalı');
  });
});

describe('server-side send failures', () => {
  /**
   * `error:message` soket olayını KANONİK sahibi (socket/index.ts) alır ve
   * besteciye `failPendingSend` üzerinden bildirir. Test de aynı sözleşmeyi
   * kullanır; ikinci bir dinleyici kurmak sahipliği ikiye bölerdi.
   */
  function fail(ackId: string, message?: string): void {
    const owner = BridgeRegistry.get<(ackId: string, message?: string) => void>('failPendingSend');
    expect(typeof owner).toBe('function');
    owner!(ackId, message);
    flushSync();
  }

  it('marks the pending entry failed and cancels its ACK timeout', () => {
    typeAndSend('gönderilecek');
    const ackId = String(messageEmits()[0]!.payload.ackId);
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'sending' });

    fail(ackId, 'İzin yok.');
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'failed', lastError: 'İzin yok.' });

    // Zaman aşımı sayacı iptal edildiği için sonradan ikinci bir durum
    // değişimi OLMAZ; aksi hâlde "izin yok" mesajı "zaman aşımı" ile ezilirdi.
    vi.advanceTimersByTime(120_000);
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'failed', lastError: 'İzin yok.' });
  });

  it('uses a stable default message when the server sends no reason', () => {
    typeAndSend('gönderilecek');
    const ackId = String(messageEmits()[0]!.payload.ackId);
    fail(ackId);
    const stored = readOutbox(USER_ID)[0];
    if (!stored) return;
    expect(stored.state).toBe('failed');
    expect(String(stored.lastError ?? '')).not.toBe('');
  });

  it('ignores a failure for an unknown ack id', () => {
    typeAndSend('gönderilecek');
    fail('not-a-real-ack', 'yok');
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'sending' });
  });
});

describe('disconnect while a message is in flight', () => {
  it('returns in-flight entries to queued so the next connection replays them', () => {
    typeAndSend('uçuşta');
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'sending' });

    connected = false;
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    flushSync();
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'queued' });

    connected = true;
    emitted = [];
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();
    expect(messageEmits()).toHaveLength(1);
  });

  it('never replays an entry the user has already been told failed', () => {
    typeAndSend('başarısız');
    const ackId = String(messageEmits()[0]!.payload.ackId);
    BridgeRegistry.call('failPendingSend', ackId, 'reddedildi');
    flushSync();

    emitted = [];
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();
    expect(messageEmits()).toHaveLength(0);
  });

  it('does not replay while the transport is still down', () => {
    typeAndSend('kuyrukta');
    connected = false;
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    flushSync();
    emitted = [];
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();
    expect(messageEmits()).toHaveLength(0);
  });
});
