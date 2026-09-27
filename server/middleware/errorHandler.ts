// server/middleware/errorHandler.ts
// Global Express error handler — 500 yanıtlarında iç detay sızıntısını önler.

import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

export interface HttpError extends Error {
  status?: number;
  expose?: boolean;
  /** `pg` surucusunun bagalanti hatalarinda doldurdugu alan. */
  code?: string;
}

// ── GECICI BAGIMLILIK ARIZASI 503'TUR, 500 DEGIL ───────────────────────────
// OLCULDU (v1.124): PostgreSQL canli trafik altinda durduruldugunda API
// 91 istegin TAMAMINA HTTP 500 dondu. Bridge sonra KENDILIGINDEN toparlandi
// (surec yeniden baslatilmadi) — yani davranis dogruydu, ANLATIMI yanlisti.
//
// Fark onemlidir ve kullanicilara/istemcilere yansir:
//   500 = "sunucuda hata var"      -> istemci tekrar denemez, kullaniciya
//                                      kalici bir arizaymis gibi gorunur
//   503 = "gecici olarak hizmet yok" -> tekrar denenebilir; ara katmanlar,
//                                      mobil istemciler ve outbox kuyrugu
//                                      dogru davranir
//
// Ayni ayrim hiz-sinirlayicinin Redis yolunda ZATEN dogru yapiliyordu
// (503 "Rate limit service temporarily unavailable"). Veritabani yolu bu
// davranistan geri kalmisti.
//
// Yalnizca BAGLANTI sinifi hatalar donusturulur. Kisit ihlali, sozdizimi
// hatasi veya mantik hatasi 500 olarak KALIR — onlar gercekten kusurdur ve
// tekrar denemek duzeltmez.
const RETRYABLE_DB_CODES = new Set([
  'ECONNREFUSED',    // veritabani kapali
  'ECONNRESET',      // baglanti dusuruldu
  'ETIMEDOUT',       // erisilemiyor
  'EPIPE',           // yazma sirasinda koptu
  'ENOTFOUND',       // DNS/host cozulemedi
  '57P01',           // admin_shutdown
  '57P02',           // crash_shutdown
  '57P03',           // cannot_connect_now (baslatiliyor)
  '08000', '08003', '08006', '08001', '08004',  // connection_exception ailesi
]);

/** Hata, tekrar denenebilir bir bagimlilik kesintisi mi? */
function isDependencyOutage(err: HttpError): boolean {
  if (err.code && RETRYABLE_DB_CODES.has(err.code)) return true;
  // `pg-pool` havuz tukenmesi/kapanmasi mesaj olarak gelir.
  const m = String(err.message || '');
  return /terminating connection|Connection terminated|the database system is (starting up|shutting down)|Client has encountered a connection error/i.test(m);
}

export function errorHandler(
  err: HttpError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  const explicit = err.status && err.status >= 400 && err.status < 600 ? err.status : null;
  // Acikca belirtilmis bir durum kodu HER ZAMAN kazanir; yalnizca
  // siniflandirilmamis hatalar bagimlilik kesintisi olarak yeniden etiketlenir.
  const status = explicit ?? (isDependencyOutage(err) ? 503 : 500);
  const isServerError = status >= 500;

  if (isServerError) {
    logger.error(
      {
        event: 'http.error',
        status,
        method: req.method,
        path: req.originalUrl,
        err: err.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
      },
      'Unhandled route error',
    );
  }

  const message = !isServerError && err.expose !== false
    ? err.message
    : status === 503
      ? 'Service temporarily unavailable'
      : isServerError
        ? 'Internal server error'
        : err.message || 'Request failed';

  // Tekrar denenebilir bir kesintide istemciye NE ZAMAN deneyecegini soyle.
  // Ic detay SIZDIRILMAZ: yalnizca durum ve bekleme suresi.
  if (status === 503) res.setHeader('Retry-After', '5');

  res.status(status).json({ error: message });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}
