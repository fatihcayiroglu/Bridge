// client/tests/outbox-store-resilience.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DAYANIKLI OUTBOX — BOZULMA, DEPOLAMA ARIZASI VE ZEHIRLI GIRDI
// ════════════════════════════════════════════════════════════════════════════
// `outbox-store.ts` gonderilmemis mesaklari DISKTE tutar. Mevcut testler mutlu
// yollari kapsiyor (kuyruga alma, yeniden oynatma, ACK, 100 siniri, kullanici
// izolasyonu). Kapsanmayan sey ARIZA DALLARIYDI — ve risk orada.
//
// ── NEDEN BU DALLAR ONEMLI ──────────────────────────────────────────────────
// 1. GUVENLIK: `validEntry` her girdinin `userId`sini bekleneneyle karsilastirir.
//    Bu kontrol duserse, PAYLASILAN bir bilgisayarda onceki kullanicinin
//    kuyrukta bekleyen mesaji SONRAKI kullanicinin oturumunda yeniden
//    gonderilebilir. Depolama baska kod tarafindan da yazilabilen bir alandir;
//    oradan gelen her sey GUVENILMEZ girdidir.
//
// 2. VERI KAYBI: depolama bozulursa modul kurtarilabilir girdileri KORUMALI,
//    hepsini atmamali. Tersine, tek bozuk girdi yuzunden her seyi silmek
//    kullanicinin yazdigi mesajlari yok eder.
//
// 3. GIZLI SEKME / KOTA: `setItem` atabilir. O durumda oturum CALISMAYA devam
//    etmeli (bellek yedegi), ama dayaniklilik iddia EDILMEMELI.
//
// Bu dosya yalnizca "cokmuyor" demez; her durumda DOGRU SONUCU dogrular.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  readOutbox, putOutboxEntry, patchOutboxEntry, removeOutboxEntry,
  restoreOutbox, outboxForChannel, outboxKey, resetOutboxMemory,
  MAX_OUTBOX_ENTRIES, OUTBOX_KEY_PREFIX,
  type OutboxEntry,
} from '../js/core/outbox-store.ts';

const KULLANICI = 'kullanici-1';
const ANAHTAR = `${OUTBOX_KEY_PREFIX}:${KULLANICI}`;

function girdi(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    ackId: 'ack-1', userId: KULLANICI, channelId: 'kanal-1', serverId: 'sunucu-1',
    draftKind: 'channel', messageType: 'normal', content: 'merhaba',
    createdAt: 1000, state: 'queued', attempts: 0,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetOutboxMemory();
});
afterEach(() => { vi.restoreAllMocks(); });

