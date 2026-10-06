// client/tests/composer-mentions.test.ts — Final21 Phase 15: @mention suggestions in the channel composer.
//
// Measured before (two real browsers): typing "@bo" offered nothing. The server resolves
// "@username" mentions, so the composer must find the person and insert the username —
// and Enter must pick the suggestion, not send a half-typed message.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { resetOutboxMemory } from '../js/core/outbox-store.ts';
import { resetLocalFirstOutboxRuntimeForTests } from '../js/core/local-first/outbox-runtime.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

const input = () => document.getElementById('msg-input') as HTMLTextAreaElement;
const listbox = () => document.querySelector<HTMLElement>('#mention-suggestions');
const options = () => [...document.querySelectorAll<HTMLElement>('#mention-suggestions [role="option"]')];

function type(text: string, caret = text.length): void {
  input().value = text;
  input().setSelectionRange(caret, caret);
  input().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}
function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(event);
  flushSync();
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  emitted = [];
  host = document.createElement('div');
  host.innerHTML = `<div id="msg-input-wrap"><textarea id="msg-input"></textarea><button type="button" data-bridge-action="sendMessage"></button></div>`;
  document.body.appendChild(host);
  BridgeRegistry.register('getMe', () => ({ _id: 'me', username: 'me' }));
  BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'ch', serverId: 'srv', type: 'text', name: 'general' }));
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv' }));
  BridgeRegistry.register('getSocketConnected', () => true);
  BridgeRegistry.register('appendMessage', () => undefined);
  BridgeRegistry.register('updateMessage', () => undefined);
  BridgeRegistry.register('getCurrentServerMembers', () => [
    { _id: 'u1', username: 'bora_k', displayName: 'Bora Kaya' },
    { _id: 'u2', username: 'zeynep', displayName: 'Zeynep Bora' },
    { _id: 'u3', username: 'cagla', displayName: 'Çağla Öz' },
  ]);
  BridgeRegistry.register('socket', {
    emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
    on: () => undefined,
    off: () => undefined,
  } as unknown as AnyFn);
  instance = mount(MessageInputPanel, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  for (const name of ['getMe', 'getCurrentChannel', 'getCurrentServer', 'getSocketConnected', 'appendMessage', 'updateMessage', 'socket', 'getCurrentServerMembers']) {
    BridgeRegistry.unregister(name);
  }
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  vi.useRealTimers();
});

describe('composer @mention suggestions', () => {
  it('typing "@bo" lists matching people, best match first, with an accessible listbox', () => {
    type('selam @bo');
    expect(listbox()).not.toBeNull();
    expect(options().map((o) => o.textContent)).toEqual(['Bora Kaya@bora_k', 'Zeynep Bora@zeynep']);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-controls')).toBe('mention-suggestions');
    expect(input().getAttribute('aria-activedescendant')).toBe('mention-option-0');
    expect(input().hasAttribute('aria-expanded')).toBe(false); // not allowed on a textbox
    expect(document.querySelector('.mention-sr-only')?.textContent).toMatch(/2/);
  });

  it('arrow keys move the selection; Enter inserts the username and does NOT send', () => {
    type('selam @bo');
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe('mention-option-1');
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(input().value).toBe('selam @zeynep ');
    expect(input().selectionStart).toBe('selam @zeynep '.length);
    expect(listbox()).toBeNull();
    expect(emitted.filter((e) => e.event === 'message:send')).toEqual([]);
    // With no suggestion open, Enter sends as before.
    key('Enter');
    expect(emitted.filter((e) => e.event === 'message:send').map((e) => e.payload.content)).toEqual(['selam @zeynep']);
  });

  it('Tab and mouse also choose; Escape closes without changing text', () => {
    type('@ça');
    key('Tab');
    expect(input().value).toBe('@cagla ');

    type('hey @bor');
    key('Escape');
    expect(listbox()).toBeNull();
    expect(input().value).toBe('hey @bor');

    type('hey @zey');
    options()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    flushSync();
    expect(input().value).toBe('hey @zeynep ');
  });

  it('no list for e-mail addresses, unknown names, or when members are unavailable', () => {
    type('mail a@bo');
    expect(listbox()).toBeNull();
    type('@nobody-here');
    expect(listbox()).toBeNull();
    BridgeRegistry.unregister('getCurrentServerMembers');
    type('@bo');
    expect(listbox()).toBeNull();
  });
});
