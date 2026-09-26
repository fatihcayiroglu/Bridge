// client/tests/offline-queue.test.ts
// Teslim güvenceleri — CANLI sözleşme testleri (native Vitest/ESM).
//
// ════════════════════════════════════════════════════════════════════════════
// Reliable Outbox — çevrimdışı kalıcılık + reconnect replay sözleşmesi.
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ (ölçüldü): `jest.mock is not a function` @ satır 23 — dosya
// `js/core/offline-queue.js` modülünü CJS `require` + `jest.mock(...,{virtual})`
// ile yüklüyordu. Süit Vitest'te 0 test kaydediyordu (collection failure).
//
// ── ESKİ MİMARİ: FULL_DEAD (kanıtlı) ────────────────────────────────────────
// `js/core/offline-queue.ts` ARTIK YOK (0 dosya eşleşmesi). Yerini alanlar:
//   • js/core/OfflineQueue.svelte      — 52 satırlık placeholder kabuk:
//       isVisible=$state(false), show/hideOfflineQueue hook'ları, KUYRUK YOK,
//       enqueue/flush/badge/cap YOK, `children` hiç geçilmez.
//   • js/core/offline-queue-svelte.ts  — mount shim; ÜRETİMDE 0 import eden
//       (tek grep isabeti js/types/globals.d.ts tip bildirimi) → auto-mount
//       hiç çalışmaz.
// `getOfflineQueue`, `flushOfflineQueue`, `_enqueue`, `MAX_QUEUE_SIZE`,
// offline-badge, `BridgeRegistry.wrap('sendMessage')`, online/visibilitychange
// flush — hepsi üretimde YOK. Eski 11 testin 6'sı (getOfflineQueue/badge/
// enqueue/input-clear/wrap-passthrough/flush-register) bu ölü mimariyi,
// 3'ü (#3, #10, #11) `expect(true).toBe(true)` / `not.toThrow` ile vakumlu
// gövde (HARNESS_ONLY) idi.
//
// ── MERKEZİ GÜVENCE ─────────────────────────────────────────────────────────
// MessageInputPanel canonical outbox sahibidir: önce kullanıcıya göre kalıcı
// kayıt, sonra optimistic pending, bağlantı varsa aynı ackId ile emit. Offline
// kayıt `queued` kalır; reconnect otomatik replay eder. Sunucudaki kalıcı,
// kullanıcı-kapsamlı ackId unique index duplicate persistence'ı engeller.
//
// ── KORUNAN CANLI ALT-SÖZLEŞMELER (burada, GERÇEK sahibe karşı) ──────────────
// Eski dosyanın iki güvencesi bugünkü composer'da CANLI ve başka yerde
// GERÇEK sahibe karşı test EDİLMİYORDU:
//   #6 → MAX_LENGTH=2000 sınırı (MessageInputPanel.svelte:126). Not:
//        messages-input-unit.test.ts sınırı test eder ama test-YEREL bir
//        `validateSendMessage` kopyasına karşı (o dosya:80) — gerçek sahibe
//        karşı değil.
//   #8 → replyToId'nin `message:send` payload'ına akışı (:149) — 0 kapsam.
//
// Bu testler GERÇEK MessageInputPanel'i mount eder; yalnız socket sınırı
// (emit yakalama) ve registry vekilleri sağlanır. Kaldırılan kuyruk mimarisi
// YENİDEN CANLANDIRILMAZ. Üretim kodu bu turda DEĞİŞTİRİLMEMİŞTİR.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { readOutbox, resetOutboxMemory } from '../js/core/outbox-store.ts';

type Emitted = { event: string; payload: Record<string, unknown> };

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let channel: { _id: string; type?: string; serverId?: string; name?: string } | null;
let emitted: Emitted[];
let rendered: Array<Record<string, unknown>>;

const REGISTRY_KEYS = [
  'getCurrentChannel', 'getCurrentServer', 'getMe',
  'appendMessage', 'updateMessage', 'socket', 'getSocketConnected',
] as const;

const input = (): HTMLTextAreaElement => document.getElementById('msg-input') as HTMLTextAreaElement;
const status = (): HTMLElement | null => document.getElementById('composer-status');
const lastSend = (): Emitted | undefined => emitted.filter(e => e.event === 'message:send').at(-1);

/** GERÇEK send yolunu çalıştırır — MessageInputPanel `sendMessage`'ı kayıtlıdır. */
function send(): void {
  BridgeRegistry.call('sendMessage');
  flushSync();
}

/** Socket'i registry'den kaldırır → composer'ın "bağlantı yok" dalı. */
function disconnectSocket(): void {
  BridgeRegistry.unregister('socket');
  BridgeRegistry.register('getSocketConnected', (() => false) as AnyFn);
}