// ════════════════════════════════════════════════════════════════════════════
// ZEHIRLI / BOZUK DEPOLAMA
// ════════════════════════════════════════════════════════════════════════════
describe('bozuk depolama', () => {
  it('GECERSIZ JSON sessizce bos kuyruga duser ve anahtari temizler', () => {
    localStorage.setItem(ANAHTAR, '{bu json degil');
    expect(readOutbox(KULLANICI)).toEqual([]);
    expect(localStorage.getItem(ANAHTAR)).toBeNull();
  });

  it('DIZI OLMAYAN JSON gecersiz sayilir', () => {
    localStorage.setItem(ANAHTAR, JSON.stringify({ ackId: 'x' }));
    expect(readOutbox(KULLANICI)).toEqual([]);
  });

  it('KISMEN bozuk liste: gecerli girdiler KORUNUR, bozuklar atilir', () => {
    // Tek bozuk girdi yuzunden kullanicinin yazdigi her seyi silmek kabul
    // edilemez; tersine bozugu tutmak da olmaz.
    localStorage.setItem(ANAHTAR, JSON.stringify([
      girdi({ ackId: 'iyi-1', createdAt: 1 }),
      { ackId: 'bozuk', userId: KULLANICI },          // eksik alanlar
      girdi({ ackId: 'iyi-2', createdAt: 2 }),
    ]));
    expect(readOutbox(KULLANICI).map(e => e.ackId)).toEqual(['iyi-1', 'iyi-2']);
  });

  it('temizlenmis liste DISKE geri yazilir (kendini onarma)', () => {
    localStorage.setItem(ANAHTAR, JSON.stringify([
      girdi({ ackId: 'iyi-1' }),
      { tamamen: 'cop' },
    ]));
    readOutbox(KULLANICI);
    // Ikinci okumada bozuk girdi ARTIK diskte olmamali.
    const ham = JSON.parse(localStorage.getItem(ANAHTAR) as string);
    expect(ham).toHaveLength(1);
    expect(ham[0].ackId).toBe('iyi-1');
  });

  it('girdiler createdAt sirasina gore doner', () => {
    localStorage.setItem(ANAHTAR, JSON.stringify([
      girdi({ ackId: 'c', createdAt: 300 }),
      girdi({ ackId: 'a', createdAt: 100 }),
      girdi({ ackId: 'b', createdAt: 200 }),
    ]));
    expect(readOutbox(KULLANICI).map(e => e.ackId)).toEqual(['a', 'b', 'c']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GUVENLIK — KULLANICI SINIRI
// ════════════════════════════════════════════════════════════════════════════
describe('kullanici siniri', () => {
  it('BASKA kullaniciya ait girdi REDDEDILIR', () => {
    // Paylasilan bilgisayarda onceki kullanicinin bekleyen mesajinin yeni
    // oturumda yeniden gonderilmesini engelleyen kontrol budur.
    localStorage.setItem(ANAHTAR, JSON.stringify([
      girdi({ ackId: 'benim' }),
      girdi({ ackId: 'baskasinin', userId: 'kullanici-2' }),
    ]));
    const okunan = readOutbox(KULLANICI);
    expect(okunan.map(e => e.ackId)).toEqual(['benim']);
  });

  it('BOS kullanici kimligi hicbir anahtar uretmez', () => {
    expect(outboxKey('')).toBeNull();
    expect(readOutbox('')).toEqual([]);
    expect(putOutboxEntry(girdi({ userId: '' }))).toBe(false);
  });

  it('kullanicilar AYRI anahtarlarda saklanir', () => {
    putOutboxEntry(girdi({ ackId: 'a1', userId: 'u-a' }));
    putOutboxEntry(girdi({ ackId: 'b1', userId: 'u-b' }));
    expect(readOutbox('u-a').map(e => e.ackId)).toEqual(['a1']);
    expect(readOutbox('u-b').map(e => e.ackId)).toEqual(['b1']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ALAN DOGRULAMA — her biri ayri bir dal
// ════════════════════════════════════════════════════════════════════════════
describe('girdi dogrulama', () => {
  const reddedilmeli = (bozuk: Partial<OutboxEntry> | object, ad: string) => {
    it(`REDDEDER: ${ad}`, () => {
      localStorage.setItem(ANAHTAR, JSON.stringify([{ ...girdi(), ...bozuk }]));
      expect(readOutbox(KULLANICI)).toEqual([]);
    });
  };

  reddedilmeli({ ackId: '' }, 'bos ackId');
  reddedilmeli({ ackId: 'x'.repeat(65) }, '64 karakterden uzun ackId');
  reddedilmeli({ channelId: '' }, 'bos channelId');
  reddedilmeli({ serverId: '' }, 'bos serverId');
  reddedilmeli({ state: 'gonderildi' as never }, 'bilinmeyen state');
  reddedilmeli({ messageType: 'video' as never }, 'bilinmeyen messageType');
  reddedilmeli({ draftKind: 'kanal' as never }, 'bilinmeyen draftKind');
  reddedilmeli({ content: 123 as never }, 'metin olmayan content');
  reddedilmeli({ content: 'x'.repeat(2001) }, '2000 karakterden uzun content');
  reddedilmeli({ createdAt: Number.NaN }, 'NaN createdAt');
  reddedilmeli({ createdAt: 'dun' as never }, 'sayi olmayan createdAt');
  reddedilmeli({ messageType: 'file', fileUrl: undefined }, 'fileUrl olmayan dosya');
  reddedilmeli({ messageType: 'file', fileUrl: 'u', fileName: undefined }, 'fileName olmayan dosya');

  it('KABUL EDER: tam donanimli dosya girdisi', () => {
    // Pozitif kontrol — yukaridaki reddetmelerin "her seyi reddet" olmadigini
    // kanitlar. Bu olmadan tum dogrulama testleri bosuna gecerdi.
    localStorage.setItem(ANAHTAR, JSON.stringify([
      girdi({ messageType: 'file', fileUrl: 'https://x/y.png', fileName: 'y.png', fileType: 'image/png' }),
    ]));
    expect(readOutbox(KULLANICI)).toHaveLength(1);
  });

  it('KABUL EDER: tam sinirdaki content (2000)', () => {
    localStorage.setItem(ANAHTAR, JSON.stringify([girdi({ content: 'x'.repeat(2000) })]));
    expect(readOutbox(KULLANICI)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEPOLAMA ARIZASI — bellek yedegi
// ════════════════════════════════════════════════════════════════════════════
describe('depolama yazamiyorsa', () => {
  it('oturum CALISMAYA devam eder (bellek yedegi)', () => {
    // Gizli sekme veya kota dolu: kullanicinin mesaji kaybolmamali.
    const casus = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('kota dolu');
    });
    expect(putOutboxEntry(girdi({ ackId: 'bellek-1' }))).toBe(true);
    casus.mockRestore();
    expect(readOutbox(KULLANICI).map(e => e.ackId)).toEqual(['bellek-1']);
  });

  it('bellek yedegi kullanicilar arasinda SIZMAZ', () => {
    const casus = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('kota dolu');
    });
    putOutboxEntry(girdi({ ackId: 'a1', userId: 'u-a' }));
    casus.mockRestore();
    expect(readOutbox('u-b')).toEqual([]);
  });

  it('okuma PATLARSA cokmez', () => {
    const casus = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('depolama kapali');
    });
    expect(() => readOutbox(KULLANICI)).not.toThrow();
    expect(readOutbox(KULLANICI)).toEqual([]);
    casus.mockRestore();
  });

  it('resetOutboxMemory bellek yedegini TEMIZLER', () => {
    const casus = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('kota dolu');
    });
    putOutboxEntry(girdi({ ackId: 'gecici' }));
    casus.mockRestore();
    resetOutboxMemory();
    expect(readOutbox(KULLANICI)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// YAZMA YOLLARI
// ════════════════════════════════════════════════════════════════════════════
describe('yazma islemleri', () => {
  it('AYNI ackId ikinci kez yazilirsa KOPYA olusmaz (idempotent yeniden deneme)', () => {
    // Yeniden gonderim ayni ackId ile gelir. Kopya olusursa kullanici mesajini
    // arayuzde iki kez gorur ve sunucuya iki kez gider.
    putOutboxEntry(girdi({ ackId: 'ayni', content: 'ilk' }));
    putOutboxEntry(girdi({ ackId: 'ayni', content: 'guncel' }));
    const hepsi = readOutbox(KULLANICI);
    expect(hepsi).toHaveLength(1);
    expect(hepsi[0].content).toBe('guncel');
  });

  it('SINIRDA yeni girdi reddedilir ama mevcutlar KORUNUR', () => {
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
      putOutboxEntry(girdi({ ackId: 'a' + i, createdAt: i }));
    }
    expect(putOutboxEntry(girdi({ ackId: 'fazla', createdAt: 99999 }))).toBe(false);
    expect(readOutbox(KULLANICI)).toHaveLength(MAX_OUTBOX_ENTRIES);
  });

  it('SINIRDAYKEN mevcut girdi hala GUNCELLENEBILIR', () => {
    // Aksi halde kuyruk dolduğunda yeniden deneme durumu yazilamaz ve
    // girdiler kalici olarak sikisir.
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
      putOutboxEntry(girdi({ ackId: 'a' + i, createdAt: i }));
    }
    expect(putOutboxEntry(girdi({ ackId: 'a5', createdAt: 5, state: 'failed' }))).toBe(true);
    expect(readOutbox(KULLANICI).find(e => e.ackId === 'a5')?.state).toBe('failed');
  });

  it('patch BILINMEYEN ackId icin null doner', () => {
    expect(patchOutboxEntry(KULLANICI, 'yok-boyle', { state: 'failed' })).toBeNull();
  });

  it('patch yalnizca verilen alanlari degistirir', () => {
    putOutboxEntry(girdi({ ackId: 'p1', content: 'korunmali' }));
    const sonuc = patchOutboxEntry(KULLANICI, 'p1', { state: 'failed', attempts: 3, lastError: 'ag' });
    expect(sonuc).toMatchObject({ state: 'failed', attempts: 3, lastError: 'ag', content: 'korunmali' });
  });

  it('remove yalnizca hedefi siler', () => {
    putOutboxEntry(girdi({ ackId: 'a', createdAt: 1 }));
    putOutboxEntry(girdi({ ackId: 'b', createdAt: 2 }));
    removeOutboxEntry(KULLANICI, 'a');
    expect(readOutbox(KULLANICI).map(e => e.ackId)).toEqual(['b']);
  });

  it('SON girdi silinince anahtar tamamen KALDIRILIR', () => {
    putOutboxEntry(girdi({ ackId: 'tek' }));
    removeOutboxEntry(KULLANICI, 'tek');
    expect(localStorage.getItem(ANAHTAR)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// YENIDEN BASLATMA
// ════════════════════════════════════════════════════════════════════════════
describe('restoreOutbox', () => {
  it('YARIM KALAN gonderim yeniden kuyruga alinir', () => {
    // Tarayici kapandiginda 'sending' durumundaki girdi asla ACK almaz.
    // 'queued'a donmezse kullanicinin mesaji SESSIZCE kaybolurdu.
    putOutboxEntry(girdi({ ackId: 's1', state: 'sending' }));
    expect(restoreOutbox(KULLANICI)[0].state).toBe('queued');
  });

  it('DIGER durumlar degistirilmez', () => {
    putOutboxEntry(girdi({ ackId: 'f1', state: 'failed', createdAt: 1 }));
    putOutboxEntry(girdi({ ackId: 'q1', state: 'queued', createdAt: 2 }));
    expect(restoreOutbox(KULLANICI).map(e => e.state)).toEqual(['failed', 'queued']);
  });

  it('donusum DISKE de yazilir', () => {
    putOutboxEntry(girdi({ ackId: 's1', state: 'sending' }));
    restoreOutbox(KULLANICI);
    expect(readOutbox(KULLANICI)[0].state).toBe('queued');
  });
});

describe('outboxForChannel', () => {
  it('yalnizca istenen kanalin girdilerini doner', () => {
    putOutboxEntry(girdi({ ackId: 'k1', channelId: 'kanal-1', createdAt: 1 }));
    putOutboxEntry(girdi({ ackId: 'k2', channelId: 'kanal-2', createdAt: 2 }));
    expect(outboxForChannel(KULLANICI, 'kanal-1').map(e => e.ackId)).toEqual(['k1']);
  });

  it('eslesme yoksa bos dizi', () => {
    expect(outboxForChannel(KULLANICI, 'yok')).toEqual([]);
  });
});
