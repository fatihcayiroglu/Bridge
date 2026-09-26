// client/tests/outbox-store-no-storage-at-all.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// outbox-store.ts — DEPOLAMANIN HİÇ OLMADIĞI VE BOZULDUĞU ORTAMLAR
// ════════════════════════════════════════════════════════════════════════════
// `localStorage` her ortamda YOKTUR: gömülü bir görünüm (webview), sıkı bir
// gizlilik ayarı ya da `about:blank` gibi bir kaynak, erişimin kendisini
// fırlatan bir özelliğe çevirebilir. Bu, kuyruğun ÇALIŞMAMASI demek değildir:
// kullanıcının yazdığı mesaj o oturum boyunca YAŞAMALI, ama yeniden yükleme
// dayanıklılığı İDDİA EDİLMEMELİDİR.
//
// Kardeş dosya `outbox-store-resilience.test.ts` "depolama VAR ama yazmıyor"
// hâlini ölçer. Burada ölçülen iki ayrı hâl vardır:
//
//   · Depolama nesnesinin KENDİSİ yok (erişim `undefined` ya da fırlatma),
//   · Depolama var ama içeriği OKUNAMAZ hâlde ve modül zaten bellek yedeğine
//     düşmüş durumda — bu, kullanıcının mesajlarının kaybolduğu tek yol
//     olurdu ve kuyruk onları bellekten geri vermelidir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_KEY_PREFIX, outboxKey, putOutboxEntry, readOutbox, resetOutboxMemory,
} from '../js/core/outbox-store.ts';

const entry = (ackId: string, overrides: Record<string, unknown> = {}) => ({
  ackId, userId: 'u1', channelId: 'c1', serverId: 's1',
  draftKind: 'channel' as const, messageType: 'normal' as const,
  content: `mesaj ${ackId}`, createdAt: 1_000, state: 'queued' as const, attempts: 0,
  ...overrides,
});

const realStorage = globalThis.localStorage;

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: realStorage });
  resetOutboxMemory();
  try { realStorage.clear(); } catch { /* yok sayılır */ }
  vi.restoreAllMocks();
});

describe('no storage object exists at all', () => {
  beforeEach(() => {
    resetOutboxMemory();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
  });

  it('keeps the queue usable for the whole session in memory', () => {
    expect(readOutbox('u1')).toEqual([]);

    expect(putOutboxEntry(entry('a1'))).toBe(true);
    expect(putOutboxEntry(entry('a2', { createdAt: 2_000 }))).toBe(true);

    // Kullanıcının yazdığı mesajlar KAYBOLMAZ; oturum boyunca okunabilir.
    expect(readOutbox('u1').map(row => row.ackId)).toEqual(['a1', 'a2']);
  });

  it('keeps every user queue separate even without storage', () => {
    putOutboxEntry(entry('a1'));
    putOutboxEntry(entry('b1', { userId: 'u2' }));

    expect(readOutbox('u1').map(row => row.ackId)).toEqual(['a1']);
    expect(readOutbox('u2').map(row => row.ackId)).toEqual(['b1']);
  });

  it('still refuses a user id that produces no key', () => {
    expect(outboxKey('')).toBeNull();
    expect(readOutbox('')).toEqual([]);
    expect(putOutboxEntry(entry('a1', { userId: '' }))).toBe(false);
  });
});

describe('storage access itself throws', () => {
  beforeEach(() => {
    resetOutboxMemory();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('storage disabled', 'SecurityError'); },
    });
  });

  it('treats a throwing accessor exactly like an absent store', () => {
    expect(() => readOutbox('u1')).not.toThrow();
    expect(putOutboxEntry(entry('a1'))).toBe(true);
    expect(readOutbox('u1').map(row => row.ackId)).toEqual(['a1']);
  });
});

describe('storage exists but its contents are unreadable', () => {
  it('returns the in-memory queue rather than losing the user’s messages', () => {
    resetOutboxMemory();
    const key = outboxKey('u1')!;
    let stored = 'bu JSON değil {{{';
    // Yazma reddedilir (kota/gizli sekme) → modül bellek yedeğine düşer.
    // Okuma ise BOZUK bir gövde döndürür: ayrıştırma atar.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (name: string) => (name === key ? stored : null),
        setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
        removeItem: () => { stored = ''; },
        clear: () => { stored = ''; },
        key: () => null, length: 0,
      } as unknown as Storage,
    });

    expect(putOutboxEntry(entry('a1'))).toBe(true);
    // Bozuk disk içeriği yüzünden kuyruk BOŞ dönmez; bellekteki gerçek
    // kuyruk verilir — aksi hâlde kullanıcı yazdığı mesajı kaybederdi.
    expect(readOutbox('u1').map(row => row.ackId)).toEqual(['a1']);
  });

  it('drops rows that are not objects at all', () => {
    resetOutboxMemory();
    const key = `${OUTBOX_KEY_PREFIX}:u1`;
    // Depolama BAŞKA kod tarafından da yazılabilir; oradan gelen her satır
    // güvenilmez girdidir. Nesne olmayanlar sessizce ELENİR.
    realStorage.setItem(key, JSON.stringify([null, 'metin', 42, true, entry('ok')]));

    const rows = readOutbox('u1');
    expect(rows.map(row => row.ackId)).toEqual(['ok']);
    // Temizlenmiş liste geri YAZILIR; bir sonraki okuma zaten temizdir.
    expect(JSON.parse(realStorage.getItem(key)!)).toHaveLength(1);
  });

  it('keeps a newer memory queue authoritative over a valid but stale disk copy', () => {
    resetOutboxMemory();
    const key = outboxKey('u1')!;
    realStorage.setItem(key, JSON.stringify([entry('disk-old')]));

    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(putOutboxEntry(entry('memory-new', { createdAt: 2_000 }))).toBe(true);
    // The valid old JSON is still physically present, but it must not hide the
    // message retained after the failed write.
    expect(readOutbox('u1').map(row => row.ackId)).toEqual(['disk-old', 'memory-new']);

    setSpy.mockRestore();
    expect(putOutboxEntry(entry('after-recovery', { createdAt: 3_000 }))).toBe(true);
    expect(readOutbox('u1').map(row => row.ackId)).toEqual([
      'disk-old', 'memory-new', 'after-recovery',
    ]);
    expect(JSON.parse(realStorage.getItem(key)!)).toHaveLength(3);
  });
});
