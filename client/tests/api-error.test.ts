// client/tests/api-error.test.ts
// Faz 8.1 — `handleApiError()` giriş noktasının davranış testleri.
//
// Legacy `tests/api-error-toast.test.ts` (jest.mock tabanlı, kaldırılmış
// `js/core/api-error-toast` modülünü hedefliyordu) yerine geçer. Taşınan ve
// düşürülen sözleşmelerin dökümü için bkz. Faz 8.1 raporu.
//
// Testler GERÇEK toast zincirinden geçer: handleApiError → utils.toast →
// BridgeRegistry('toast') → ApiErrorToast.svelte → DOM. Böylece "toast
// çağrıldı" değil, "kullanıcı gördü" doğrulanır.

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { setLocale } from '../js/core/i18n/index.ts';
import { mount, unmount, flushSync } from 'svelte';
import ApiErrorToast from '../js/core/ApiErrorToast.svelte';

// DİL SABİTLENİR. `handleApiError` metinleri `t()` üzerinden çözer
// (api-error.ts:118). jsdom'da `navigator.language` = 'en-US' olduğu için
// i18n ASENKRON olarak İngilizce tabloyu yükler; bu dosya Türkçe parçalar
// iddia ettiğinden, tablo yüklenmeden önce koşarsa geçiyor, sonra koşarsa
// kalıyordu — yani sıralamaya bağlı, gizli bir kırılganlıktı.
// Dil açıkça 'tr' yapılarak iddia edilen sözleşme belirlenimci hâle getirilir.
beforeAll(async () => { await setLocale('tr'); });
import {
  handleApiError,
  toastForbidden,
  toastRateLimit,
  toastNetworkError,
  toastSuccess,
} from '../js/core/api-error.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const shown = () => { flushSync(); return [...host.querySelectorAll('.toast')]; };
const firstText = () => shown()[0]?.querySelector('.toast-text')?.textContent ?? '';
const firstType = () => shown()[0]?.getAttribute('data-toast-type') ?? '';

/** Gerçek Response yerine test çiftliği — jsdom Response gövdesi tek kullanımlık. */
function res(status: number, url = '/api/test'): Response {
  return { ok: status < 400, status, url, statusText: '', headers: new Headers() } as unknown as Response;
}

