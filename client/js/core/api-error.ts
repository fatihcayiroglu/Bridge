// client/js/core/api-error.ts
// Faz 8.1 — API hata → kullanıcı bildirimi adaptörü.
//
// GERİ KAZANILAN DAVRANIŞ
// ───────────────────────
// Sprint 116'da `api-error-toast.ts` arşive taşındı ve yerine yalnızca bir
// mount shim bırakıldı. Böylece `handleApiError()` giriş noktası ORTADAN
// KALKTI: `res.ok` kontrolü yapan çağrı yerleri hataları ya sessizce yutuyor
// ya da her biri kendi ad-hoc metnini üretiyordu.
//
// Bu modül o giriş noktasını YENİ altyapı üzerine kurar:
//   - bildirim `core/utils.ts` → BridgeRegistry('toast') → ApiErrorToast.svelte
//     zincirinden geçer (yeni window.* global YOK)
//   - aynı hatanın tekrarı toast host'unda zaten bastırılır; bu modül tek
//     hata için TEK bildirim üretir
//
// GÜVENLİK SÖZLEŞMESİ
//   - Sunucu gövdesi, stack trace, URL, token vb. ASLA bildirime konmaz.
//     Kullanıcıya yalnızca bu dosyadaki sabit/çevrilmiş metinler gösterilir.
//   - Teknik ayrıntı yalnızca `report: true` ile ortak logger'a gider
//     (production'da logger zaten bastırılır).
//
// AUTH SÖZLEŞMESİ
//   - 401 yalnızca bildirim üretir. Token yenileme/oturum düşürme TEK yerde,
//     `api-fetch.ts` içindedir. Burada token silme, yönlendirme veya yeniden
//     deneme YAPILMAZ — paralel bir auth mekanizması doğmasın.

import { toast } from './utils.ts';
import { t } from './i18n/index.ts';
import { createLogger } from './logger.ts';

const log = createLogger('ApiError');

export type ApiSeverity = 'error' | 'warning' | 'info';

/**
 * `!response.ok` durumunu `throw` ile taşımak için sarmalayıcı.
 *
 * Önceden çağrı yerleri `throw new Error(\`HTTP ${status}\`)` yazıyordu ve
 * durum kodu catch bloğunda bir METİN olarak kalıyordu — hem sınıflandırma
 * kayboluyor hem de o ham metin kullanıcıya gösterilebiliyordu. Bu sınıf
 * Response'u taşır; `unwrapApiError()` ile geri alınır.
 */
export class ApiResponseError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super(`HTTP ${response.status}`);
    this.name = 'ApiResponseError';
    this.response = response;
  }
}

/** Sarmalanmış Response'u açar; sarmalı olmayan değerler olduğu gibi döner. */
export function unwrapApiError(error: unknown): unknown {
  return error instanceof ApiResponseError ? error.response : error;
}

export interface ApiErrorOptions {
  /** Eşlenen metin yerine gösterilecek özel mesaj. */
  customMessage?: string;
  /** Bilinmeyen durum kodları için kullanılacak anahtar. */
  fallbackKey?: string;
  /** true → teknik ayrıntı ortak logger'a yazılır (kullanıcıya değil). */
  report?: boolean;
  /** Eşlenen önem derecesini ezer. */
  severity?: ApiSeverity;
  /** true → bildirim gösterilmez, yalnızca sınıflandırma döner. */
  silent?: boolean;
}

/** Çağıranın dallanabilmesi için sınıflandırma sonucu. */
export interface ApiErrorInfo {
  /** HTTP durum kodu; ağ/bilinmeyen hatalarda 0. */
  status: number;
  /** i18n anahtarı. */
  key: string;
  /** Kullanıcıya gösterilen (veya gösterilecek) güvenli metin. */
  message: string;
  severity: ApiSeverity;
  /** Ağ katmanı hatası mı (offline, abort, DNS…). */
  network: boolean;
}

// ── Durum kodu eşlemesi ──────────────────────────────────────────────────────

const STATUS_KEY: Record<number, string> = {
  400: 'error_bad_request',
  401: 'error_unauthorized',
  403: 'error_forbidden',
  404: 'error_not_found',
  409: 'error_conflict',
  413: 'error_upload_size',
  422: 'error_bad_request',
  429: 'error_ratelimit',
  500: 'error_server',
  502: 'error_server',
  503: 'error_server',
  504: 'error_timeout',
};

function textFor(key: string): string {
  // Every bounded API error key is release-gated across all stable locales.
  // Do not keep a hidden Turkish fallback catalog in production source.
  return t(key);
}

/**
 * Durum kodu → önem derecesi.
 * 401/403/429 kullanıcı hatası veya geçici sınır: uyarı (sarı).
 * Diğer 4xx/5xx: hata (kırmızı).
 */
function severityForStatus(status: number): ApiSeverity {
  if (status === 401 || status === 403 || status === 429) return 'warning';
  return 'error';
}

