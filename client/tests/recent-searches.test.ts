// client/tests/recent-searches.test.ts
//
// FAZ K/1 — SON ARAMALAR.
//
// En onemli iki iddia:
//   1. YALNIZCA SORGU METNI saklanir. Sonuclari onbelleklemek, kullanicinin
//      erisimi sonradan kaldirilmis bir kanalin icerigini cihazda birakirdi;
//      yetki sunucuda yasar ve her acilista yeniden dogrulanir.
//   2. Depolama hatasi ARAMA HATASI DEGILDIR. Ozel modda ya da kota dolduysa
//      arama calismaya devam etmelidir.

import { describe, it, expect } from 'vitest';
import {
  addRecent, removeRecent, parseRecent, loadRecent, saveRecent, clearRecent,
  MAX_RECENT,
} from '../js/core/search/recent-searches.ts';

/** Kucuk bellek ici storage — davranisi enjekte edilerek test edilir. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
  };
}

/** Her islemde firlatan storage (ozel mod / kota dolu). */
const hostileStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('quota'); },
  removeItem: () => { throw new Error('denied'); },
};

// ════════════════════════════════════════════════════════════════════════════
describe('addRecent', () => {
  it('yeni sorguyu BASA ekler', () => {
    expect(addRecent(['b'], 'a')).toEqual(['a', 'b']);
  });

  it('ayni sorgu KOPYALANMAZ, yukari tasinir', () => {
    // Aksi halde liste tek bir sorgunun kopyalariyla dolardi.
    expect(addRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('tekrar tespiti buyuk/kucuk harf duyarsizdir', () => {
    expect(addRecent(['Merhaba'], 'merhaba')).toEqual(['merhaba']);
  });

  it('bosluklar kirpilir', () => {
    expect(addRecent([], '  merhaba  ')).toEqual(['merhaba']);
  });

  it('bos sorgu listeye GIRMEZ', () => {
    expect(addRecent(['a'], '   ')).toEqual(['a']);
  });

  it('ust sinir asilmaz — en eski dusurulur', () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_RECENT + 5; i++) list = addRecent(list, `sorgu-${i}`);

    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toBe(`sorgu-${MAX_RECENT + 4}`);
    expect(list).not.toContain('sorgu-0');
  });

  it('girdi listesini MUTASYONA UGRATMAZ', () => {
    const original = ['a'];
    addRecent(original, 'b');
    expect(original).toEqual(['a']);
  });

  it('asiri uzun sorgu kirpilir', () => {
    expect(addRecent([], 'x'.repeat(500))[0]!.length).toBeLessThanOrEqual(120);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('removeRecent', () => {
  it('tek kaydi siler', () => {
    expect(removeRecent(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('buyuk/kucuk harf duyarsiz siler', () => {
    expect(removeRecent(['Merhaba'], 'MERHABA')).toEqual([]);
  });

  it('olmayan kayit listeyi bozmaz', () => {
    expect(removeRecent(['a'], 'z')).toEqual(['a']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('parseRecent', () => {
  it('gecerli JSON dizisini okur', () => {
    expect(parseRecent('["a","b"]')).toEqual(['a', 'b']);
  });

  it('BOZUK JSON aramayi engellemez', () => {
    expect(parseRecent('{bozuk')).toEqual([]);
  });

  it('dizi olmayan govde reddedilir', () => {
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('"metin"')).toEqual([]);
  });

  it('dizgi olmayan ogeler elenir', () => {
    expect(parseRecent('["a",1,null,{"b":2},"c"]')).toEqual(['a', 'c']);
  });

  it('depolanan liste de ust sinira kirpilir', () => {
    const many = JSON.stringify(Array.from({ length: 50 }, (_, i) => `s${i}`));
    expect(parseRecent(many)).toHaveLength(MAX_RECENT);
  });

  it('dizgi olmayan girdi guvenli', () => {
    for (const bad of [null, undefined, 42, [], {}]) expect(parseRecent(bad)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('depolama', () => {
  it('yazilan liste geri okunur', () => {
    const storage = memoryStorage();
    saveRecent(['a', 'b'], storage);
    expect(loadRecent(storage)).toEqual(['a', 'b']);
  });

  it('YALNIZCA sorgu metni saklanir — sonuc/icerik DEGIL', () => {
    // Sonuclari onbelleklemek, erisimi kaldirilmis bir kanalin icerigini
    // cihazda birakirdi.
    const storage = memoryStorage();
    saveRecent(['gizli-kanal-sorgusu'], storage);

    const raw = Object.values(storage.data).join('');
    expect(JSON.parse(raw)).toEqual(['gizli-kanal-sorgusu']);
    expect(raw).not.toContain('channelId');
    expect(raw).not.toContain('content');
  });

  it('temizleme kaydi siler', () => {
    const storage = memoryStorage();
    saveRecent(['a'], storage);
    clearRecent(storage);
    expect(loadRecent(storage)).toEqual([]);
  });

  it('DEPOLAMA HATASI arama hatasina donusmez', () => {
    // Ozel mod / kota dolu. Ucu de sessizce basarisiz olmalidir.
    expect(() => saveRecent(['a'], hostileStorage)).not.toThrow();
    expect(() => clearRecent(hostileStorage)).not.toThrow();
    expect(loadRecent(hostileStorage)).toEqual([]);
  });

  it('storage yoksa (null) guvenli calisir', () => {
    expect(loadRecent(null)).toEqual([]);
    expect(() => saveRecent(['a'], null)).not.toThrow();
    expect(() => clearRecent(null)).not.toThrow();
  });

  it('ust sinir yazarken de uygulanir', () => {
    const storage = memoryStorage();
    saveRecent(Array.from({ length: 40 }, (_, i) => `s${i}`), storage);
    expect(loadRecent(storage)).toHaveLength(MAX_RECENT);
  });
});
