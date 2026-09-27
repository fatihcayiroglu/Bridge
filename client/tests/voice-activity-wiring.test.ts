// client/tests/voice-activity-wiring.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KONUSMA ALGILAMA KABLOLAMASI — YAYIN VE GIZLILIK SOZLESMESI
// ════════════════════════════════════════════════════════════════════════════
// `voice-activity-wiring.ts` 133 satir ve HIC testi yoktu. Sunucu tarafi
// (`voice.ts:218`) `voice:activity`yi zaten YETKILENDIRILMIS sekilde yayiyor;
// bu modul istemci yarisini baglar. Bozulursa ya konusma gostergesi hic
// calismaz ya da YANLIS durum yayilir.
//
// ── BURADA TEST EDILEN INCE SOZLESMELER ─────────────────────────────────────
// 1. HAYALET YAYIN YOK: kanal yokken veya soket yokken `voice:activity`
//    GONDERILMEZ. Aksi halde kullanici bir kanalda degilken "konusuyor"
//    gorunebilirdi.
// 2. SOKET HER SEFERINDE TAZE COZULUR: `BridgeRegistry.get('rtc')` uzerinden.
//    Referans onbelleklenirse yeniden baglanma sonrasi EskI sokete yayin
//    yapilir ve gosterge sessizce olur.
// 3. DURDURMADA SIRA: `_handle` once temizlenir, SONRA `stop()` cagrilir.
//    Cunku `stop()` son bir `false` yayar; sira ters olsaydi kanal
//    temizlendikten sonra yayin denenirdi.
// 4. GIZLILIK: disari yalnizca TEK bir sayi (RMS) cikar — ses ornegi asla.
//
// NOT: gercek `BridgeRegistry` kullanilir (kanonik sahip kurali korunur);
// yalnizca olcum katmani ve ayar okuma sahtelenir.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Olcum katmani sahte: gercek AudioContext gerektirmesin ──────────────────
type VadCb = (speaking: boolean) => void;
type LevelCb = (rms: number) => void;
const _vadCagrilari: Array<{ stream: unknown; cb: VadCb; level: LevelCb }> = [];
let _vadDonsun: 'handle' | 'null' = 'handle';
const _durdurulan: string[] = [];

