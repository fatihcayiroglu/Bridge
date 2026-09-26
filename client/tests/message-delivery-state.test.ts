// client/tests/message-delivery-state.test.ts
// Faz 7.2 — Message delivery state machine regression testleri.
//
// Bu testler AppState'in teslim uzlaştırma DAVRANIŞINI doğrular
// (implementation detail değil): pending kayıtların gerçek mesajla
// uzlaşması, sıra bağımsızlığı, duplicate oluşmaması, resync'te yerel
// kayıtların korunması ve kanal değişiminde temizlenmesi.
//
// AppState.svelte kayıtları BridgeRegistry üzerinden expose ettiği için
// bileşen mount edilerek gerçek üretim kodu çalıştırılır — mock'lanmaz.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import AppState from '../js/core/AppState.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

type Msg = Record<string, unknown> & { _id: string };

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const call = <T = unknown>(name: string, ...args: unknown[]): T | undefined =>
  BridgeRegistry.call<T>(name, ...args);
const messages = (): Msg[] => call<Msg[]>('getMessages') ?? [];

/** Gönderim anındaki optimistic kayıt (MessageInputPanel ile aynı şekil). */
function pendingMessage(ackId: string, content: string, channelId = 'ch-1'): Msg {
  return {
    _id: `pending:${ackId}`,
    // Kararli render anahtari — MessageInputPanel.optimisticMessage ile ayni.
    _key: `pending:${ackId}`,
    ackId,
    pending: true,
    channelId,
    userId: 'u-1',
    displayName: 'Test',
    content,
    createdAt: Date.now(),
  };
}

/** Sunucudan dönen gerçek mesaj. */
function serverMessage(id: string, content: string, channelId = 'ch-1'): Msg {
  return {
    _id: id,
    channelId,
    userId: 'u-1',
    displayName: 'Test',
    content,
    createdAt: Date.now(),
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(AppState, { target: host });
  // Kanal bağlamı — setCurrentChannel mesaj durumunu sıfırlar
  call('setCurrentChannel', { _id: 'ch-1', name: 'general' });
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
});

