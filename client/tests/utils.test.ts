// client/tests/utils.test.ts
// core/utils.ts — CANLI sözleşme testleri (native Vitest/ESM).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — KISMİ EMEKLİLİK + NATIVE MIGRATION
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ: dosya `loadClientModule()` içinde CJS `require('../js/core/utils.js')`
// kullanıyordu ve export'ları `global`e yayıyordu. Bu, Jest'in `moduleNameMapper`
// + `babel-jest` kurulumuna bağlıydı; Vitest'te böyle bir eşleme yok, bu yüzden
// süit "Cannot find module '../js/core/utils.js'" ile toplanamıyor ve içindeki
// 16 test "skipped" olarak sayılıyordu.
//
// ESKİ TESTİN KAPSADIĞI 6 API — bugünkü durum (kaynak taraması, types/dist/tests hariç):
//
//   escHtml       → CANLI  (js/core/utils.ts:1)                 → burada test edilir
//   toast         → CANLI  ama SÖZLEŞMESİ DEĞİŞTİ (utils.ts:9)  → yeni sözleşme test edilir
//   cssColor      → TAŞINDI: artık paylaşılan util değil, bileşen-içi yerel
//                   fonksiyon (GroupDmPanel.svelte:104, VoicePanel.svelte:158)
//   initials      → TAŞINDI: bileşen-içi yerel fonksiyon
//                   (GroupDmPanel.svelte:108, MemberListPanel.svelte:42)
//   safeFileUrl   → KALDIRILDI: kaynakta 0 eşleşme
//   closeModal    → KALDIRILDI: kaynakta 0 eşleşme
//
// `toast` Faz 8'de yeniden yazıldı: artık DOM elemanı OLUŞTURMUYOR; alıcıya
// `BridgeRegistry` üzerinden devrediyor (utils.ts:13-21). Eski "toast DOM'a
// eklenir / süre dolunca kaldırılır" iddiaları bu yüzden ölü sözleşmedir;
// yerlerine BUGÜNKÜ devretme sözleşmesi test edilir.
//
// GÜVENLİK NOTU: `escHtml` bir XSS savunmasıdır ve kapsamı KORUNMUŞTUR.
// `safeFileUrl` (URL doğrulama) üretimden tamamen kalkmıştır — bu bir
// gözlem olarak kaydedilir; bu turda üretim kodu değiştirilmemiştir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { escHtml, toast } from '../js/core/utils.ts';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

afterEach(() => {
  BridgeRegistry.unregister('toast');
  delete (globalThis as Record<string, unknown>).toast;
  vi.restoreAllMocks();
});

describe('escHtml() — XSS kaçışı (canlı)', () => {
  it('< > & " karakterlerini escape eder', () => {
    expect(escHtml('<script>')).toBe('&lt;script&gt;');
    expect(escHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escHtml('a & b')).toBe('a &amp; b');
  });

  it('tek tırnağı da escape eder', () => {
    // Üretim sözleşmesi ' karakterini de kapsar (utils.ts:2).
    expect(escHtml("it's")).toBe('it&#39;s');
  });

  it('sayıları string\'e çevirir', () => {
    expect(escHtml(42)).toBe('42');
  });

  it('boş / null / undefined için boş string döndürür', () => {
    expect(escHtml('')).toBe('');
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('script enjeksiyonu düz metne dönüşür (regresyon)', () => {
    const out = escHtml('<img src=x onerror="alert(1)">');

    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('"');
  });
});

describe('toast() — BUGÜNKÜ devretme sözleşmesi', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('kayıtlı BridgeRegistry alıcısına devreder', () => {
    const received: unknown[][] = [];
    BridgeRegistry.register('toast', ((...args: unknown[]) => { received.push(args); }) as AnyFn);

    toast('merhaba', 'error', 1234);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(['merhaba', 'error', 1234]);
  });

  it('DOM elemanı OLUŞTURMAZ (Faz 8 sözleşmesi)', () => {
    BridgeRegistry.register('toast', (() => {}) as AnyFn);

    toast('mesaj');

    // Eski uygulama #toast-container'a span ekliyordu; artık alıcı sorumlu.
    expect(document.body.innerHTML).toBe('');
  });

  it('alıcı yoksa legacy global sözleşmeye düşer', () => {
    const calls: unknown[][] = [];
    (globalThis as Record<string, unknown>).toast = (...args: unknown[]) => { calls.push(args); };

    toast('geri düşüş', 'info');

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('geri düşüş');
  });

  it('hiç alıcı yoksa SESSİZCE KAYBOLMAZ ve hata fırlatmaz', () => {
    // Alıcı da global de yokken logger'a düşer (utils.ts:21).
    expect(() => toast('kimse dinlemiyor', 'error')).not.toThrow();
  });

  it('varsayılan tip "info"dur', () => {
    const received: unknown[][] = [];
    BridgeRegistry.register('toast', ((...args: unknown[]) => { received.push(args); }) as AnyFn);

    toast('varsayılan');

    expect(received[0][1]).toBe('info');
  });
});