vi.mock('../js/core/voice-activity-detector.js', () => ({
  startVoiceActivityDetection: (stream: unknown, cb: VadCb, _tuning: unknown, level: LevelCb) => {
    _vadCagrilari.push({ stream, cb, level });
    if (_vadDonsun === 'null') return null;
    let konusuyor = false;
    const id = 'h' + _vadCagrilari.length;
    return {
      stop() { _durdurulan.push(id); konusuyor = false; cb(false); },  // gercekte oldugu gibi son `false`
      isSpeaking: () => konusuyor,
      _konustur: (v: boolean) => { konusuyor = v; cb(v); },
      _id: id,
    };
  },
}));
vi.mock('../js/core/voice/input-sensitivity.js', () => ({
  loadSensitivity: () => 'orta',
  tuningFor: (s: string) => ({ esik: 0.1, ad: s }),
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  registerVoiceActivityWiring, localSpeakingState, _resetVoiceActivityWiring,
} from '../js/core/voice-activity-wiring.ts';

const yayinlar: Array<{ event: string; payload: unknown }> = [];

/** Kanonik 'rtc' sahibi: islev + uzerinde `socket` ozelligi. */
function rtcKur(soketVar = true) {
  const rtc = (() => {}) as unknown as { socket?: unknown };
  if (soketVar) {
    rtc.socket = { emit: (event: string, payload: unknown) => { yayinlar.push({ event, payload }); } };
  }
  BridgeRegistry.unregister('rtc');
  BridgeRegistry.register('rtc', rtc as never);
}

beforeEach(() => {
  // SIRA ONEMLI: once modul durumu sifirlanir, SONRA sayaclar temizlenir.
  // Ters sirada, onceki testten kalan handle'in `stop()`u bu testin
  // sayaclarina dusuyordu ve testler kendi kirliligini olcuyordu.
  _resetVoiceActivityWiring();
  yayinlar.length = 0; _vadCagrilari.length = 0; _durdurulan.length = 0;
  _vadDonsun = 'handle';
  ['_bridgeStartLocalVAD', '_bridgeStopLocalVAD', 'voice:sensitivityChanged', 'voice:getInputLevel']
    .forEach(n => BridgeRegistry.unregister(n));
  rtcKur();
  registerVoiceActivityWiring();
});

const baslat = (kanal = 'kanal-1') =>
  BridgeRegistry.call('_bridgeStartLocalVAD', { sahte: 'stream' } as never, kanal as never);
const durdur = () => BridgeRegistry.call('_bridgeStopLocalVAD');
const sonVad = () => _vadCagrilari[_vadCagrilari.length - 1];

// ════════════════════════════════════════════════════════════════════════════
describe('kayitlar', () => {
  it('webrtc.ts’in aradigi TUM adlar kayitli', () => {
    // webrtc.ts:377/378/406 bu adlari cagirir; biri eksikse ozellik olur.
    expect({
      basla: BridgeRegistry.has('_bridgeStartLocalVAD'),
      dur:   BridgeRegistry.has('_bridgeStopLocalVAD'),
      ayar:  BridgeRegistry.has('voice:sensitivityChanged'),
      seviye: BridgeRegistry.has('voice:getInputLevel'),
    }).toEqual({ basla: true, dur: true, ayar: true, seviye: true });
  });
});

describe('konusma yayini', () => {
  it('konusma basladiginda voice:activity YAYILIR', () => {
    baslat('kanal-7');
    (sonVad() as never as { cb: VadCb }).cb(true);
    expect(yayinlar).toEqual([{ event: 'voice:activity', payload: { channelId: 'kanal-7', speaking: true } }]);
  });

  it('KANALA katilmadan yayin YAPILMAZ', () => {
    // Hicbir baslatma olmadan olcum geri cagrisi tetiklenemez; ama durdurma
    // sonrasi gelen gec bir geri cagri da yayin uretmemeli.
    baslat('kanal-1');
    const cb = (sonVad() as never as { cb: VadCb }).cb;
    durdur();
    yayinlar.length = 0;
    cb(true);                        // gec gelen geri cagri
    expect(yayinlar).toHaveLength(0);
  });

  it('SOKET yoksa cokmez ve yayin uretmez', () => {
    rtcKur(false);
    baslat('kanal-1');
    expect(() => (sonVad() as never as { cb: VadCb }).cb(true)).not.toThrow();
    expect(yayinlar).toHaveLength(0);
  });

  it('soket HER YAYINDA taze cozulur (eskimis referans tutulmaz)', () => {
    // Yeniden baglanmada rtc sahibi degisir; modul eski sokete yayin
    // yaparsa gosterge sessizce oluru.
    baslat('kanal-1');
    const cb = (sonVad() as never as { cb: VadCb }).cb;
    const yeni: Array<{ event: string; payload: unknown }> = [];
    const rtc2 = (() => {}) as unknown as { socket?: unknown };
    rtc2.socket = { emit: (event: string, payload: unknown) => { yeni.push({ event, payload }); } };
    BridgeRegistry.unregister('rtc');
    BridgeRegistry.register('rtc', rtc2 as never);

    cb(true);
    expect(yeni).toHaveLength(1);
    expect(yayinlar).toHaveLength(0);
  });
});

describe('durdurma', () => {
  it('durdurmada olcum kapatilir', () => {
    baslat();
    durdur();
    expect(_durdurulan).toHaveLength(1);
  });

  it('durdurmada SON bir `false` YAYILIR (takili gosterge olmaz)', () => {
    // ── ILK YAZIMDA BU IDDIAYI TERS KURDUM ──────────────────────────────
    // "son false yayilmamali" diye yazmistim; test dogru sekilde basarisiz
    // oldu. Kodu okuyunca gordum ki `_channelId` `stop()`tan SONRA
    // temizleniyor — yani son `false` KASITLI olarak yayiliyor.
    //
    // Ve dogru davranis budur: kullanici ayrilirken sunucuya "artik
    // konusmuyorum" denmezse UZAKTAKI kullanicilarda konusma gostergesi
    // KALICI olarak yanik kalirdi. Yanlis olan urun degil, benim
    // beklentimdi.
    baslat('kanal-3');
    yayinlar.length = 0;
    durdur();
    expect(yayinlar).toEqual([
      { event: 'voice:activity', payload: { channelId: 'kanal-3', speaking: false } },
    ]);
  });

  it('YENI baslatma oncekini durdurur (cift olcum hatti olmaz)', () => {
    baslat('a');
    baslat('b');
    expect(_durdurulan).toHaveLength(1);
    expect(_vadCagrilari).toHaveLength(2);
  });

  it('olcum kurulamazsa kanal durumu TEMIZ birakilir', () => {
    // AudioContext yoksa ozellik sessizce kapali olmali — yanlis "konusuyor"
    // durumu yayilmamali.
    _vadDonsun = 'null';
    baslat('kanal-x');
    expect(localSpeakingState()).toBe(false);
    expect(yayinlar).toHaveLength(0);
  });
});

describe('hassasiyet degisimi', () => {
  it('olcum AYNI akisla yeniden kurulur', () => {
    baslat('kanal-9');
    const oncekiAkis = sonVad().stream;
    BridgeRegistry.call('voice:sensitivityChanged');
    expect(_vadCagrilari).toHaveLength(2);
    expect(sonVad().stream).toBe(oncekiAkis);
    expect(_durdurulan).toHaveLength(1);
  });

  it('aktif olcum YOKKEN hicbir sey yapmaz', () => {
    BridgeRegistry.call('voice:sensitivityChanged');
    expect(_vadCagrilari).toHaveLength(0);
  });

  it('yeniden kurulumdan sonra kanal KORUNUR', () => {
    baslat('kanal-9');
    BridgeRegistry.call('voice:sensitivityChanged');
    yayinlar.length = 0;
    (sonVad() as never as { cb: VadCb }).cb(true);
    expect(yayinlar[0].payload).toEqual({ channelId: 'kanal-9', speaking: true });
  });
});

describe('giris seviyesi — gizlilik', () => {
  it('yalnizca RMS SAYISI disari verilir', () => {
    baslat();
    const olaylar: unknown[] = [];
    document.addEventListener('bridge:voice-input-level', (e) => olaylar.push((e as CustomEvent).detail));
    sonVad().level(0.42);
    // detay YALNIZCA { rms } icermeli — ses ornegi/buffer YOK.
    expect(olaylar).toEqual([{ rms: 0.42 }]);
    expect(BridgeRegistry.call('voice:getInputLevel')).toBe(0.42);
  });

  it('seviye yayini SUNUCUYA gitmez', () => {
    baslat();
    yayinlar.length = 0;
    sonVad().level(0.9);
    expect(yayinlar).toHaveLength(0);
  });
});
