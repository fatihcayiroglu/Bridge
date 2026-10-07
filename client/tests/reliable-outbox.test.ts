import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import {
  putOutboxEntry as putLegacyOutboxEntry,
  resetOutboxMemory,
  type OutboxEntry,
} from '../js/core/outbox-store.ts';
import { LOCAL_OUTBOX_MAX_ENTRIES as MAX_OUTBOX_ENTRIES } from '../js/core/local-first/outbox.ts';
import {
  hydrateLocalFirstOutbox,
  putLocalFirstOutboxEntry as putOutboxEntry,
  readLocalFirstOutbox as readOutbox,
  resetLocalFirstOutboxRuntimeForTests,
} from '../js/core/local-first/outbox-runtime.ts';

const USER_ID = 'outbox-user-a';
const CHANNEL_ID = 'outbox-channel';
const SERVER_ID = 'outbox-server';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let connected = false;
let activeUserId = USER_ID;
let emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
let rendered: Array<Record<string, unknown>> = [];
let serviceWorkerEvents: EventTarget;
let syncRegister: ReturnType<typeof vi.fn>;
let serviceWorkerDescriptor: PropertyDescriptor | undefined;

const input = () => document.getElementById('msg-input') as HTMLTextAreaElement;
const messageEmits = () => emitted.filter(item => item.event === 'message:send');

function typeAndSend(content: string): void {
  input().value = content;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  input().dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  flushSync();
}

function makeEntry(index: number, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    ackId: `ack-${index}`,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    serverId: SERVER_ID,
    draftKind: 'channel',
    messageType: 'normal',
    content: `message-${index}`,
    createdAt: index + 1,
    state: 'queued',
    attempts: 0,
    ...overrides,
  };
}

