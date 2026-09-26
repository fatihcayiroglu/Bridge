// client/tests/input-sensitivity.test.ts
//
// GİRİŞ HASSASİYETİ — ses etkinleştirme eşiği.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// VAD eşikleri sabit kodluydu (`VAD_TUNING.openRms = 0.020`) ve kullanıcının
// yapabileceği hiçbir şey yoktu. Gürültülü odada mikrofon sürekli açılıyor,
// sessiz mikrofonda konuşma hiç algılanmıyordu.
//
// ── KORUNAN KARARLAR ──────────────────────────────────────────────────────
//   • İKİNCİ bir ses hattı yok — mevcut VAD'in `tuning` parametresi türetilir
//   • histerezis korunur (kapanış eşiği açılış eşiğinin ALTINDA)
//   • bozuk/aşırı değer ürünü bozmaz (kelepçelenir)
//   • depolama hatası ses özelliğini bozmaz
//   • yalnızca tek bir sayı (RMS) tutulur — ses örneği YOK

import { describe, it, expect, vi } from 'vitest';
import {
  tuningFor, clampThreshold, parseSensitivity, loadSensitivity, saveSensitivity,
  levelToPercent, SENSITIVITY_RANGE, DEFAULT_SENSITIVITY,
} from '../js/core/voice/input-sensitivity.ts';
import { VAD_TUNING, createSpeakingGate } from '../js/core/voice-activity-detector.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
  };
}

const hostileStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('quota'); },
  removeItem: () => { throw new Error('denied'); },
};

