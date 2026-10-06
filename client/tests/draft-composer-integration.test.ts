// client/tests/draft-composer-integration.test.ts
// Faz 8.2 — Taslak ↔ composer entegrasyonu (uçtan uca davranış).
//
// GERÇEK bileşenler mount edilir: DraftManager (kalıcılık/zamanlama) +
// MessageInputPanel (#msg-input sahibi). Mock composer yoktur; testler
// kullanıcının gördüğü textarea içeriğini ölçer.
//
// Kapsanan kayıp davranış: kullanıcı kanal değiştirince yazdığı yarım mesaj
// sessizce kayboluyordu.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DraftManager from '../js/core/DraftManager.svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { draftKey } from '../js/core/draft-store.ts';
import {
  hydrateLocalFirstDraft,
  localFirstDraftStorageStatus,
  peekLocalFirstDraft,
  resetLocalFirstDraftRuntimeForTests,
} from '../js/core/local-first/draft-runtime.ts';
import { resetOutboxMemory } from '../js/core/outbox-store.ts';

const DEBOUNCE_MS = 400;
const ACK_TIMEOUT_MS = 10_000;

let draftInstance: ReturnType<typeof mount> | null = null;
let inputInstance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

let me: { _id: string } | null = null;
let channel: { _id: string; type?: string; name?: string; serverId?: string } | null = null;
let emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

const input = () => document.getElementById('msg-input') as HTMLTextAreaElement;
const settle = () => { vi.advanceTimersByTime(DEBOUNCE_MS + 50); flushSync(); };
const channelDraft = (conversationId: string) => ({
  userId: 'user-a', kind: 'channel' as const, serverId: 'srv-1', conversationId,
});

/** Kullanıcının yazmasını taklit eder — gerçek `input` olayı tetiklenir. */
function type(text: string): void {
  const el = input();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

/** Kanal değiştirir — ChannelListManager'ın yaptığı ile aynı olay. */
function selectChannel(next: { _id: string; type?: string; name?: string; serverId?: string }): void {
  channel = next;
  document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: next._id } }));
  flushSync();
}

function pressEnter(): void {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();
}

/**
 * Son `message:send`. `at(-1)` KULLANILAMAZ: sendMessage() gönderimden hemen
 * sonra `typing:stop` da yayınlıyor, son olay o oluyor.
 */
function lastSend(): { event: string; payload: Record<string, unknown> } | undefined {
  return emitted.filter(e => e.event === 'message:send').at(-1);
}

/** Sunucunun teslim onayı — MessageLoader `message:ack` üzerinde bunu çağırır. */
function ackLastSend(): void {
  BridgeRegistry.call('resolvePendingSend', lastSend()?.payload.ackId);
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetLocalFirstDraftRuntimeForTests();
  resetOutboxMemory();
  emitted = [];
  me = { _id: 'user-a' };
  channel = { _id: 'ch-1', type: 'text', name: 'genel', serverId: 'srv-1' };

  host = document.createElement('div');
  host.innerHTML = '<div id="msg-input-wrap"><textarea id="msg-input"></textarea></div>';
  document.body.appendChild(host);

  // AppState yerine dar kapsamlı vekiller — bu testin öznesi taslak/composer.
  BridgeRegistry.register('getMe', () => me);
  BridgeRegistry.register('getCurrentChannel', () => channel);
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-1' }));
  BridgeRegistry.register('appendMessage', () => {});
  BridgeRegistry.register('updateMessage', () => {});
  BridgeRegistry.register('socket', {
    emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); },
  } as unknown as AnyFn);

  draftInstance = mount(DraftManager, { target: host });
  inputInstance = mount(MessageInputPanel, { target: host });
  flushSync();
});