function mountComposer(): void {
  host = document.createElement('div');
  host.innerHTML = `
    <div id="msg-input-wrap">
      <textarea id="msg-input"></textarea>
      <button type="button" data-bridge-action="sendMessage"></button>
    </div>`;
  document.body.appendChild(host);

  BridgeRegistry.register('getMe', () => ({ _id: activeUserId, username: activeUserId }));
  BridgeRegistry.register('getCurrentChannel', () => ({
    _id: CHANNEL_ID, serverId: SERVER_ID, type: 'text', name: 'outbox',
  }));
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
  } as unknown as AnyFn);

  instance = mount(MessageInputPanel, { target: host });
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  connected = false;
  activeUserId = USER_ID;
  emitted = [];
  rendered = [];
  serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  serviceWorkerEvents = new EventTarget();
  syncRegister = vi.fn(async () => undefined);
  Object.defineProperty(serviceWorkerEvents, 'ready', {
    configurable: true,
    value: Promise.resolve({ sync: { register: syncRegister } }),
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: serviceWorkerEvents,
  });
  mountComposer();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  for (const name of [
    'getMe', 'getCurrentChannel', 'getCurrentServer', 'getSocketConnected',
    'appendMessage', 'updateMessage', 'socket',
  ]) BridgeRegistry.unregister(name);
  resetLocalFirstOutboxRuntimeForTests();
  localStorage.clear();
  resetOutboxMemory();
  if (serviceWorkerDescriptor) Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Reliable Outbox — composer integration', () => {
  it('offline send is queued, reconnect replay is single-flight, ACK removes it', async () => {
    typeAndSend('offline message');

    const queued = readOutbox(USER_ID)[0];
    expect(queued).toMatchObject({ content: 'offline message', state: 'queued', attempts: 0 });
    expect(messageEmits()).toHaveLength(0);
    expect(rendered.find(item => item.ackId === queued.ackId)).toMatchObject({
      pending: true, queued: true, failed: false,
    });

    connected = true;
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    await hydrateLocalFirstOutbox(USER_ID);
    await Promise.resolve();
    flushSync();

    expect(messageEmits()).toHaveLength(1);
    expect(messageEmits()[0].payload.ackId).toBe(queued.ackId);
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'sending', attempts: 1 });

    // ACK kaybı + bağlantı kopması: tekrar aynı idempotency key ile oynatılır.
    document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();

    expect(messageEmits()).toHaveLength(2);
    expect(new Set(messageEmits().map(item => item.payload.ackId))).toEqual(new Set([queued.ackId]));

    BridgeRegistry.call('resolvePendingSend', queued.ackId);
    expect(readOutbox(USER_ID)).toEqual([]);
  });

  it('browser online, mobile foreground and SW wake converge through the same single-flight replay owner', async () => {
    typeAndSend('lifecycle replay');
    const queued = readOutbox(USER_ID)[0];
    expect(messageEmits()).toHaveLength(0);

    // Offline/disconnect schedules only a background WAKE; the worker never
    // receives message content or an auth token.
    window.dispatchEvent(new Event('offline'));
    await Promise.resolve();
    expect(syncRegister).toHaveBeenCalledWith('bridge-local-first-replay');

    connected = true;
    window.dispatchEvent(new Event('online'));
    await hydrateLocalFirstOutbox(USER_ID);
    await Promise.resolve();
    flushSync();
    expect(messageEmits()).toHaveLength(1);
    expect(messageEmits()[0].payload.ackId).toBe(queued.ackId);

    // Extra lifecycle signals while the same ackId is in-flight must not create
    // a second replay.
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    serviceWorkerEvents.dispatchEvent(new MessageEvent('message', {
      data: { type: 'SW_LOCAL_FIRST_REPLAY', reason: 'background-sync' },
    }));
    serviceWorkerEvents.dispatchEvent(new MessageEvent('message', {
      data: { type: 'SW_NETWORK_STATUS', online: true },
    }));
    await Promise.resolve();
    flushSync();

    expect(messageEmits()).toHaveLength(1);
    expect(new Set(messageEmits().map(item => item.payload.ackId))).toEqual(new Set([queued.ackId]));
  });

  it('permission denial after reconnect is persisted honestly as retryable failure', async () => {
    typeAndSend('permission can change');
    const entry = readOutbox(USER_ID)[0];

    connected = true;
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await hydrateLocalFirstOutbox(USER_ID);
    await Promise.resolve();
    flushSync();
    BridgeRegistry.call('failPendingSend', entry.ackId, 'Bu kanalda mesaj gönderme izniniz yok.');
    flushSync();

    expect(messageEmits()).toHaveLength(1);
    expect(readOutbox(USER_ID)[0]).toMatchObject({
      ackId: entry.ackId,
      state: 'failed',
      lastError: 'Bu kanalda mesaj gönderme izniniz yok.',
    });
    expect(rendered.find(item => item.ackId === entry.ackId)).toMatchObject({
      pending: false, queued: false, failed: true,
      lastError: 'Bu kanalda mesaj gönderme izniniz yok.',
    });
  });

  it('browser restart migrates interrupted legacy sending as queued and replays once', async () => {
    unmount(instance!);
    instance = null;
    host.remove();
    for (const name of [
      'getMe', 'getCurrentChannel', 'getCurrentServer', 'getSocketConnected',
      'appendMessage', 'updateMessage', 'socket',
    ]) BridgeRegistry.unregister(name);

    resetLocalFirstOutboxRuntimeForTests();
    resetOutboxMemory();
    localStorage.clear();
    expect(putLegacyOutboxEntry(makeEntry(7, { state: 'sending', attempts: 1 }))).toBe(true);
    connected = false;
    mountComposer();

    await hydrateLocalFirstOutbox(USER_ID);
    await Promise.resolve();
    flushSync();
    expect(readOutbox(USER_ID)[0].state).toBe('queued');

    connected = true;
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    await Promise.resolve();
    flushSync();

    expect(messageEmits()).toHaveLength(1);
    expect(messageEmits()[0].payload.ackId).toBe('ack-7');
    expect(readOutbox(USER_ID)[0]).toMatchObject({ state: 'sending', attempts: 2 });
  });
});

describe('Reliable Outbox — persistence bounds', () => {
  it('keeps at most 100 entries and never silently deletes an older entry', () => {
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i += 1) {
      expect(putOutboxEntry(makeEntry(i))).toBe(true);
    }

    expect(putOutboxEntry(makeEntry(MAX_OUTBOX_ENTRIES))).toBe(false);
    const stored = readOutbox(USER_ID);
    expect(stored).toHaveLength(MAX_OUTBOX_ENTRIES);
    expect(stored[0].ackId).toBe('ack-0');
    expect(stored.at(-1)?.ackId).toBe(`ack-${MAX_OUTBOX_ENTRIES - 1}`);
  });

  it('isolates entries by authenticated user', () => {
    expect(putOutboxEntry(makeEntry(1))).toBe(true);
    expect(putOutboxEntry(makeEntry(2, { userId: 'outbox-user-b' }))).toBe(true);

    expect(readOutbox(USER_ID).map(entry => entry.ackId)).toEqual(['ack-1']);
    expect(readOutbox('outbox-user-b').map(entry => entry.ackId)).toEqual(['ack-2']);
  });
});