beforeEach(() => {
  localStorage.clear();
  resetOutboxMemory();
  emitted = [];
  rendered = [];
  channel = { _id: 'ch-1', type: 'text', serverId: 'srv-1', name: 'genel' };

  host = document.createElement('div');
  // Üretimdeki statik kabuk (index.html:224-233) — MessageInputPanel buna bağlanır.
  host.innerHTML = '<div id="msg-input-wrap"><textarea id="msg-input"></textarea></div>';
  document.body.appendChild(host);

  BridgeRegistry.register('getCurrentChannel', (() => channel) as AnyFn);
  BridgeRegistry.register('getCurrentServer', (() => ({ _id: 'srv-1' })) as AnyFn);
  BridgeRegistry.register('getMe', (() => ({ _id: 'user-a', username: 'a', displayName: 'A' })) as AnyFn);
  BridgeRegistry.register('appendMessage', ((message: Record<string, unknown>): void => {
    const index = rendered.findIndex(item => item._id === message._id);
    if (index >= 0) rendered[index] = { ...rendered[index], ...message };
    else rendered.push(message);
  }) as AnyFn);
  BridgeRegistry.register('updateMessage', ((patch: Record<string, unknown>): void => {
    const index = rendered.findIndex(item => item._id === patch._id);
    if (index >= 0) rendered[index] = { ...rendered[index], ...patch };
  }) as AnyFn);
  BridgeRegistry.register('getSocketConnected', (() => true) as AnyFn);
  BridgeRegistry.register('socket', {
    emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
  } as unknown as AnyFn);

  instance = mount(MessageInputPanel, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);   // onDestroy pendingSends ACK timer'larını temizler
  instance = null;
  host.remove();
  for (const key of REGISTRY_KEYS) BridgeRegistry.unregister(key);
  localStorage.clear();
  resetOutboxMemory();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// #1 — Socket yokken kalıcı kuyruk ve otomatik reconnect replay
// ════════════════════════════════════════════════════════════════════════════
describe('socket yokken gönderim (canonical reliable outbox)', () => {
  it('bağlantı yokken emit etmez; mesajı kalıcı queued + görünür pending tutar', () => {
    disconnectSocket();
    input().value = 'çevrimdışı yazılan mesaj';

    send();

    expect(lastSend()).toBeUndefined();
    const queued = readOutbox('user-a')[0];
    expect(queued).toMatchObject({ content: 'çevrimdışı yazılan mesaj', state: 'queued', attempts: 0 });
    expect(rendered.find(item => item.ackId === queued.ackId)).toMatchObject({
      pending: true, queued: true, failed: false,
    });
  });

  it('socket geri gelince kullanıcı yeniden basmadan aynı ackId otomatik oynatılır', () => {
    disconnectSocket();
    input().value = 'daha sonra';
    send();
    expect(lastSend()).toBeUndefined();
    const queued = readOutbox('user-a')[0];

    BridgeRegistry.register('socket', {
      emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
    } as unknown as AnyFn);
    BridgeRegistry.register('getSocketConnected', (() => true) as AnyFn);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    flushSync();

    expect(lastSend()?.payload.content).toBe('daha sonra');
    expect(lastSend()?.payload.ackId).toBe(queued.ackId);
    expect(readOutbox('user-a')[0]).toMatchObject({ state: 'sending', attempts: 1 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #6 — MAX_LENGTH 2000 sınırı (LIVE_MOVED → MessageInputPanel.svelte:126)
// ════════════════════════════════════════════════════════════════════════════
describe('MAX_LENGTH 2000 sınırı (gerçek sahip)', () => {
  it('2000 karakterden uzun içerik GÖNDERİLMEZ ve metin korunur', () => {
    const uzun = 'x'.repeat(2001);
    input().value = uzun;

    send();

    expect(lastSend()).toBeUndefined();          // kuyruğa/gönderime alınmaz
    expect(input().value).toBe(uzun);            // kaybolmaz
    expect(status()?.textContent).toContain('çok uzun');
  });

  it('tam 2000 karakter sınırda KABUL edilir ve gönderilir', () => {
    const tam = 'y'.repeat(2000);
    input().value = tam;

    send();

    expect(lastSend()?.payload.content).toBe(tam);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #8 — replyToId payload akışı (LIVE_MOVED → MessageInputPanel.svelte:149)
// ════════════════════════════════════════════════════════════════════════════
describe('yanıt bağlamı payload akışı (gerçek sahip)', () => {
  it('yanıt modunda message:send payload\'ı replyToId taşır', () => {
    BridgeRegistry.call('setReplyTarget', { _id: 'msg-parent', displayName: 'B', content: 'asıl mesaj' });
    flushSync();
    input().value = 'yanıt gövdesi';

    send();

    const payload = lastSend()?.payload;
    expect(payload?.content).toBe('yanıt gövdesi');
    expect(payload?.replyToId).toBe('msg-parent');
  });

  it('normal gönderimde payload replyToId İÇERMEZ', () => {
    input().value = 'düz mesaj';

    send();

    const payload = lastSend()?.payload as Record<string, unknown>;
    expect(payload.content).toBe('düz mesaj');
    expect('replyToId' in payload).toBe(false);
  });
});