// ════════════════════════════════════════════════════════════════════════════
describe('tuningFor — VAD ayarı türetme', () => {
  it('otomatik mod ÜRÜNÜN kalibre edilmiş eşiklerini kullanır', () => {
    // Otomatik modda kendi sayımızı uydurmayız.
    expect(tuningFor({ mode: 'auto', threshold: 0.09 })).toBe(VAD_TUNING);
  });

  it('manuel mod açılış eşiğini kullanıcı değerine alır', () => {
    expect(tuningFor({ mode: 'manual', threshold: 0.05 }).openRms).toBe(0.05);
  });

  it('HİSTEREZİS korunur — kapanış eşiği açılışın ALTINDA', () => {
    // Tek eşik, ses eşik civarında titrerken göstergeyi saniyede onlarca kez
    // açıp kapatırdı.
    for (const threshold of [0.005, 0.02, 0.05, 0.12]) {
      const tuning = tuningFor({ mode: 'manual', threshold });
      expect(tuning.closeRms).toBeLessThan(tuning.openRms);
      expect(tuning.closeRms).toBeGreaterThan(0);
    }
  });

  it('zamanlama parametreleri korunur', () => {
    const tuning = tuningFor({ mode: 'manual', threshold: 0.05 });
    expect(tuning.hangMs).toBe(VAD_TUNING.hangMs);
    expect(tuning.intervalMs).toBe(VAD_TUNING.intervalMs);
  });

  it('aşırı değerler kelepçelenir', () => {
    expect(tuningFor({ mode: 'manual', threshold: 99 }).openRms).toBe(SENSITIVITY_RANGE.max);
    expect(tuningFor({ mode: 'manual', threshold: -5 }).openRms).toBe(SENSITIVITY_RANGE.min);
  });

  it('türetilen ayar GERÇEK gate ile çalışır', () => {
    // Sözleşme kanıtı: türetilen nesne VAD'in beklediği şekildedir.
    const gate = createSpeakingGate(tuningFor({ mode: 'manual', threshold: 0.05 }));
    expect(gate.push(0.06, 1000)).toBe(true);      // eşiğin üstü → konuşuyor
    expect(gate.push(0.01, 1000)).toBe(null);      // hang süresi dolmadı
    expect(gate.push(0.01, 1000 + VAD_TUNING.hangMs + 10)).toBe(false);
  });

  it('DÜŞÜK eşik, otomatikte algılanmayan sesi algılar', () => {
    // Özelliğin var oluş nedeni: sessiz mikrofon.
    const quiet = 0.008;                            // VAD_TUNING.openRms altı
    expect(createSpeakingGate(VAD_TUNING).push(quiet, 0)).toBe(null);
    expect(createSpeakingGate(tuningFor({ mode: 'manual', threshold: 0.005 })).push(quiet, 0)).toBe(true);
  });

  it('YÜKSEK eşik, arka plan gürültüsünü eler', () => {
    const noise = 0.03;                             // VAD_TUNING.openRms üstü
    expect(createSpeakingGate(VAD_TUNING).push(noise, 0)).toBe(true);
    expect(createSpeakingGate(tuningFor({ mode: 'manual', threshold: 0.06 })).push(noise, 0)).toBe(null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('clampThreshold', () => {
  it('aralık içinde değeri korur', () => expect(clampThreshold(0.05)).toBe(0.05));
  it('aralığa kelepçeler', () => {
    expect(clampThreshold(0)).toBe(SENSITIVITY_RANGE.min);
    expect(clampThreshold(1)).toBe(SENSITIVITY_RANGE.max);
  });
  it('sayı olmayan değer varsayılana düşer', () => {
    for (const bad of [NaN, 'x', null, undefined, {}]) {
      expect(clampThreshold(bad)).toBe(DEFAULT_SENSITIVITY.threshold);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kalıcılık', () => {
  it('yazılan ayar geri okunur', () => {
    const storage = memoryStorage();
    saveSensitivity({ mode: 'manual', threshold: 0.04 }, storage);
    expect(loadSensitivity(storage)).toEqual({ mode: 'manual', threshold: 0.04 });
  });

  it('YALNIZCA mod ve eşik saklanır — ses örneği YOK', () => {
    const storage = memoryStorage();
    saveSensitivity({ mode: 'manual', threshold: 0.04 }, storage);
    const raw = Object.values(storage.data).join('');
    expect(JSON.parse(raw)).toEqual({ mode: 'manual', threshold: 0.04 });
    expect(Object.keys(JSON.parse(raw))).toHaveLength(2);
  });

  it('bozuk kayıt varsayılana düşer', () => {
    expect(parseSensitivity('{bozuk')).toEqual(DEFAULT_SENSITIVITY);
    expect(parseSensitivity(null)).toEqual(DEFAULT_SENSITIVITY);
  });

  it('tanınmayan mod otomatiğe düşer (güvenli varsayılan)', () => {
    expect(parseSensitivity('{"mode":"hack","threshold":0.05}').mode).toBe('auto');
  });

  it('depolanan aşırı eşik okunurken kelepçelenir', () => {
    expect(parseSensitivity('{"mode":"manual","threshold":99}').threshold)
      .toBe(SENSITIVITY_RANGE.max);
  });

  it('DEPOLAMA HATASI ses özelliğini bozmaz', () => {
    expect(() => saveSensitivity(DEFAULT_SENSITIVITY, hostileStorage)).not.toThrow();
    expect(loadSensitivity(hostileStorage)).toEqual(DEFAULT_SENSITIVITY);
    expect(loadSensitivity(null)).toEqual(DEFAULT_SENSITIVITY);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('levelToPercent — ölçer ölçeği', () => {
  it('sessizlik sıfırdır', () => {
    expect(levelToPercent(0)).toBe(0);
    expect(levelToPercent(-1)).toBe(0);
    expect(levelToPercent(NaN)).toBe(0);
  });

  it('artan ses artan yüzde verir', () => {
    expect(levelToPercent(0.01)).toBeLessThan(levelToPercent(0.05));
    expect(levelToPercent(0.05)).toBeLessThan(levelToPercent(0.11));
  });

  it('0..100 aralığını aşmaz', () => {
    expect(levelToPercent(99)).toBeLessThanOrEqual(100);
    expect(levelToPercent(0.0001)).toBeGreaterThanOrEqual(0);
  });

  it('LOGARİTMİK — normal konuşma ölçeğin solunda sıkışmaz', () => {
    // Doğrusal olsaydı 0.02 (tipik konuşma) ~%17'de kalır, gösterge
    // okunmaz olurdu.
    expect(levelToPercent(0.02)).toBeGreaterThan(25);
  });
});
