// client/tests/ux-final21-send-hold.test.ts
//
// Final21 UX turu (U-11) — HIZLI GÖNDERİMDE GERÇEK NEDEN VE KENDİLİĞİNDEN TOPARLANMA
//
// Ölçüm (gerçek sunucu, 12 mesaj / 200 ms): ilk 6 gidiyor, 7–12 "Gönderiliyor…" 10 sn
// bekleyip "Sunucu onayı zaman aşımına uğradı" ile düşüyordu. Gerçek neden anti-spam
// (5 mesaj / 4 sn → 30 sn blok); sunucu ret olayını ackId'siz yayınlıyor, istemci dinlemiyordu.
// Şimdi: geçici ret → mesaj GERÇEK nedenle sırada bekler, süre dolunca aralıklarla ve aynı
// ackId ile kendiliğinden gönderilir; bekleme sürerken yazılan yeni mesaj boşuna gönderilmez.
// Kalıcı ret (aynı metin art arda, susturma) → gerçek nedenle başarısız, otomatik deneme yok.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DraftManager from '../js/core/DraftManager.svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { resetOutboxMemory } from '../js/core/outbox-store.ts';
import {
  flushLocalFirstOutbox,
  hydrateLocalFirstOutbox,
  putLocalFirstOutboxEntry as putOutboxEntry,
  readLocalFirstOutbox as readOutbox,
  resetLocalFirstOutboxRuntimeForTests,
} from '../js/core/local-first/outbox-runtime.ts';

const ACK_TIMEOUT_MS = 10_000;
let draftInstance: ReturnType<typeof mount> | null = null;
let inputInstance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
let updates: Array<Record<string, unknown>> = [];
let toasts: Array<[string, string]> = [];

const input = () => document.getElementById('msg-input') as HTMLTextAreaElement;
function send(text: string): string {
  const el = input();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();
  return String(emitted.filter((e) => e.event === 'message:send').at(-1)?.payload.ackId ?? '');
}
const sends = () => emitted.filter((e) => e.event === 'message:send').map((e) => String(e.payload.ackId));
const lastUpdate = (ackId: string) => [...updates].reverse().find((u) => u._id === `pending:${ackId}`);
const reject = (ackId: string, kind: string, amount: number) => { BridgeRegistry.call('rejectPendingSend', ackId, kind, amount); flushSync(); };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  emitted = []; updates = []; toasts = [];
  host = document.createElement('div');
  host.innerHTML = '<div id="msg-input-wrap"><textarea id="msg-input"></textarea></div>';
  document.body.appendChild(host);
  BridgeRegistry.register('getMe', () => ({ _id: 'user-a' }));
  BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'ch-1', type: 'text', name: 'genel', serverId: 'srv-1' }));
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-1' }));
  BridgeRegistry.register('appendMessage', () => {});
  BridgeRegistry.register('updateMessage', (m: Record<string, unknown>) => { updates.push(m); });
  BridgeRegistry.register('toast', (text: string, type: string) => { toasts.push([text, type]); });
  BridgeRegistry.register('socket', { emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); } } as unknown as AnyFn);
  draftInstance = mount(DraftManager, { target: host });
  inputInstance = mount(MessageInputPanel, { target: host });
  flushSync();
});

afterEach(() => {
  if (inputInstance) unmount(inputInstance);
  if (draftInstance) unmount(draftInstance);
  inputInstance = draftInstance = null;
  host.remove();
  for (const name of ['getMe', 'getCurrentChannel', 'getCurrentServer', 'appendMessage', 'updateMessage', 'toast', 'socket']) BridgeRegistry.unregister(name);
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  vi.useRealTimers();
});