function err(message: string, name = 'Error'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  host.id = 'toast-container';
  document.body.appendChild(host);
  instance = mount(ApiErrorToast, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('handleApiError — HTTP durum kodu eşlemesi', () => {
  const cases: Array<[number, string, string]> = [
    [400, 'error',   'geçersiz'],
    [401, 'warning', 'giriş'],
    [403, 'warning', 'yetkin'],
    [404, 'error',   'bulunamadı'],
    [409, 'error',   'değişmiş'],
    [413, 'error',   'büyük'],
    [429, 'warning', 'istek'],
    [500, 'error',   'Sunucu'],
    [502, 'error',   'Sunucu'],
    [503, 'error',   'Sunucu'],
    [504, 'error',   'zaman aşımı'],
  ];

  for (const [status, severity, fragment] of cases) {
    it(`${status} → görünür bildirim, ${severity} önem derecesi`, () => {
      handleApiError(res(status));

      expect(shown()).toHaveLength(1);
      expect(firstType()).toBe(severity);
      expect(firstText().toLowerCase()).toContain(fragment.toLowerCase());
    });
  }

  it('bilinmeyen 4xx (418) genel hata metnine düşer', () => {
    const info = handleApiError(res(418));

    expect(shown()).toHaveLength(1);
    expect(info.key).toBe('error_generic');
  });

  it('bilinmeyen 5xx (507) sunucu hatası olarak sınıflandırılır', () => {
    const info = handleApiError(res(507));

    expect(info.key).toBe('error_server');
    expect(firstType()).toBe('error');
  });

  it('tek hata için TEK bildirim üretilir', () => {
    handleApiError(res(500));
    expect(shown()).toHaveLength(1);
  });
});

describe('handleApiError — ağ ve bilinmeyen girişler', () => {
  it('"Failed to fetch" ağ hatası olarak tanınır', () => {
    const info = handleApiError(err('Failed to fetch'));

    expect(info.network).toBe(true);
    // 'tr' tablosundaki GERÇEK metin (i18n/tr.ts: error_network).
    expect(firstText()).toContain('bağlanılamıyor');
  });

  it('AbortError ağ hatası olarak tanınır', () => {
    expect(handleApiError(err('aborted', 'AbortError')).network).toBe(true);
  });

  it('TimeoutError ağ hatası olarak tanınır', () => {
    expect(handleApiError(err('timed out', 'TimeoutError')).network).toBe(true);
  });

  it('sıradan Error ağ hatası SAYILMAZ, genel metin gösterilir', () => {
    const info = handleApiError(err('beklenmedik durum'));

    expect(info.network).toBe(false);
    expect(info.key).toBe('error_generic');
  });

  it('string / null / undefined / number girişleri çökmez, bildirim üretir', () => {
    for (const input of ['bir şeyler ters gitti', null, undefined, 42]) {
      handleApiError(input);
      expect(shown().length).toBeGreaterThan(0);
      unmount(instance!);
      instance = mount(ApiErrorToast, { target: host });
      flushSync();
    }
  });

  it('bozuk/eksik Response benzeri nesne genel hataya düşer', () => {
    const info = handleApiError({ status: 'oops' });

    expect(info.status).toBe(0);
    expect(info.key).toBe('error_generic');
    expect(shown()).toHaveLength(1);
  });
});

describe('handleApiError — güvenlik: teknik ayrıntı sızmaz', () => {
  it('sunucu URL\'si ve stack trace kullanıcıya gösterilmez', () => {
    handleApiError(res(500, '/api/internal/secret?token=abc123'));

    const text = firstText();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('/api/');
  });

  it('Error mesajı (ham teknik metin) kullanıcıya gösterilmez', () => {
    handleApiError(err('ECONNREFUSED 10.0.0.5:5432 pg_hba.conf reddetti'));

    const text = firstText();
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('10.0.0.5');
    expect(text).toContain('hata');
  });

  it('report=true teknik ayrıntıyı yalnızca log\'a yazar, bildirime taşımaz', () => {
    handleApiError(res(500, '/api/gizli'), { report: true });

    expect(firstText()).not.toContain('gizli');
  });
});

describe('handleApiError — auth sözleşmesi', () => {
  it('401 paralel auth mekanizması ÇALIŞTIRMAZ (token silinmez, yönlendirme yok)', () => {
    localStorage.setItem('token', 'kalmali');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const hrefBefore = window.location.href;

    handleApiError(res(401));

    // Token yenileme/oturum düşürme TEK yerde (api-fetch.ts) kalmalı.
    expect(localStorage.getItem('token')).toBe('kalmali');
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // paralel refresh isteği yok
    expect(window.location.href).toBe(hrefBefore); // yönlendirme yok

    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('401 kullanıcıya oturum mesajı gösterir', () => {
    handleApiError(res(401));

    expect(firstType()).toBe('warning');
    // 'tr' tablosundaki GERÇEK metin (i18n/tr.ts: error_unauthorized).
    expect(firstText().toLowerCase()).toContain('giriş yapman');
  });
});

describe('handleApiError — seçenekler', () => {
  it('customMessage eşlenen metni ezer', () => {
    handleApiError(res(500), { customMessage: 'Sunucu bakımda, birazdan dene.' });

    expect(firstText()).toBe('Sunucu bakımda, birazdan dene.');
  });

  it('severity eşlenen önem derecesini ezer', () => {
    const info = handleApiError(res(500), { severity: 'warning' });

    expect(info.severity).toBe('warning');
    expect(firstType()).toBe('warning');
  });

  it('fallbackKey bilinmeyen durum kodu için kullanılır', () => {
    const info = handleApiError(res(418), { fallbackKey: 'error_not_found' });

    expect(info.key).toBe('error_not_found');
    expect(firstText()).toContain('bulunamadı');
  });

  it('silent=true bildirim göstermez ama sınıflandırmayı döndürür', () => {
    const info = handleApiError(res(403), { silent: true });

    expect(shown()).toHaveLength(0);
    expect(info.severity).toBe('warning');
    expect(info.key).toBe('error_forbidden');
  });

  it('sınıflandırma sonucu çağırana durum kodunu da verir', () => {
    expect(handleApiError(res(429)).status).toBe(429);
  });
});

describe('kısa yollar', () => {
  it('toastForbidden uyarı gösterir ve özel mesaj kabul eder', () => {
    toastForbidden('Kanalı yönetme yetkin yok.');

    expect(firstType()).toBe('warning');
    expect(firstText()).toBe('Kanalı yönetme yetkin yok.');
  });

  it('toastRateLimit uyarı gösterir', () => {
    toastRateLimit();
    expect(firstType()).toBe('warning');
  });

  it('toastNetworkError bağlantı mesajı gösterir', () => {
    toastNetworkError();

    expect(firstType()).toBe('error');
    // 'tr' tablosundaki GERÇEK metin (i18n/tr.ts: error_network).
    expect(firstText()).toContain('bağlanılamıyor');
  });

  it('toastSuccess başarı bildirimi gösterir', () => {
    toastSuccess('Kaydedildi!');

    expect(firstType()).toBe('success');
    expect(firstText()).toBe('Kaydedildi!');
  });
});

describe('toast alıcısı yokken', () => {
  it('handleApiError çökmez (bildirim host\'u mount değilse sessiz kalır)', () => {
    unmount(instance!);
    instance = null;

    expect(() => handleApiError(res(500))).not.toThrow();
  });
});