/** Bilinmeyen kodlar için aralık bazlı geri düşüş (418, 451, 507…). */
function keyForStatus(status: number, fallbackKey: string): string {
  const mapped = STATUS_KEY[status];
  if (mapped) return mapped;
  if (status >= 500) return 'error_server';
  return fallbackKey;
}

// ── Giriş türü ayrımı ────────────────────────────────────────────────────────

/**
 * `Response` benzeri mi? `instanceof Response` kullanılmaz: jsdom/test
 * ortamında ve farklı realm'lerde (iframe, worker) başarısız olur.
 */
function isResponseLike(input: unknown): input is Response {
  return typeof input === 'object' && input !== null
    && 'status' in input && 'ok' in input
    && typeof (input as Response).status === 'number';
}

const NETWORK_ERROR_NAMES = new Set(['AbortError', 'NetworkError', 'TimeoutError']);
const NETWORK_ERROR_HINTS = /failed to fetch|network(?:\s|_)?(?:request|error)|load failed|err_internet|offline/i;

function isNetworkError(err: Error): boolean {
  return NETWORK_ERROR_NAMES.has(err.name) || NETWORK_ERROR_HINTS.test(err.message ?? '');
}

// ── Sınıflandırma ────────────────────────────────────────────────────────────

function classify(input: unknown, fallbackKey: string): Omit<ApiErrorInfo, 'message'> {
  if (isResponseLike(input)) {
    const status = input.status;
    return { status, key: keyForStatus(status, fallbackKey), severity: severityForStatus(status), network: false };
  }

  if (input instanceof Error) {
    return isNetworkError(input)
      ? { status: 0, key: 'error_network', severity: 'error', network: true }
      : { status: 0, key: fallbackKey, severity: 'error', network: false };
  }

  // string / null / undefined / number / bozuk gövde → genel hata.
  return { status: 0, key: fallbackKey, severity: 'error', network: false };
}

/** Teknik ayrıntıyı loglar — kullanıcıya gösterilen metne hiçbir zaman karışmaz. */
function reportTechnical(input: unknown, info: Omit<ApiErrorInfo, 'message'>): void {
  if (isResponseLike(input)) {
    log.error('API hatası', { status: info.status, url: input.url, key: info.key });
    return;
  }
  if (input instanceof Error) {
    log.error('API hatası', { name: input.name, message: input.message, key: info.key });
    return;
  }
  log.error('API hatası', { raw: String(input), key: info.key });
}

// ── Ana giriş noktası ────────────────────────────────────────────────────────

/**
 * Bir API hatasını kullanıcıya güvenli tek bir bildirimle gösterir.
 *
 * @param input - `fetch` Response'u, Error nesnesi veya herhangi bir değer.
 * @param opts  - özelleştirme seçenekleri.
 * @returns Çağıranın dallanabilmesi için sınıflandırma bilgisi.
 *
 * @example
 * const res = await apiFetch('/api/servers', { method: 'POST', body });
 * if (!res.ok) { handleApiError(res); return; }
 */
export function handleApiError(input: unknown, opts: ApiErrorOptions = {}): ApiErrorInfo {
  const { customMessage, fallbackKey = 'error_generic', report = false, severity, silent = false } = opts;

  const base = classify(input, fallbackKey);
  const message = customMessage ?? textFor(base.key);
  const level = severity ?? base.severity;

  // Tek hata → tek bildirim. Aynı metnin kısa aralıkta tekrarı toast host'unda
  // (ApiErrorToast.svelte, DEDUPE_WINDOW_MS) ayrıca bastırılır.
  if (!silent) toast(message, level);

  if (report) reportTechnical(input, base);

  return { ...base, message, severity: level };
}

/**
 * Inline/form yüzeyleri için güvenli hata metni. HTTP/ağ sınıflandırmasını
 * korur; yalnızca sınıflandırılamayan istemci hatalarında çağıranın bağlamsal
 * fallback'ini kullanır. Teknik ayrıntı kullanıcı metnine ASLA karışmaz.
 */
export function safeApiErrorMessage(
  input: unknown,
  fallbackMessage: string,
  opts: Omit<ApiErrorOptions, 'customMessage' | 'silent'> = {},
): string {
  const normalized = unwrapApiError(input);
  const info = handleApiError(normalized, { ...opts, silent: true });
  if (info.status === 0 && !info.network) return fallbackMessage;
  return info.message;
}

// ── Kısa yollar ──────────────────────────────────────────────────────────────

/** 403 — yetki yok. */
export function toastForbidden(msg?: string): void {
  toast(msg ?? textFor('error_forbidden'), 'warning');
}

/** 429 — hız sınırı. */
export function toastRateLimit(msg?: string): void {
  toast(msg ?? textFor('error_ratelimit'), 'warning');
}

/** Ağ hatası (offline, timeout, abort). */
export function toastNetworkError(msg?: string): void {
  toast(msg ?? textFor('error_network'), 'error');
}

/** Başarı bildirimi. */
export function toastSuccess(msg: string): void {
  toast(msg, 'success');
}