describe('hız sınırı (spam_rate / spam_muted)', () => {
  it('mesaj gerçek nedenle SIRADA bekler, yanıltıcı zaman aşımı üretmez, bir kez açıklanır', () => {
    const a = send('bir');
    reject(a, 'rate', 30_000);
    expect(lastUpdate(a)).toMatchObject({ pending: true, queued: true, failed: false, lastError: 'Sırada — hız sınırı' });
    expect(toasts).toEqual([[expect.stringMatching(/Çok hızlı.*30 sn/), 'warning']]);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 100);
    expect(updates.some((u) => u.failed === true)).toBe(false);
  });

  it('süre dolunca AYNI ackId ile kendiliğinden, 1 sn aralıklarla gönderilir', () => {
    const a = send('bir');
    const b = send('iki');
    reject(a, 'rate', 5_000);
    reject(b, 'rate', 5_000);
    const before = sends().length;
    vi.advanceTimersByTime(4_900);
    expect(sends().length).toBe(before);
    vi.advanceTimersByTime(200);
    expect(sends().slice(before)).toEqual([a]);
    vi.advanceTimersByTime(1_000);
    expect(sends().slice(before)).toEqual([a, b]);
    expect(toasts).toHaveLength(1);
  });

  it('bekleme sürerken yazılan yeni mesaj boşuna gönderilmez, sıraya girer', () => {
    const a = send('bir');
    reject(a, 'rate', 5_000);
    const beforeCount = sends().length;
    const input_ = input();
    input_.value = 'beklerken yazıldı';
    input_.dispatchEvent(new Event('input', { bubbles: true }));
    input_.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(sends().length).toBe(beforeCount);
    const heldNew = updates.filter((u) => u.queued === true && u.lastError === 'Sırada — hız sınırı').length;
    expect(heldNew).toBeGreaterThanOrEqual(2);
    vi.advanceTimersByTime(5_000 + 1_100);
    expect(sends().length).toBe(beforeCount + 2);
  });

  it('beklemedeki mesajda "Yeniden dene" de sırayı bozmaz (yine bekler)', () => {
    const a = send('bir');
    reject(a, 'rate', 5_000);
    const beforeCount = sends().length;
    BridgeRegistry.call('retrySend', a);
    flushSync();
    expect(sends().length).toBe(beforeCount);
    vi.advanceTimersByTime(5_100);
    expect(sends().at(-1)).toBe(a);
  });
});

describe('yavaş mod', () => {
  it('kendi nedeniyle bekler, bildirim tekrarlanmaz (geri sayımı composer gösterir), süre sonra gönderilir', () => {
    const a = send('bir');
    reject(a, 'slowmode', 7);
    expect(lastUpdate(a)).toMatchObject({ queued: true, lastError: 'Sırada — yavaş mod' });
    expect(toasts).toEqual([]);
    const before = sends().length;
    vi.advanceTimersByTime(7_100);
    expect(sends().slice(before)).toEqual([a]);
  });
});

describe('kalıcı retler', () => {
  it('aynı metin art arda → gerçek nedenle başarısız, otomatik deneme yok', () => {
    const a = send('aynı');
    reject(a, 'duplicate', 30_000);
    expect(lastUpdate(a)).toMatchObject({ failed: true, lastError: 'Aynı mesajı art arda gönderdin.' });
    const before = sends().length;
    vi.advanceTimersByTime(60_000);
    expect(sends().length).toBe(before);
  });

  it('moderatör susturması → kalan dakika ile başarısız', () => {
    const a = send('bir');
    reject(a, 'timeout', 125);
    expect(lastUpdate(a)).toMatchObject({ failed: true, lastError: expect.stringMatching(/susturuldun\. 3 dk/) });
  });

  it('bilinmeyen gönderim için ret yok sayılır', () => {
    reject('bilinmeyen', 'rate', 30_000);
    expect(updates).toEqual([]);
    expect(toasts).toEqual([]);
  });
});

describe('uyarı (warn:spam)', () => {
  it('teslim edilmiş ama sınıra yaklaşmış gönderim için nazik uyarı en fazla 30 sn\'de bir', () => {
    BridgeRegistry.call('noteSpamWarning');
    BridgeRegistry.call('noteSpamWarning');
    expect(toasts).toEqual([[expect.stringMatching(/Biraz yavaşla/), 'info']]);
    vi.advanceTimersByTime(30_001);
    BridgeRegistry.call('noteSpamWarning');
    expect(toasts).toHaveLength(2);
  });
});

describe('sunucu süre bildirmezse güvenli varsayılanlar', () => {
  it('hız sınırı süresiz gelirse sunucunun 30 sn bloğu kadar beklenir (erken gönderip yeniden reddedilmez)', () => {
    const a = send('bir');
    reject(a, 'rate', Number.NaN);
    const before = sends().length;
    vi.advanceTimersByTime(29_900);
    expect(sends().length).toBe(before);
    vi.advanceTimersByTime(200);
    expect(sends().slice(before)).toEqual([a]);
    expect(toasts[0]![0]).toMatch(/30 sn/);
  });

  it('yavaş mod süresiz gelirse en az 1 sn beklenir', () => {
    const a = send('bir');
    reject(a, 'slowmode', Number.NaN);
    const before = sends().length;
    vi.advanceTimersByTime(900);
    expect(sends().length).toBe(before);
    vi.advanceTimersByTime(200);
    expect(sends().slice(before)).toEqual([a]);
  });

  it('susturma süresiz gelirse en az "1 dk" denir (0 dk değil)', () => {
    const a = send('bir');
    reject(a, 'timeout', Number.NaN);
    expect(lastUpdate(a)).toMatchObject({ failed: true, lastError: expect.stringMatching(/1 dk sonra/) });
  });
});

