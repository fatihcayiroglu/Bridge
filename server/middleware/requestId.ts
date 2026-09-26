// server/middleware/requestId.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KORELASYON KİMLİĞİ MIDDLEWARE'İ
// ════════════════════════════════════════════════════════════════════════════
// Zincirin EN BAŞINA takılır. Buradan sonraki her şey — kimlik doğrulama,
// depo/veritabanı çağrıları, Redis, dış sağlayıcılar, hata işleyicisi —
// aynı `requestId` altında günlüklenir.
//
// Kimlik yanıt başlığında da geri verilir (`X-Request-Id`). Bunun pratik bir
// karşılığı vardır: bir kullanıcı "şu an hata aldım" dediğinde, tarayıcı ağ
// sekmesinden okunan tek bir değerle sunucu günlüğündeki TAM istek bulunur.
// Destek akışında "hangi istek?" sorusunu ortadan kaldırır.
//
// ── NEDEN `res.setHeader` ÇAĞRI ANINDA ──────────────────────────────────────
// Başlık, yanıt gövdesi yazılmadan ÖNCE ayarlanmalıdır. Bir sonraki
// middleware erken yanıt döndürebileceği (hız sınırı, CSRF, IP yasağı) için
// başlık hemen burada yazılır — sonraki bir `finish` kancasında değil.
import type { NextFunction, Request, Response } from 'express';
import { adoptRequestId, runWithRequestContext } from '../lib/requestContext';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * İsteği bir korelasyon bağlamı içinde çalıştırır.
 *
 * Ters vekilin ürettiği kimlik (katı biçime uyuyorsa) benimsenir; böylece vekil
 * erişim günlüğü ile uygulama günlüğü aynı değerle birleştirilebilir. Uymayan
 * veya istemci uydurması bir başlık sessizce yok sayılır ve yenisi üretilir.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = adoptRequestId(req.headers[REQUEST_ID_HEADER]);

  // İstek nesnesine de yazılır: bağlamı okuyamayan (veya senkron çalışan)
  // yerler için kaçış kapısı.
  (req as Request & { requestId?: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  runWithRequestContext({ requestId }, () => next());
}
