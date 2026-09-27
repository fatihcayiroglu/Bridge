// server/lib/messageCache.ts
//
// KANAL MESAJ ONBELLEGININ TEK GECERSIZ KILMA YERI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `GET /api/channels/:cid/messages` ilk sayfayi ADAPTIF TTL ile onbellekler
// (routes/messages.ts): son mesaj <2dk ise 5s, <10dk ise 15s, aksi halde 45s.
// Bos ya da sessiz bir kanalda `ageMs` sonsuzdur → **45 saniye**.
//
// Gecersiz kilma iki yerden birden eksikti:
//
//   1. `file:send` HIC gecersiz kilmiyordu. Dosya mesaji kalici olarak
//      yaziliyor ama REST okuma yolu 45 saniyeye kadar ESKI listeyi
//      donduruyordu. Acik istemci socket push'u sayesinde bunu gormez;
//      sayfayi YENILEYEN, kanaldan cikip donen ya da IKINCI CIHAZDAN bakan
//      kullanici mesaji GORMEZ. Sessiz ve kandirici bir kayip.
//
//   2. `message:send` yalnizca IKI sabit anahtari siliyordu
//      (`first:50`, `first:100`). Oysa limit 1..100 arasi HERHANGI bir deger
//      olabilir (`Math.min(parseInt(limit) || 50, 100)`); `?limit=25` ile
//      okuyan bir istemci yine bayat veri aliyordu.
//
// Cozum: onek bazli gecersiz kilma. Sayfa boyutundan BAGIMSIZ olarak o
// kanalin tum ilk-sayfa girdileri dusurulur.

import { cache } from './redisAdapter';
import logger from './logger';

/** `routes/messages.ts` ile AYNI onek — tek yerde tutulur ki sapmasin. */
export function channelMessagesCachePrefix(channelId: string): string {
  return `messages:${channelId}:`;
}

/**
 * Bir kanalin onbellege alinmis mesaj sayfalarini dusurur.
 *
 * KRITIK OLMAYAN: onbellek dusurulemezse mesaj yine de kalicidir ve TTL
 * dolunca gorunur. Bu yuzden hata gonderimi BOZMAZ — yalnizca loglanir.
 */
export async function invalidateChannelMessages(channelId: string): Promise<void> {
  if (!channelId) return;
  try {
    await cache.invalidatePattern(channelMessagesCachePrefix(channelId));
  } catch (err) {
    logger.debug({ event: 'message_cache.invalidate_failed', channelId, err },
      '[cache] kanal mesaj onbellegi dusurulemedi');
  }
}