describe('"Sil" yalnız başarısız mesajı kaldırır', () => {
  it('sırada bekleyen (henüz gönderilmemiş) mesaj "Sil" ile kaldırılamaz; süre dolunca yine gider', () => {
    const removed: string[] = [];
    BridgeRegistry.register('removeMessage', (id: string) => { removed.push(id); });
    const a = send('bir');
    reject(a, 'rate', 2_000);
    BridgeRegistry.call('discardSend', a);
    expect(removed).toEqual([]);
    vi.advanceTimersByTime(2_100);
    expect(sends().at(-1)).toBe(a);
    BridgeRegistry.unregister('removeMessage');
  });

  it('başarısız mesaj kaldırılır: listeden ve kalıcı giden kutusundan', () => {
    const removed: string[] = [];
    BridgeRegistry.register('removeMessage', (id: string) => { removed.push(id); });
    const a = send('aynı');
    reject(a, 'duplicate', 30_000);
    BridgeRegistry.call('discardSend', a);
    expect(removed).toEqual([`pending:${a}`]);
    expect(readOutbox('user-a')).toEqual([]);
    expect(Object.keys(localStorage).some((key) => key.includes('outbox'))).toBe(false);
    BridgeRegistry.unregister('removeMessage');
  });

  it('vazgeçilen mesaj, kullanıcının SONRADAN yazdığı farklı taslağı silmez', () => {
    BridgeRegistry.register('removeMessage', () => {});
    const a = send('aynı');
    reject(a, 'duplicate', 30_000);
    const el = input();
    el.value = 'yeni taslak';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    BridgeRegistry.call('discardSend', a);
    vi.advanceTimersByTime(2_000);
    expect(readOutbox('user-a').some((e) => e.ackId === a)).toBe(false);
    expect(BridgeRegistry.call('getDraft')).toBe('yeni taslak');
    BridgeRegistry.unregister('removeMessage');
  });

  it('composer yeniden mount edilince aynı oturumdaki encrypted queue kaydı başka kanal açıkken de kaldırılır', async () => {
    const removed: string[] = [];
    const a = send('aynı');
    reject(a, 'duplicate', 30_000);

    // Gerçek restart sözleşmesi: önce kabul edilmiş async encrypted write'ın
    // diske indiğini kanıtla; sonra yalnız runtime belleğini kapat ve yeni
    // runtime'ın encrypted depodan hydrate etmesini bekle. Sadece reset edip
    // senkron volatile view okumak bir restart değildir.
    await flushLocalFirstOutbox('user-a');
    unmount(inputInstance!);
    inputInstance = null;
    resetOutboxMemory();
    resetLocalFirstOutboxRuntimeForTests();
    await hydrateLocalFirstOutbox('user-a');

    expect(readOutbox('user-a').find((e) => e.ackId === a)?.state).toBe('failed');
    BridgeRegistry.unregister('getCurrentChannel');
    BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'ch-2', type: 'text', name: 'diğer', serverId: 'srv-1' }));
    inputInstance = mount(MessageInputPanel, { target: host });
    flushSync();
    BridgeRegistry.register('removeMessage', (id: string) => { removed.push(id); });
    BridgeRegistry.call('discardSend', a);
    expect(removed).toEqual([`pending:${a}`]);
    expect(readOutbox('user-a').some((e) => e.ackId === a)).toBe(false);
    BridgeRegistry.unregister('removeMessage');
  });

  it('composer yüklendikten SONRA canonical queueya eklenen başarısız kayıt da kaldırılır', () => {
    const removed: string[] = [];
    BridgeRegistry.register('removeMessage', (id: string) => { removed.push(id); });
    putOutboxEntry({
      ackId: 'diger-sekme-1', userId: 'user-a', channelId: 'ch-1', serverId: 'srv-1', draftKind: 'channel',
      messageType: 'normal', content: 'öbür sekmeden', createdAt: Date.now(), state: 'failed', attempts: 1,
    });
    BridgeRegistry.call('discardSend', 'diger-sekme-1');
    expect(removed).toEqual(['pending:diger-sekme-1']);
    expect(readOutbox('user-a').some((e) => e.ackId === 'diger-sekme-1')).toBe(false);
    BridgeRegistry.unregister('removeMessage');
  });
});
