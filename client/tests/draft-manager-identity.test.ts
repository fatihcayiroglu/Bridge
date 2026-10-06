// client/tests/draft-manager-identity.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DraftManager.svelte — TASLAK KİMLİĞİNİN ÇÖZÜMLENMESİ
// ════════════════════════════════════════════════════════════════════════════
// Bir taslak `(userId, kind, conversationId[, serverId])` dörtlüsüyle
// anahtarlanır. Bu dörtlü yanlış çözülürse iki somut kusur doğar:
//
//   1. YANLIŞ KANALA YAZMA — kullanıcı A kanalında yazarken kanal değiştirir;
//      bekleyen yazma yeni kanalın anahtarına düşerse B kanalının taslağı
//      SESSİZCE EZİLİR.
//   2. YANLIŞ KANALIN TASLAĞINI SİLME — gönderim ACK'i geldiğinde kullanıcı
//      başka kanalda olabilir. `clearDraft` çağıranın verdiği kimliği
//      kullanmazsa, hiç gönderilmemiş bir taslak silinir.
//
// Bu dosya kimlik çözümlemesinin türetme ve geri düşüş dallarını ölçer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DraftManager from '../js/core/DraftManager.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  peekLocalFirstDraft,
  resetLocalFirstDraftRuntimeForTests,
} from '../js/core/local-first/draft-runtime.ts';

const DEBOUNCE_MS = 400;

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let me: { _id?: string; id?: string } | null = null;
let channel: { _id?: string; type?: string; serverId?: string } | null = null;
let server: { _id?: string } | null = null;

const setDraft = (text: unknown) => BridgeRegistry.call('setDraft', text);
const getDraft = () => BridgeRegistry.call<string>('getDraft') ?? '';
const clearDraft = (...args: unknown[]) => BridgeRegistry.call('clearDraft', ...args);
const settle = () => { vi.advanceTimersByTime(DEBOUNCE_MS + 50); flushSync(); };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetLocalFirstDraftRuntimeForTests();
  me = { _id: 'user-a' };
  channel = { _id: 'ch-1', type: 'text', serverId: 'srv-1' };
  server = { _id: 'srv-1' };
  BridgeRegistry.register('getMe', () => me);
  BridgeRegistry.register('getCurrentChannel', () => channel);
  BridgeRegistry.register('getCurrentServer', () => server);
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(DraftManager, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host?.remove();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('getCurrentChannel');
  BridgeRegistry.unregister('getCurrentServer');
  resetLocalFirstDraftRuntimeForTests();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('identity resolution', () => {
  it('accepts a legacy user object that only exposes id', () => {
    me = { id: 'legacy-user' };
    setDraft('merhaba');
    settle();
    expect(peekLocalFirstDraft({ userId: 'legacy-user', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' } as never)?.text ?? '')
      .toBe('merhaba');
  });

  it('writes nothing at all when there is no session', () => {
    me = null;
    setDraft('kayıp');
    settle();
    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(getDraft()).toBe('');
    // Oturumsuz `clearDraft` de sessizce hiçbir şey yapmaz.
    clearDraft('ch-1');
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it('writes nothing when no conversation is selected', () => {
    channel = null;
    setDraft('kayıp');
    settle();
    expect(Object.keys(localStorage)).toHaveLength(0);
    channel = { type: 'text', serverId: 'srv-1' };
    setDraft('yine kayıp');
    settle();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it('refuses to key a server channel that has no resolvable server', () => {
    channel = { _id: 'ch-orphan', type: 'text' };
    server = null;
    setDraft('sunucusuz');
    settle();
    // Sunucusuz bir kanal taslağı, başka bir sunucunun aynı kanal kimliğiyle
    // ÇAKIŞIRDI; anahtar üretilmez.
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it('derives the server id from the channel row when the registry has no current server', () => {
    channel = { _id: 'ch-2', type: 'text', serverId: 'srv-9' };
    server = null;
    setDraft('kanaldan');
    settle();
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-9', conversationId: 'ch-2' } as never)?.text ?? '')
      .toBe('kanaldan');
  });

  it.each([
    ['dm', 'dm'],
    ['group-dm', 'gdm'],
    ['group_dm', 'gdm'],
    ['GDM', 'gdm'],
  ])('keys a %s conversation without a server segment', (type, kind) => {
    channel = { _id: 'conv-1', type };
    server = null;
    setDraft('özel');
    settle();
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: kind as never, conversationId: 'conv-1' } as never)?.text ?? '').toBe('özel');
  });

  it('treats a conversation with no declared type as a server channel', () => {
    channel = { _id: 'ch-3', serverId: 'srv-1' };
    setDraft('varsayılan');
    settle();
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-3' } as never)?.text ?? '')
      .toBe('varsayılan');
  });

  it('coerces a non-string draft body into an empty draft rather than storing it', () => {
    setDraft('önce');
    settle();
    setDraft({ evil: true });
    settle();
    expect(getDraft()).toBe('');
  });
});

describe('clearDraft target resolution', () => {
  it('clears the caller-named channel even after the user has moved on', () => {
    setDraft('ch-1 taslağı');
    settle();
    channel = { _id: 'ch-2', type: 'text', serverId: 'srv-1' };
    setDraft('ch-2 taslağı');
    settle();

    clearDraft('ch-1', 'channel', 'srv-1');
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' } as never)?.text ?? '').toBe('');
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-2' } as never)?.text ?? '')
      .toBe('ch-2 taslağı');
  });

  it('reuses the current conversation kind and server when the caller names the same channel', () => {
    channel = { _id: 'dm-1', type: 'dm' };
    setDraft('dm taslağı');
    settle();
    // Tür verilmez: çağrılan kimlik MEVCUT konuşmayla aynıysa türü ondan alınır.
    clearDraft('dm-1');
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'dm', conversationId: 'dm-1' } as never)?.text ?? '').toBe('');
  });

  it('defaults an unknown named conversation to a server channel keyed by the current server', () => {
    channel = { _id: 'ch-1', type: 'text', serverId: 'srv-1' };
    setDraft('ch-1 taslağı');
    settle();
    channel = { _id: 'dm-9', type: 'dm' };

    // Çağıran BAŞKA bir konuşmayı adlandırdı ve tür vermedi: kanal varsayılır
    // ve sunucu segmenti mevcut kimlikten türetilemediği için düşer.
    clearDraft('ch-1');
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' } as never)?.text ?? '')
      .toBe('ch-1 taslağı');

    clearDraft('ch-1', 'channel', 'srv-1');
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' } as never)?.text ?? '').toBe('');
  });

  it('drops a pending write for the cleared conversation instead of resurrecting it', () => {
    setDraft('yazılmakta');
    clearDraft('ch-1', 'channel', 'srv-1');
    settle();
    // Bekleyen yazma iptal edilmezse debounce dolduğunda silinen taslak GERİ
    // GELİRDİ.
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' } as never)?.text ?? '').toBe('');
    expect(getDraft()).toBe('');
  });

  it('keeps a pending write for a different conversation when another is cleared', () => {
    setDraft('ch-1 bekliyor');
    clearDraft('ch-other', 'channel', 'srv-1');
    settle();
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' } as never)?.text ?? '')
      .toBe('ch-1 bekliyor');
  });

  it('clears the current conversation when the caller names none', () => {
    setDraft('şimdiki');
    settle();
    clearDraft();
    expect(peekLocalFirstDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' } as never)?.text ?? '').toBe('');
  });
});
