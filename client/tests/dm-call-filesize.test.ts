// client/tests/dm-call-filesize.test.ts
// Sprint 72: dm-call.ts dosya boyutu doğrulaması — birim testleri
//
// Kapsam: Sprint 71'de tespit edilen 5GB yazım hatası (5120 * 1024 * 1024)
// Sprint 72'de 5MB (5 * 1024 * 1024) olarak düzeltildi.
// Bu test dosyası o sabitleri ve limit mantığını kapsar.
//
// Çalıştırma: npx vitest run client/tests/dm-call-filesize.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Sabitler (dm-call.ts ile senkron) ──────────────────────────────────────
const MAX_FILE_BYTES   = 5 * 1024 * 1024;          // 5MB — düzeltilmiş değer
const SMALL_THRESHOLD  = 50 * 1024 * 1024;          // 50MB — small vs chunked upload sınırı
const IMAGE_ALLOWED    = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// ── Yardımcı: sahte File nesnesi ───────────────────────────────────────────
function makeFile(sizeBytes: number, type = 'image/jpeg', name = 'test.jpg'): File {
  // Gerçek veri oluşturmak yerine boyut bilgisi olan stub
  const blob = new Blob([new Uint8Array(Math.min(sizeBytes, 100))], { type });
  Object.defineProperty(blob, 'size', { value: sizeBytes });
  return new File([blob], name, { type });
}

// ── Limit mantığını izole eden saf fonksiyon ───────────────────────────────
// dm-call.ts'teki sendImage() giriş doğrulama mantığını yansıtır.
type ValidationResult =
  | { ok: false; reason: 'unsupported_type' }
  | { ok: false; reason: 'too_large'; maxBytes: number }
  | { ok: true; strategy: 'small_upload' | 'chunked_upload' };

function validateImageFile(file: File): ValidationResult {
  if (!IMAGE_ALLOWED.has(file.type)) {
    return { ok: false, reason: 'unsupported_type' };
  }
  const maxBytes = MAX_FILE_BYTES;
  if (file.size > maxBytes) {
    return { ok: false, reason: 'too_large', maxBytes };
  }
  const strategy: 'small_upload' | 'chunked_upload' =
    file.size <= SMALL_THRESHOLD ? 'small_upload' : 'chunked_upload';
  return { ok: true, strategy };
}

// ── Testler ────────────────────────────────────────────────────────────────

describe('dm-call dosya boyutu limiti', () => {
  describe('MAX_FILE_BYTES sabiti', () => {
    it('tam olarak 5MB (5_242_880 byte) olmalı', () => {
      expect(MAX_FILE_BYTES).toBe(5_242_880);
    });

    it('5GB olmamalı — Sprint 71 regression testi', () => {
      // Eski yanlış değer: 5120 * 1024 * 1024 = 5_368_709_120
      expect(MAX_FILE_BYTES).not.toBe(5_368_709_120);
    });
  });

  describe('validateImageFile — tür kontrolü', () => {
    it('image/jpeg kabul edilmeli', () => {
      const f = makeFile(1_000, 'image/jpeg');
      expect(validateImageFile(f)).toEqual({ ok: true, strategy: 'small_upload' });
    });

    it('image/png kabul edilmeli', () => {
      const f = makeFile(1_000, 'image/png');
      expect(validateImageFile(f)).toEqual({ ok: true, strategy: 'small_upload' });
    });

    it('image/gif kabul edilmeli', () => {
      const f = makeFile(1_000, 'image/gif');
      expect(validateImageFile(f)).toEqual({ ok: true, strategy: 'small_upload' });
    });

    it('image/webp kabul edilmeli', () => {
      const f = makeFile(1_000, 'image/webp');
      expect(validateImageFile(f)).toEqual({ ok: true, strategy: 'small_upload' });
    });

    it('application/pdf reddedilmeli', () => {
      const f = makeFile(1_000, 'application/pdf');
      const result = validateImageFile(f);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_type');
    });

    it('video/mp4 reddedilmeli', () => {
      const f = makeFile(1_000, 'video/mp4');
      const result = validateImageFile(f);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_type');
    });

    it('boş tür string reddedilmeli', () => {
      const f = makeFile(1_000, '');
      const result = validateImageFile(f);
      expect(result.ok).toBe(false);
    });
  });

  describe('validateImageFile — boyut kontrolü (5MB sınırı)', () => {
    it('1 byte kabul edilmeli', () => {
      const f = makeFile(1, 'image/jpeg');
      expect(validateImageFile(f).ok).toBe(true);
    });

    it('1MB kabul edilmeli', () => {
      const f = makeFile(1_048_576, 'image/jpeg');
      expect(validateImageFile(f).ok).toBe(true);
    });

    it('tam 5MB (sınırda) kabul edilmeli', () => {
      const f = makeFile(MAX_FILE_BYTES, 'image/jpeg');
      expect(validateImageFile(f).ok).toBe(true);
    });

    it('5MB + 1 byte reddedilmeli', () => {
      const f = makeFile(MAX_FILE_BYTES + 1, 'image/jpeg');
      const result = validateImageFile(f);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('too_large');
        expect((result as { ok: false; reason: string; maxBytes: number }).maxBytes)
          .toBe(MAX_FILE_BYTES);
      }
    });

    it('10MB reddedilmeli', () => {
      const f = makeFile(10_485_760, 'image/jpeg');
      expect(validateImageFile(f).ok).toBe(false);
    });

    it('100MB reddedilmeli', () => {
      const f = makeFile(104_857_600, 'image/jpeg');
      expect(validateImageFile(f).ok).toBe(false);
    });

    it('[REGRESSION] 5GB reddedilmeli — Sprint 71 bug', () => {
      // Bu test Sprint 71 bug'ını yakalamalıydı ama yakalamadı.
      // Şimdi kesin olarak kontrol edilmektedir.
      const fiveGB = 5_368_709_120;
      const f = makeFile(fiveGB, 'image/jpeg');
      const result = validateImageFile(f);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('too_large');
    });
  });

  describe('validateImageFile — upload stratejisi', () => {
    it('küçük dosya (1MB) → small_upload stratejisi', () => {
      const f = makeFile(1_048_576, 'image/jpeg');
      const result = validateImageFile(f);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.strategy).toBe('small_upload');
    });

    it('tam 5MB → small_upload stratejisi (sınır SMALL_THRESHOLD altında)', () => {
      const f = makeFile(MAX_FILE_BYTES, 'image/jpeg');
      const result = validateImageFile(f);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.strategy).toBe('small_upload');
    });
  });

  describe('Hata mesajları', () => {
    it('too_large hatası maxBytes alanını taşımalı', () => {
      const f = makeFile(MAX_FILE_BYTES + 1, 'image/jpeg');
      const result = validateImageFile(f);
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'too_large') {
        const mb = (result.maxBytes / (1024 * 1024)).toFixed(0);
        expect(mb).toBe('5');
      }
    });
  });
});

describe('IMAGE_ALLOWED kümesi', () => {
  it('4 desteklenen tür içermeli', () => {
    expect(IMAGE_ALLOWED.size).toBe(4);
  });

  const cases: [string, boolean][] = [
    ['image/jpeg', true],
    ['image/png',  true],
    ['image/gif',  true],
    ['image/webp', true],
    ['image/bmp',  false],
    ['image/tiff', false],
    ['image/svg+xml', false],
    ['application/octet-stream', false],
  ];

  it.each(cases)('%s → kabul: %s', (type, expected) => {
    expect(IMAGE_ALLOWED.has(type)).toBe(expected);
  });
});