afterEach(() => {
  if (inputInstance) unmount(inputInstance);
  if (draftInstance) unmount(draftInstance);
  inputInstance = draftInstance = null;
  host.remove();
  for (const name of ['getMe', 'getCurrentChannel', 'getCurrentServer', 'appendMessage', 'updateMessage', 'socket']) {
    BridgeRegistry.unregister(name);
  }
  resetLocalFirstDraftRuntimeForTests();
  localStorage.clear();
  resetOutboxMemory();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('kaydetme', () => {
  it('yazmak taslağı kaydeder', () => {
    type('yarım mesaj');
    settle();

    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('yarım mesaj');
  });

  it('boş input taslak üretmez', () => {
    type('');
    settle();

    expect(localStorage.length).toBe(0);
  });

  it('metni silmek taslağı da siler', () => {
    type('bir şeyler'); settle();
    type('');           settle();

    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('');
  });
});

describe('geri yükleme — A → B → A', () => {
  it('kanala dönünce yarım mesaj geri gelir', () => {
    type('yarım mesaj');
    settle();

    selectChannel({ _id: 'ch-2', type: 'text', name: 'diğer' });
    expect(input().value).toBe('');           // B temiz başlar

    selectChannel({ _id: 'ch-1', type: 'text', name: 'genel' });
    expect(input().value).toBe('yarım mesaj'); // A geri geldi
  });

  it('her kanal kendi içeriğini korur', () => {
    type('A metni'); settle();
    selectChannel({ _id: 'ch-2', type: 'text' });
    type('B metni'); settle();

    selectChannel({ _id: 'ch-1', type: 'text' });
    expect(input().value).toBe('A metni');
    selectChannel({ _id: 'ch-2', type: 'text' });
    expect(input().value).toBe('B metni');
  });

  it('BEKLEYEN taslak kanal geçişinde kaybolmaz (debounce dolmadan)', () => {
    type('debounce dolmadan geçtim');   // henüz diske inmedi

    selectChannel({ _id: 'ch-2', type: 'text' });
    selectChannel({ _id: 'ch-1', type: 'text' });

    expect(input().value).toBe('debounce dolmadan geçtim');
  });

  it('kanal seçimi kalkarsa input TEMİZLENİR (legacy sözleşme bilinçli değişti)', () => {
    type('bir kanalın metni'); settle();

    // Legacy `drafts.ts` channelId yoksa input'a dokunmuyordu; bu, önceki
    // kanalın metninin ekranda asılı kalmasına yol açıyordu. Yeni sözleşme:
    // bağlam yoksa composer boş.
    channel = null;
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: {} }));
    flushSync();

    expect(input().value).toBe('');
    // Ama taslak KAYBOLMAZ — kanala dönünce geri gelir.
    selectChannel({ _id: 'ch-1', type: 'text' });
    expect(input().value).toBe('bir kanalın metni');
  });

  it('DM ve aynı id\'li kanal taslakları karışmaz', () => {
    selectChannel({ _id: 'conv-1', type: 'text' });
    type('kanal metni'); settle();

    selectChannel({ _id: 'conv-1', type: 'dm' });
    expect(input().value).toBe('');
    type('dm metni'); settle();

    selectChannel({ _id: 'conv-1', type: 'text' });
    expect(input().value).toBe('kanal metni');
  });
});

describe('gönderim semantiği', () => {
  it('gönderim BAŞLAYINCA taslak hemen silinmez', () => {
    type('hello'); settle();

    pressEnter();

    expect(lastSend()).toBeDefined();
    // ACK gelmeden taslak durur — teslim onaylanmadı.
    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('hello');
  });

  it('BAŞARILI ACK sonrası taslak temizlenir', () => {
    type('hello'); settle();
    pressEnter();

    ackLastSend();

    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('');
  });

  it('gönderilen metin kanal dönüşünde taslak olarak GERİ GELMEZ', () => {
    type('gönderildi'); settle();
    pressEnter();
    ackLastSend();

    selectChannel({ _id: 'ch-2', type: 'text' });
    selectChannel({ _id: 'ch-1', type: 'text' });

    expect(input().value).toBe('');
  });

  // Final21 UX (U-12): metin KAYBOLMAZ — ama iki kez de gösterilmez. Başarısız mesaj
  // listede "Yeniden dene / Sil" ile durur (kalıcı giden kutusu); aynı metni kutuya da
  // koymak ölçülen bir kusur üretiyordu: yeni yazılan metin eski metnin sonuna eklendi ve
  // tek mesaj olarak gitti; "Yeniden dene" + gönder de çift gönderim demekti.
  it('BAŞARISIZ gönderimde kullanıcının metni kaybolmaz ve kutuya ikinci kopya olarak konmaz', () => {
    type('gitmeyen mesaj'); settle();
    pressEnter();

    // ACK hiç gelmiyor → zaman aşımı (mesaj "failed" olur, retry edilebilir)
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
    flushSync();

    // Taslak güvence olarak depoda kalır; metin başarısız satırda (giden kutusu) görünür.
    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('gitmeyen mesaj');
    const outbox = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes('outbox'))!) ?? '[]');
    expect(outbox.map((e: { content: string; state: string }) => [e.content, e.state])).toEqual([['gitmeyen mesaj', 'failed']]);
    selectChannel({ _id: 'ch-2', type: 'text' });
    selectChannel({ _id: 'ch-1', type: 'text' });
    expect(input().value).toBe('');
  });

  it('giden kutusu kaydı yoksa (yalnız bellekteydi) taslak kutuya GERİ gelir', () => {
    type('gitmeyen mesaj'); settle();
    pressEnter();
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
    flushSync();
    // Depolama giden kutusunu tutamadıysa yeniden yüklemeden sonra tek kopya taslaktır.
    resetOutboxMemory();
    for (const key of Object.keys(localStorage)) if (key.includes('outbox')) localStorage.removeItem(key);
    selectChannel({ _id: 'ch-2', type: 'text' });
    selectChannel({ _id: 'ch-1', type: 'text' });
    expect(input().value).toBe('gitmeyen mesaj');
  });

  it('"Sil" başarısız mesajı ve aynı metnin taslağını birlikte kaldırır', () => {
    type('vazgeçilen'); settle();
    pressEnter();
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
    flushSync();
    const ackId = String(lastSend()?.payload.ackId);
    BridgeRegistry.register('removeMessage', () => {});
    BridgeRegistry.call('discardSend', ackId);
    BridgeRegistry.unregister('removeMessage');
    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('');
    const key = Object.keys(localStorage).find((k) => k.includes('outbox'));
    expect(key ? JSON.parse(localStorage.getItem(key) ?? '[]') : []).toEqual([]);
  });

  it('ACK gecikirken kanal değişse bile DOĞRU kanalın taslağı temizlenir', () => {
    type('ch-1 mesajı'); settle();
    pressEnter();

    selectChannel({ _id: 'ch-2', type: 'text' });
    type('ch-2 taslağı'); settle();

    ackLastSend(); // ch-1'in ACK'i geç geldi

    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('');
    expect((peekLocalFirstDraft(channelDraft('ch-2'))?.text ?? '')).toBe('ch-2 taslağı');
  });

  it('bağlantı yokken gönderim taslağı silmez', () => {
    BridgeRegistry.unregister('socket');
    type('bağlantısız'); settle();

    pressEnter();

    expect(lastSend()).toBeUndefined();
    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('bağlantısız');
  });

  it('yeniden bağlanma temizlenmiş taslağı DİRİLTMEZ', () => {
    type('gönderildi'); settle();
    pressEnter();
    ackLastSend();

    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    selectChannel({ _id: 'ch-1', type: 'text' });

    expect(input().value).toBe('');
  });
});

