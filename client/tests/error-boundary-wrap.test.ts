// client/tests/error-boundary-wrap.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// HATA SINIRI — `errorBoundary.wrap` SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
// `error-boundary-svelte.ts` HİÇ test edilmemişti. İçindeki `wrap` üretim
// yolunda GERÇEKTEN kullanılıyor (`js/app.ts:262` uygulama önyüklemesini
// bununla sarıyor). Yani buradaki bir hata doğrudan "uygulama açılmıyor"
// demektir.
//
// ── SÖZLEŞME ────────────────────────────────────────────────────────────────
// `wrap(fn)` çağrıldığında:
//   * fn SENKRON atarsa      -> yutulur, loglanır, undefined döner
//   * fn PROMISE reddederse  -> yutulur, loglanır (unhandled rejection OLMAZ)
//   * fn normal dönerse      -> değer AYNEN geçer (sarmalayıcı sonucu bozmaz)
//
// Üçüncü madde kolayca gözden kaçar: hata yakalayan bir sarmalayıcı, başarı
// yolunda dönüş değerini yutarsa sessizce veri kaybettirir.
//
// ── `unmountErrorBoundary` NEDEN TEST EDİLMİYOR ─────────────────────────────
// O fonksiyon yalnızca `_instance = null` yapar; Svelte bileşenini gerçekten
// SÖKMEZ. Ama üretim kodunda HİÇBİR YERDEN çağrılmıyor (arandı: yalnızca
// kendi tanımı). Ulaşılamayan bir davranışı "doğru" diye teste yazmak,
// eksikliği doğrulanmış gibi göstermek olurdu; bu yüzden burada iddia
// EDİLMİYOR ve durum açıkça not ediliyor.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const _hatalar: unknown[][] = [];
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    error: (...a: unknown[]) => { _hatalar.push(a); },
  }),
}));
// Svelte bileşenini monte etmek bu testin konusu degil — modul yuklenirken
// kendiliginden monte oldugu icin sahteleniyor.
vi.mock('svelte', () => ({ mount: () => ({}) }));
vi.mock('../js/core/ErrorBoundary.svelte', () => ({ default: {} }));

import { errorBoundary } from '../js/core/error-boundary-svelte.ts';

beforeEach(() => { _hatalar.length = 0; });

describe('errorBoundary.wrap', () => {
  it('SENKRON hatayi yutar ve loglar', () => {
    const patlayan = () => { throw new Error('patladi'); };
    const sarili = errorBoundary.wrap(patlayan, 'test-baglam');
    expect(() => sarili()).not.toThrow();
    expect(_hatalar).toHaveLength(1);
    expect(String(_hatalar[0][0])).toContain('test-baglam');
  });

  it('senkron hata sonrasi UNDEFINED doner', () => {
    const sarili = errorBoundary.wrap(() => { throw new Error('x'); });
    expect(sarili()).toBeUndefined();
  });

  it('BASARILI donus degeri AYNEN gecer', () => {
    // Sarmalayici basari yolunda deger yutarsa sessiz veri kaybi olur.
    const sarili = errorBoundary.wrap((a: unknown, b: unknown) => Number(a) + Number(b));
    expect(sarili(2, 3)).toBe(5);
    expect(_hatalar).toHaveLength(0);
  });

  it('ARGUMANLAR degistirilmeden iletilir', () => {
    const gorulen: unknown[] = [];
    const sarili = errorBoundary.wrap((...a: unknown[]) => { gorulen.push(...a); });
    sarili('a', 1, null);
    expect(gorulen).toEqual(['a', 1, null]);
  });

  it('PROMISE reddini yutar (unhandled rejection olmaz)', async () => {
    const sarili = errorBoundary.wrap(async () => { throw new Error('async patladi'); });
    await expect(sarili()).resolves.toBeUndefined();
    expect(_hatalar).toHaveLength(1);
  });

  it('COZULEN promise degeri korunur', async () => {
    const sarili = errorBoundary.wrap(async () => 'deger');
    await expect(sarili()).resolves.toBe('deger');
    expect(_hatalar).toHaveLength(0);
  });

  it('varsayilan baglam "app" olarak loglanir', () => {
    const sarili = errorBoundary.wrap(() => { throw new Error('y'); });
    sarili();
    expect(String(_hatalar[0][0])).toContain('app');
  });

  it('promise BENZERI olmayan donus promise gibi islenmez', () => {
    // `.catch` yoksa deger dokunulmadan donmeli.
    const sarili = errorBoundary.wrap(() => ({ catch: 'bu bir islev degil' }));
    expect(sarili()).toEqual({ catch: 'bu bir islev degil' });
  });
});