describe('message delivery state machine', () => {
  it('1) gönderim → optimistic pending kayıt listeye girer', () => {
    call('appendMessage', pendingMessage('ack-1', 'merhaba'));

    const list = messages();
    expect(list).toHaveLength(1);
    expect(list[0]._id).toBe('pending:ack-1');
    expect(list[0].pending).toBe(true);
  });

  it('2) message:ack → pending kayıt gerçek mesajla uzlaşır (sent)', () => {
    call('appendMessage', pendingMessage('ack-2', 'merhaba'));
    call('replaceMessage', 'pending:ack-2', { _id: 'srv-2', pending: false, failed: false });

    const list = messages();
    expect(list).toHaveLength(1);
    expect(list[0]._id).toBe('srv-2');
    expect(list[0].pending).toBe(false);
    expect(list[0].content).toBe('merhaba'); // içerik korunur
  });

  it('3) message:new ACK\'ten ÖNCE gelirse duplicate oluşmaz', () => {
    call('appendMessage', pendingMessage('ack-3', 'sıra testi'));
    // Sunucu broadcast'i önce geldi
    call('appendMessage', serverMessage('srv-3', 'sıra testi'));
    expect(messages()).toHaveLength(2); // geçici olarak ikisi de var

    // ACK geldi → pending düşer, gerçek mesaj kalır
    call('replaceMessage', 'pending:ack-3', { _id: 'srv-3', pending: false });

    const list = messages();
    expect(list).toHaveLength(1);
    expect(list[0]._id).toBe('srv-3');
  });

  it('4) ACK message:new\'den ÖNCE gelirse duplicate oluşmaz', () => {
    call('appendMessage', pendingMessage('ack-4', 'ters sıra'));
    call('replaceMessage', 'pending:ack-4', { _id: 'srv-4', pending: false });
    // Broadcast sonradan geldi — appendMessage _id ile tekilleştirir
    const eklendi = call<boolean>('appendMessage', serverMessage('srv-4', 'ters sıra'));

    expect(eklendi).toBe(false);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]._id).toBe('srv-4');
  });

  it('5) ACK gelmezse kayıt failed olur ve KAYBOLMAZ', () => {
    call('appendMessage', pendingMessage('ack-5', 'kaybolmamalı'));
    call('updateMessage', { _id: 'pending:ack-5', pending: false, failed: true });

    const list = messages();
    expect(list).toHaveLength(1);
    expect(list[0].failed).toBe(true);
    expect(list[0].content).toBe('kaybolmamalı');
  });

  it('6-7) retry aynı ackId ile başarıya ulaşır → tek mesaj', () => {
    call('appendMessage', pendingMessage('ack-6', 'retry'));
    call('updateMessage', { _id: 'pending:ack-6', pending: false, failed: true });

    // Retry: aynı ackId → aynı pending kayıt yeniden pending olur
    call('updateMessage', { _id: 'pending:ack-6', pending: true, failed: false });
    expect(messages()[0].pending).toBe(true);

    // Sunucu ACK'i (ilk isteği zaten kaydetmişti → aynı messageId)
    call('replaceMessage', 'pending:ack-6', { _id: 'srv-6', pending: false, failed: false });

    const list = messages();
    expect(list).toHaveLength(1);
    expect(list[0]._id).toBe('srv-6');
    expect(list[0].failed).toBe(false);
  });

  it('8-9) hata yalnızca ilgili ackId\'yi failed yapar, diğer pending etkilenmez', () => {
    call('appendMessage', pendingMessage('ack-a', 'birinci'));
    call('appendMessage', pendingMessage('ack-b', 'ikinci'));

    call('updateMessage', { _id: 'pending:ack-a', pending: false, failed: true });

    const list = messages();
    const a = list.find(m => m._id === 'pending:ack-a')!;
    const b = list.find(m => m._id === 'pending:ack-b')!;
    expect(a.failed).toBe(true);
    expect(b.failed).toBeUndefined();
    expect(b.pending).toBe(true);
  });

  it('10) reconnect resync (setMessages) pending/failed yerel kayıtları SİLMEZ', () => {
    call('appendMessage', pendingMessage('ack-10', 'yerel pending'));
    call('updateMessage', { _id: 'pending:ack-10', pending: false, failed: true });

    // Sunucudan gelen liste bu kaydı içermez (henüz kalıcı değil)
    call('setMessages', [serverMessage('srv-x', 'sunucudan'), serverMessage('srv-y', 'sunucudan 2')]);

    const list = messages();
    expect(list).toHaveLength(3);
    expect(list.some(m => m._id === 'pending:ack-10')).toBe(true);
    expect(list.find(m => m._id === 'pending:ack-10')!.failed).toBe(true);
  });

  it('10b) resync sırasında sunucuda artık var olan kayıt tekrarlanmaz', () => {
    call('appendMessage', pendingMessage('ack-11', 'uzlaşmış'));
    call('replaceMessage', 'pending:ack-11', { _id: 'srv-11', pending: false });

    call('setMessages', [serverMessage('srv-11', 'uzlaşmış')]);

    expect(messages()).toHaveLength(1);
    expect(messages()[0]._id).toBe('srv-11');
  });

  it('11) kanal değişimi eski pending/failed durumunu temizler', () => {
    call('appendMessage', pendingMessage('ack-12', 'eski kanal'));
    call('updateMessage', { _id: 'pending:ack-12', pending: false, failed: true });
    expect(messages()).toHaveLength(1);

    call('setCurrentChannel', { _id: 'ch-2', name: 'diger' });

    expect(messages()).toHaveLength(0);
    expect(call('getMessagesHasMore')).toBe(false);
    expect(call('getMessageCursor')).toBeNull();
  });

  it('mesajlar her zaman kronolojik sırada tutulur', () => {
    call('setMessages', [
      { ...serverMessage('m3', 'üç'), createdAt: 300 },
      { ...serverMessage('m1', 'bir'), createdAt: 100 },
      { ...serverMessage('m2', 'iki'), createdAt: 200 },
    ]);

    expect(messages().map(m => m._id)).toEqual(['m1', 'm2', 'm3']);

    // Yeni gelen mesaj sona eklenir
    call('appendMessage', { ...serverMessage('m4', 'dört'), createdAt: 400 });
    expect(messages().map(m => m._id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// KARARLI RENDER ANAHTARI — ODAK KORUMASININ TEMELI
// ══════════════════════════════════════════════════════════════════════════
// Liste `{#each ... (message._key ?? message._id)}` ile anahtarlanir. Uzlasma
// sirasinda `_id` DEGISIR; `_key` degismezse Svelte ayni DOM dugumunu
// gunceller ve odak korunur. `_key` kaybolursa dugum yok edilir ve odak
// `<body>`'ye duser (E2E'de olculdu: 0ms ARTICLE → 42ms BODY).
describe('kararli render anahtari (_key)', () => {
  it('ack ONCE gelirse pending kaydin _key degeri KORUNUR', () => {
    call('setMessages', [pendingMessage('ack-k1', 'merhaba')]);
    call('replaceMessage', 'pending:ack-k1', { _id: 'real-k1', pending: false });

    const row = messages().find(m => m._id === 'real-k1');
    expect(row, 'gercek mesaj bulunamadi').toBeTruthy();
    expect(row!._key, '_key uzlasmada kayboldu — DOM dugumu yok edilir').toBe('pending:ack-k1');
  });

  it('message:new ONCE gelirse gercek satir pending anahtarini DEVRALIR', () => {
    // Bu, E2E'de olculen yoldur: gercek mesaj listeye girmis, pending dusuyor.
    call('setMessages', [pendingMessage('ack-k2', 'selam')]);
    call('appendMessage', serverMessage('real-k2', 'selam'));
    call('replaceMessage', 'pending:ack-k2', { _id: 'real-k2', pending: false });

    const rows = messages();
    expect(rows.filter(m => String(m._id).startsWith('pending:')), 'pending satir kalmis').toHaveLength(0);
    const row = rows.find(m => m._id === 'real-k2');
    expect(row, 'gercek mesaj bulunamadi').toBeTruthy();
    expect(row!._key, 'anahtar devralinmadi — odak kaybolur').toBe('pending:ack-k2');
  });

  it('render anahtarlari BENZERSIZ kalir — dugum cakismasi olmaz', () => {
    call('setMessages', [pendingMessage('ack-k3', 'bir'), pendingMessage('ack-k4', 'iki')]);
    call('appendMessage', serverMessage('real-k3', 'bir'));
    call('replaceMessage', 'pending:ack-k3', { _id: 'real-k3', pending: false });
    call('replaceMessage', 'pending:ack-k4', { _id: 'real-k4', pending: false });

    const keys = messages().map(m => m._key ?? m._id);
    expect(new Set(keys).size, 'anahtar cakismasi: ' + JSON.stringify(keys)).toBe(keys.length);
  });

  it('baskasindan gelen mesajda _key YOKTUR — _id yedegi kullanilir', () => {
    call('setMessages', []);
    call('appendMessage', serverMessage('real-k5', 'digerinden'));
    const row = messages().find(m => m._id === 'real-k5');
    expect(row!._key).toBeUndefined();
    expect(row!._key ?? row!._id).toBe('real-k5');
  });
});