describe('oturum', () => {
  it('çıkışta görünür taslak metni ekrandan kalkar', () => {
    type('gizli yarım mesaj'); settle();

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();

    expect(input().value).toBe('');
  });

  it('çıkış sonrası giren BAŞKA kullanıcı önceki taslağı görmez', () => {
    type('A kullanıcısının metni'); settle();
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();

    me = { _id: 'user-b' };
    selectChannel({ _id: 'ch-1', type: 'text' });

    expect(input().value).toBe('');
  });

  it('kullanıcı geri girince durable backend varsa KENDİ şifreli taslağını bulur', async () => {
    type('A metni'); settle();
    const status = await localFirstDraftStorageStatus('user-a');
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();

    me = { _id: 'user-a' };
    if (status.durable) {
      await hydrateLocalFirstDraft(channelDraft('ch-1'));
      selectChannel({ _id: 'ch-1', type: 'text' });
      expect(input().value).toBe('A metni');
    } else {
      // Memory fallback explicitly promises no reload/logout durability.
      selectChannel({ _id: 'ch-1', type: 'text' });
      expect(input().value).toBe('');
    }
  });
});

describe('sağlamlık', () => {
  it('bozuk depolama değeri composer\'ı çökertmez', () => {
    localStorage.setItem(draftKey(channelDraft('ch-1'))!, '{bozuk');

    expect(() => selectChannel({ _id: 'ch-1', type: 'text' })).not.toThrow();
    expect(input().value).toBe('');
  });

  it('depolama yazma hatası mesaj GÖNDERMEYİ engellemez', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    type('kota dolu ama gitmeli'); settle();
    pressEnter();

    expect(lastSend()?.payload.content).toBe('kota dolu ama gitmeli');
  });

  it('depolama yazma hatası yazmayı engellemez', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });

    expect(() => { type('yazabilmeliyim'); settle(); }).not.toThrow();
    expect(input().value).toBe('yazabilmeliyim');
  });

  it('XSS metni DÜZ METİN olarak saklanır ve geri döner', () => {
    const payload = '<img src=x onerror=alert(1)>';
    type(payload); settle();

    selectChannel({ _id: 'ch-2', type: 'text' });
    selectChannel({ _id: 'ch-1', type: 'text' });

    expect(input().value).toBe(payload);          // aynen geri geldi
    expect(host.querySelector('img')).toBeNull(); // DOM'a etiket enjekte edilmedi
  });

  it('düzenleme modunda mesaj içeriği taslak olarak kaydedilmez', () => {
    BridgeRegistry.call('startEditMessage', { _id: 'm1', content: 'eski mesaj metni' });
    flushSync();
    input().dispatchEvent(new Event('input', { bubbles: true }));
    settle();

    expect((peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '')).toBe('');
  });

  it('taslak yöneticisi yokken composer çalışmaya devam eder', () => {
    unmount(draftInstance!);
    draftInstance = null;
    flushSync();

    expect(() => { type('yönetici yok'); settle(); }).not.toThrow();
    pressEnter();
    expect(lastSend()?.payload.content).toBe('yönetici yok');
  });
});
