// client/tests/error-boundary-capture.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GLOBAL HATA YAKALAMA — SINIR, SIZINTI VE DOGRU NORMALLESTIRME
// ════════════════════════════════════════════════════════════════════════════
// `ErrorBoundary.svelte` kapsam raporunda %0 idi: 60 ifade, 25 dal, HIC
// calistirilmamis. Oysa bu bilesen uygulamadaki TEK global hata yakalama
// noktasidir — `error-boundary-svelte.ts` onu onyuklemede monte eder ve
// `window.onerror` / `unhandledrejection` buradan gecer.
//
// ── NEDEN BU DALLAR ONEMLI ──────────────────────────────────────────────────
// 1. SINIRSIZ BUYUME: yakalanan hatalar bir dizide birikir. `slice(-20)`
//    olmasaydi, hata dongusune giren bir sayfa (her karede atan bir efekt)
//    bellegi sinirsiz buyuturdu. Soak fazinin aradigi kusur sinifi tam olarak
//    budur.
//
// 2. DINLEYICI SIZINTISI: bilesen `window`a IKI dinleyici baglar. onMount
//    temizleyicisi dinleyicileri kaldirmazsa, her yeniden monte islemi bir
//    kopya daha birakir; hatalar cogalarak sayilir ve kapatilan bilesenin
//    kapanisi (closure) sonsuza dek canli kalir.
//
// 3. DOGRULUK: `Error` olmayan bir deger atilabilir (`throw 'metin'`).
//    Normallestirme yanlissa gunluge `[object Object]` duser ve hata
//    teshis edilemez hale gelir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ErrorBoundary from '../js/core/ErrorBoundary.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  // Delegate to the canonical catalog `t` instead of hand-rolling a stub: a
  // `fallback ?? key` stub returns the raw key for every call that relies on
  // the catalog entry (e.g. `t('ui_error_count', undefined, { count })`), so
  // assertions on the rendered text could never pass.
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
const sentryCagrilari: Array<{ err: unknown; ctx: unknown }> = [];

const panel = () => { flushSync(); return host.querySelector('.eb-dev-panel'); };
const basligiOku = () => { flushSync(); return host.querySelector('.eb-dev-header span')?.textContent ?? ''; };
const satirlar = () => { flushSync(); return [...host.querySelectorAll('.eb-dev-item')]; };

/**
 * Ayrintili listeyi acar.
 * SIRA KRITIK: Svelte DOM'u mikrotaskta gunceller. Once `flushSync()`
 * cagrilmazsa panel henuz basilmamis olur, dugme `null` doner ve test
 * "bilesen bozuk" gibi gorunen bir TypeError ile duser. Ilk yazimda tam
 * olarak bu oldu — kusur testte, uründe degildi.
 */
function panelAc(): void {
  flushSync();
  const dugme = host.querySelector('.eb-dev-header button') as HTMLButtonElement | null;
  if (!dugme) throw new Error('panel acilamadi: dev paneli basilmamis');
  dugme.click();
  flushSync();
}

/** jsdom'da PromiseRejectionEvent her zaman yok; olayi elle kurariz. */
function reddiYayinla(reason: unknown) {
  const ev = new Event('unhandledrejection') as Event & { reason?: unknown };
  ev.reason = reason;
  window.dispatchEvent(ev);
}
function hatayiYayinla(error: unknown, message = 'bir sey oldu') {
  const ev = new Event('error') as Event & { error?: unknown; message?: string };
  ev.error = error;
  ev.message = message;
  window.dispatchEvent(ev);
}

