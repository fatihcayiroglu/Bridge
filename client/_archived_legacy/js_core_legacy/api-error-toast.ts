// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ApiErrorToastPanel.svelte
//              client/js/core/api-error-toast-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/api-error-toast.ts
// Sprint 64: API hata geri bildirimini standartize eden yardımcı modül.
//
// Sorun: apiFetch hataları tutarsız biçimde gösteriliyordu.
//   - Bazı yerlerde toast('Hata', 'error') doğrudan çağrılıyor
//   - Bazı yerlerde console.error kalıyordu, kullanıcıya hiçbir şey gösterilmiyordu
//   - Rate limit, auth, ağ hataları için özel mesaj yoktu
//
// Çözüm: handleApiError() tek giriş noktası.
//   Her HTTP veya ağ hatasını i18n anahtarına eşler, toast ile gösterir.
//   İsteğe bağlı olarak custom mesaj veya fallback key geçilebilir.
//
// Kullanım:
//   import { handleApiError } from './api-error-toast.js';
//
//   try {
//     const res = await apiFetch('/api/servers', { method: 'POST', body });
//     if (!res.ok) { handleApiError(res); return; }
//   } catch (err) {
//     handleApiError(err);
//   }

import { toast }           from './utils.js';
import { t }               from './i18n.js';
import { errorBoundary }   from './error-boundary.js';

import { createLogger } from './logger.js';
const log = createLogger('ApiError');


// ── Tip tanımları ─────────────────────────────────────────────

type ApiErrorInput = Response | Error | unknown;

interface ApiErrorOptions {
  /** Varsayılan i18n key yerine geçecek özel mesaj. */
  customMessage?: string;
  /** Özel mesaj yoksa bu i18n key kullanılır. */
  fallbackKey?: string;
  /** true → errorBoundary.report() ile de kayıt alınır. */
  report?: boolean;
  /** Toast tipi: 'error' | 'warning' | 'info' */
  severity?: 'error' | 'warning' | 'info';
}

// ── HTTP durum kodu → i18n anahtarı eşlemesi ─────────────────

const STATUS_I18N: Record<number, string> = {
  400: 'error_generic',         // Bad Request
  401: 'error_unauthorized',    // Unauthenticated
  403: 'error_forbidden',       // Forbidden
  404: 'error_not_found',       // Not Found
  413: 'error_upload_size',     // Payload Too Large
  429: 'error_ratelimit',       // Too Many Requests
  500: 'error_server',          // Internal Server Error
  502: 'error_server',
  503: 'error_server',
};

// ── Yardımcılar ───────────────────────────────────────────────

function isResponse(input: unknown): input is Response {
  return typeof input === 'object' && input !== null && 'status' in input && 'ok' in input;
}

function isError(input: unknown): input is Error {
  return input instanceof Error;
}

function severityForStatus(status: number): 'error' | 'warning' {
  if (status === 429) return 'warning';   // rate limit → sarı
  if (status === 401 || status === 403) return 'warning';
  return 'error';
}

// ── Ana fonksiyon ─────────────────────────────────────────────

/**
 * API hatasını standart toast ile kullanıcıya gösterir.
 *
 * @param input  - fetch Response, Error nesnesi veya herhangi bir şey
 * @param opts   - opsiyonel özelleştirme
 */
export async function handleApiError(
  input: ApiErrorInput,
  opts: ApiErrorOptions = {},
): Promise<void> {
  const { customMessage, fallbackKey = 'error_generic', report = false, severity } = opts;

  // ── Response nesnesi ──────────────────────────────────────
  if (isResponse(input)) {
    const status   = input.status;
    const i18nKey  = STATUS_I18N[status] ?? fallbackKey;
    const msg      = customMessage ?? t(i18nKey, _defaultFor(i18nKey));
    const level    = severity ?? severityForStatus(status);

    toast(msg, level);

    if (report) {
      // Body'yi parse et (JSON veya text)
      let bodyStr = '';
      try { bodyStr = JSON.stringify(await input.clone().json()); } catch {
        try { bodyStr = await input.clone().text(); } catch { /* ignore */ }
      }
      errorBoundary.report(
        new Error(`API ${status}: ${input.url} — ${bodyStr}`),
        'api-error-toast',
      );
    }
    return;
  }

  // ── Error nesnesi ─────────────────────────────────────────
  if (isError(input)) {
    const isNetwork = input.message === 'Failed to fetch' ||
                      input.name    === 'AbortError'       ||
                      input.name    === 'NetworkError';

    const msg = customMessage ?? (
      isNetwork
        ? t('error_network', 'Bağlantı hatası. İnternet bağlantını kontrol et.')
        : t(fallbackKey, _defaultFor(fallbackKey))
    );
    const level = severity ?? 'error';
    toast(msg, level);

    if (report) errorBoundary.report(input, 'api-error-toast');
    return;
  }

  // ── Bilinmeyen giriş ──────────────────────────────────────
  const msg = customMessage ?? t(fallbackKey, _defaultFor(fallbackKey));
  toast(msg, severity ?? 'error');
  if (report) errorBoundary.report(new Error(String(input)), 'api-error-toast');
}

// ── Kısa yollar ───────────────────────────────────────────────

/** 403 Forbidden için özel toast. */
export function toastForbidden(msg?: string): void {
  toast(msg ?? t('error_forbidden', 'Bu işlem için yetkin yok.'), 'warning');
}

/** 429 Rate limit için özel toast. */
export function toastRateLimit(): void {
  toast(t('error_ratelimit', 'Çok fazla istek. Biraz bekle.'), 'warning');
}

/** Ağ hatası (offline, timeout vb.) için özel toast. */
export function toastNetworkError(): void {
  toast(t('error_network', 'Bağlantı hatası. İnternet bağlantını kontrol et.'), 'error');
}

/** Başarı mesajı. */
export function toastSuccess(msg: string): void {
  toast(msg, 'success');
}

// ── Dahili ────────────────────────────────────────────────────

function _defaultFor(key: string): string {
  const defaults: Record<string, string> = {
    error_generic:      'Bir hata oluştu. Lütfen tekrar dene.',
    error_unauthorized: 'Bu işlem için giriş yapman gerekiyor.',
    error_forbidden:    'Bu işlem için yetkin yok.',
    error_not_found:    'Aradığın içerik bulunamadı.',
    error_upload_size:  'Dosya çok büyük.',
    error_ratelimit:    'Çok fazla istek. Biraz bekle.',
    error_server:       'Sunucu hatası. Tekrar dene.',
    error_network:      'Bağlantı hatası. İnternet bağlantını kontrol et.',
  };
  return defaults[key] ?? 'Bir hata oluştu.';
}
