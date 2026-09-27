// server/lib/httpRequestDrain.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ERKEN REDDEDİLEN YÜKLEMELER TEMİZ BİR YANIT ALMALIDIR
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN DAVRANIŞ: yükleme rotaları yetkilendirmeyi bilerek Multer'DAN ÖNCE
// yapar — yetkisiz bir istek diske GEÇİCİ DOSYA BİLE yazamamalıdır
// (routes/soundboard.ts:118, routes/sticker-packs.ts:242). Bu doğru bir
// güvenlik kararıdır ve DEĞİŞTİRİLMEMELİDİR.
//
// Ancak bunun bir yan etkisi vardı: istek gövdesi HL AKARKEN 403 yazılınca
// Node, yanıtı gönderdikten sonra soketi YOK EDER (okunmamış istek verisi
// kaldığı için). İstemci tarafında sonuç `403` değil `ECONNRESET` olur.
//
// Bunun kullanıcıya yansıması: "Bu işlem için yetkiniz yok" yerine
// "ağ hatası / bağlantı kesildi". Yani doğru çalışan bir güvenlik kontrolü,
// hatalı bir arıza gibi görünüyordu. Aynı belirti supertest'te de görülür ve
// iki soundboard testi `read ECONNRESET` ile düşüyordu.
//
// ── ÇÖZÜM ──────────────────────────────────────────────────────────────────
// Yanıtı yazmadan ÖNCE kalan gövde AKITILIP ATILIR. Baytlar hiçbir yere
// yazılmaz (Multer devrede değildir, `resume()` verileri düşürür), dolayısıyla
// güvenlik özelliği aynen korunur; tek fark bağlantının düzgün kapanması ve
// istemcinin gerçek durum kodunu görmesidir.
//
// Gövde sınırı zaten taşıyıcı katmanda uygulanır (Multer `limits.fileSize`,
// ters vekil istek gövdesi sınırı); burada ek bir bekleme yaratılmaz —
// `resume()` yalnızca akışı boşaltır, tamamlanmasını BEKLEMEZ.

import type { Request, Response } from 'express';

/**
 * `req.resume()` TEK BASINA YETMEZ — olculdu.
 *
 * Akisi bosaltmak baytlari duserir ama yanit HEMEN yazilirsa Node yine soketi
 * yok eder. Yanitin, istek gövdesi GERCEKTEN bittikten (`'end'`) sonra
 * yazilmasi gerekir. Olcum (supertest, `.attach()` + `.field()`):
 *
 *     duz 403            -> ERR read ECONNRESET
 *     resume() + 403     -> ERR read ECONNRESET
 *     resume() + 'end'   -> status 403      <-- dogru davranis
 */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Discard the unread request body, then run a continuation exactly once.
 * Useful when pre-Multer authorization itself fails and the canonical Express
 * error handler still needs to own the response.
 */
export function afterDiscardingBody(req: Request, continuation: () => void): void {
  if (req.complete) { continuation(); return; }

  let continued = false;
  const finish = (): void => {
    if (continued) return;
    continued = true;
    clearTimeout(timer);
    continuation();
  };

  const timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
  timer.unref?.();
  req.on('end', finish);
  req.on('error', finish);
  req.on('aborted', finish);
  req.resume();
}

/**
 * Kalan istek gövdesini atarak verilen durum/gövdeyle yanitlar.
 *
 * Baytlar hicbir yere yazilmaz (Multer devrede degildir), dolayisiyla
 * "yetkisiz istek diske dosya yazamaz" ozelligi AYNEN korunur.
 *
 * @param req    Express istegi (gövdesi henuz tuketilmemis olabilir).
 * @param res    Express yaniti.
 * @param status HTTP durum kodu.
 * @param body   JSON gövdesi.
 */
export function respondDiscardingBody(
  req: Request,
  res: Response,
  status: number,
  body: unknown,
): void {
  afterDiscardingBody(req, () => {
    if (!res.headersSent) res.status(status).json(body);
  });
}