beforeEach(() => {
  sentryCagrilari.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  BridgeRegistry.unregister('captureUIError');
  BridgeRegistry.unregister('clearUIErrors');
  BridgeRegistry.unregister('sentry');
  instance = mount(ErrorBoundary, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
});

// ════════════════════════════════════════════════════════════════════════════
describe('kayit', () => {
  it('captureUIError ve clearUIErrors REGISTRY’ye kaydolur', () => {
    // Uygulamanin geri kalani hatalari bu adlarla bildirir; eksikse
    // bildirimler sessizce kaybolur.
    expect({
      capture: BridgeRegistry.has('captureUIError'),
      clear:   BridgeRegistry.has('clearUIErrors'),
    }).toEqual({ capture: true, clear: true });
  });
});

describe('yakalama yollari', () => {
  it('window error olayi YAKALANIR', () => {
    hatayiYayinla(new Error('patlama-1'));
    expect(basligiOku()).toContain('1');
    expect(satirlar).toBeTruthy();
  });

  it('unhandledrejection YAKALANIR', () => {
    reddiYayinla(new Error('reddedildi-1'));
    expect(basligiOku()).toContain('1');
  });

  it('registry uzerinden dogrudan bildirim YAKALANIR', () => {
    BridgeRegistry.call('captureUIError', new Error('elle'), 'TestBilesen');
    expect(basligiOku()).toContain('1');
  });

  it('HIC hata yokken panel GORUNMEZ', () => {
    // Bos bir hata paneli her sayfada gorunen kalici bir gurultu olurdu.
    expect(panel()).toBeNull();
  });
});

describe('normallestirme', () => {
  const goster = () => host.querySelector('.eb-msg')?.textContent ?? '';

  it('Error nesnesinin MESAJI kullanilir', () => {
    BridgeRegistry.call('captureUIError', new Error('gercek-mesaj'), 'X');
    panelAc();
    expect(goster()).toBe('gercek-mesaj');
  });

  it('Error OLMAYAN deger metne cevrilir', () => {
    // `throw 'metin'` gecerlidir; [object Object] dusmemeli.
    BridgeRegistry.call('captureUIError', 'duz-metin-hata', 'X');
    panelAc();
    expect(goster()).toBe('duz-metin-hata');
  });

  it('error alani bos olan olay MESAJA duser', () => {
    hatayiYayinla(undefined, 'yalnizca-mesaj');
    panelAc();
    expect(goster()).toBe('yalnizca-mesaj');
  });

  it('BILESEN adi gosterilir', () => {
    BridgeRegistry.call('captureUIError', new Error('x'), 'SohbetPaneli');
    panelAc();
    expect(host.querySelector('.eb-comp')?.textContent).toBe('[SohbetPaneli]');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SINIRSIZ BUYUMEYE KARSI
// ════════════════════════════════════════════════════════════════════════════
describe('bellek siniri', () => {
  it('EN FAZLA 20 hata tutulur', () => {
    // Hata dongusune giren bir sayfa bellegi sinirsiz buyutmemeli.
    for (let i = 0; i < 25; i++) {
      BridgeRegistry.call('captureUIError', new Error('h' + i), 'D');
    }
    expect(basligiOku()).toContain('20');
  });

  it('sinira ulasildiginda EN YENI hatalar tutulur', () => {
    // Eskiyi tutup yeniyi atmak, en guncel arizayi gizlerdi.
    for (let i = 0; i < 25; i++) {
      BridgeRegistry.call('captureUIError', new Error('h' + i), 'D');
    }
    panelAc();
    const mesajlar = [...host.querySelectorAll('.eb-msg')].map(e => e.textContent);
    expect(mesajlar).toContain('h24');
    expect(mesajlar).not.toContain('h0');
  });

  it('clearUIErrors listeyi bosaltir ve paneli GIZLER', () => {
    BridgeRegistry.call('captureUIError', new Error('x'), 'D');
    expect(panel()).not.toBeNull();
    BridgeRegistry.call('clearUIErrors');
    expect(panel()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DINLEYICI SIZINTISI
// ════════════════════════════════════════════════════════════════════════════
describe('dinleyici temizligi', () => {
  it('UNMOUNT sonrasi window dinleyicileri KALDIRILIR', () => {
    // Sizinti kaniti: sokulmus bilesen hala hata yakaliyorsa kapanisi
    // (closure) canli kalmis demektir. Sentry kancasi gozlemlenebilir bir
    // yan etki verdigi icin olcum icin kullanilir.
    BridgeRegistry.register('sentry', {
      captureException: (err: unknown, ctx: unknown) => { sentryCagrilari.push({ err, ctx }); },
    } as never);

    hatayiYayinla(new Error('monteliyken'));
    expect(sentryCagrilari).toHaveLength(1);

    unmount(instance!);
    instance = null;

    // NOT: burada bilerek YALNIZCA `unhandledrejection` yayinlanir. Sokulmus
    // bir pencerede 'error' olayi jsdom tarafindan YAKALANMAMIS ISTISNA olarak
    // yukseltilir ve kosucuyu kirletir. Temizleyici iki dinleyiciyi AYNI
    // fonksiyonda kaldirdigi icin birinin kalkmis olmasi digerinin de
    // kalktiginin kanitidir.
    reddiYayinla(new Error('sokulduktan sonra'));
    expect(sentryCagrilari).toHaveLength(1);   // ARTMAMALI
  });

  it('IKI KEZ monte edilirse hata IKI KEZ sayilmaz', () => {
    // Onceki ornek dinleyicisini birakmis olsaydi tek olay iki kez islenirdi.
    BridgeRegistry.register('sentry', {
      captureException: (err: unknown, ctx: unknown) => { sentryCagrilari.push({ err, ctx }); },
    } as never);

    unmount(instance!);
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    instance = mount(ErrorBoundary, { target: host2 });
    flushSync();

    hatayiYayinla(new Error('tek-olay'));
    expect(sentryCagrilari).toHaveLength(1);

    unmount(instance!); instance = null; host2.remove();
  });
});

describe('sentry aktarimi', () => {
  it('kayitli sentry’ye BILESEN baglami ile iletilir', () => {
    BridgeRegistry.register('sentry', {
      captureException: (err: unknown, ctx: unknown) => { sentryCagrilari.push({ err, ctx }); },
    } as never);
    const hata = new Error('iletilecek');
    BridgeRegistry.call('captureUIError', hata, 'VoicePanel');
    expect(sentryCagrilari).toEqual([{ err: hata, ctx: { extra: { component: 'VoicePanel' } } }]);
  });

  it('sentry KAYITLI DEGILSE cokmez', () => {
    // Uretimde Sentry opsiyoneldir; yoklugu hata yakalamayi bozmamali.
    expect(() => BridgeRegistry.call('captureUIError', new Error('x'), 'D')).not.toThrow();
    expect(basligiOku()).toContain('1');
  });
});
