import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import DraftManager from '../js/core/DraftManager.svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { draftKey, readDraft, readDraftAttachmentPending } from '../js/core/draft-store.ts';
import { resetOutboxMemory } from '../js/core/outbox-store.ts';

const DEBOUNCE_MS = 400;
const identity = (channelId: string) => ({
  userId: 'draft-user', kind: 'channel' as const, serverId: 'draft-server', conversationId: channelId,
});

let manager: ReturnType<typeof mount> | null = null;
let composer: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let channel = { _id: 'channel-a', serverId: 'draft-server', type: 'text', name: 'alpha' };

const input = () => document.getElementById('msg-input') as HTMLTextAreaElement;
const fileInput = () => document.getElementById('msg-file-input') as HTMLInputElement;
const attachError = () => document.querySelector('.attach-error')?.textContent ?? '';

function shell(): void {
  host = document.createElement('div');
  host.innerHTML = `
    <div id="msg-input-wrap">
      <input type="file" id="msg-file-input" hidden />
      <button type="button" id="btn-attach"></button>
      <textarea id="msg-input"></textarea>
      <button type="button" data-bridge-action="sendMessage"></button>
    </div>`;
  document.body.appendChild(host);
}

function mountBoth(): void {
  shell();
  manager = mount(DraftManager, { target: host });
  composer = mount(MessageInputPanel, { target: host });
  flushSync();
}

function unmountBoth(): void {
  if (composer) unmount(composer);
  if (manager) unmount(manager);
  composer = manager = null;
  host?.remove();
  flushSync();
}

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function choose(file: File): void {
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true });
  fileInput().dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

function select(next: typeof channel): void {
  channel = next;
  document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: next._id } }));
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetOutboxMemory();
  channel = { _id: 'channel-a', serverId: 'draft-server', type: 'text', name: 'alpha' };
  BridgeRegistry.register('getMe', () => ({ _id: 'draft-user', username: 'draft-user' }));
  BridgeRegistry.register('getCurrentChannel', () => channel);
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'draft-server' }));
  BridgeRegistry.register('getSocketConnected', () => false);
  BridgeRegistry.register('appendMessage', () => undefined);
  BridgeRegistry.register('updateMessage', () => undefined);
  mountBoth();
});

afterEach(() => {
  unmountBoth();
  for (const name of [
    'getMe', 'getCurrentChannel', 'getCurrentServer', 'getSocketConnected',
    'appendMessage', 'updateMessage',
  ]) BridgeRegistry.unregister(name);
  localStorage.clear();
  resetOutboxMemory();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('draft attachment recovery', () => {
  it('navigation keeps text per destination and asks to reselect non-persisted bytes', () => {
    type('alpha draft');
    choose(new File(['private bytes'], 'private-name.pdf', { type: 'application/pdf' }));
    vi.advanceTimersByTime(DEBOUNCE_MS + 20);

    expect(readDraft(identity('channel-a'))).toBe('alpha draft');
    expect(readDraftAttachmentPending(identity('channel-a'))).toBe(true);
    expect(localStorage.getItem(draftKey(identity('channel-a'))!)).not.toContain('private-name.pdf');
    expect(localStorage.getItem(draftKey(identity('channel-a'))!)).not.toContain('private bytes');

    select({ _id: 'channel-b', serverId: 'draft-server', type: 'text', name: 'beta' });
    expect(input().value).toBe('');
    expect(document.querySelector('.composer-attach')).toBeNull();

    select({ _id: 'channel-a', serverId: 'draft-server', type: 'text', name: 'alpha' });
    expect(input().value).toBe('alpha draft');
    expect(attachError()).toContain('yeniden seçilmeli');

    document.querySelector<HTMLButtonElement>('.composer-attach button')!.click();
    flushSync();
    expect(readDraftAttachmentPending(identity('channel-a'))).toBe(false);
    expect(readDraft(identity('channel-a'))).toBe('alpha draft');
  });

  it('reload restores text and an honest generic file-reselection hint, never a blob', () => {
    type('reload draft');
    choose(new File(['large-ish bytes'], 'sensitive-file-name.txt', { type: 'text/plain' }));
    vi.advanceTimersByTime(DEBOUNCE_MS + 20);

    unmountBoth();
    mountBoth();

    expect(input().value).toBe('reload draft');
    expect(attachError()).toContain('Ek dosya yeniden seçilmeli');
    expect(fileInput().files?.length ?? 0).toBe(0);
    const raw = localStorage.getItem(draftKey(identity('channel-a'))!)!;
    expect(raw).not.toContain('sensitive-file-name.txt');
    expect(raw).not.toContain('large-ish bytes');
  });
});
