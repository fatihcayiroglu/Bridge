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

//
// ════════════════════════════════════════════════════════════════════════════
// OKUMA/GONDERME YARISI (P7 D2 CI'da olculdu)
// ════════════════════════════════════════════════════════════════════════════
// Gecersiz kilma tek basina yetmez: veritabanini gonderimden ONCE okuyan bir
// GET, gonderim commit edip onbellegi dusurdukten SONRA eski sayfasini yazar.
// Bos kanalda bu sayfa 45 sn yasar (attachments.spec.ts bu yuzden 25 sn
// bekleyip dustu). Her kanalin bir NESLI vardir: gecersiz kilma onu yeni bir
// degere cevirir; okuyucu nesli sorgudan ONCE okur, sayfayla birlikte yazar
// ve yalnizca nesli guncel olan sayfayi sunar. Neslin anahtari sayfa
// onekinin DISINDADIR, boylece onek silme onu silmez.

import { randomUUID } from 'crypto';
import { cache } from './redisAdapter';
import logger from './logger';

/** Neslin yasam suresi: en uzun sayfa TTL'inden (45 sn) cok daha uzun. */
const GENERATION_TTL_SECONDS = 3600;

/** `routes/messages.ts` ile AYNI onek — tek yerde tutulur ki sapmasin. */
export function channelMessagesCachePrefix(channelId: string): string {
  return `messages:${channelId}:`;
}

function generationKey(channelId: string): string {
  return `messages-gen:${channelId}`;
}

/** Ilk sayfa onbellek girdisi: yanit + okundugu andaki kanal nesli. */
export interface CachedChannelPage<T> { generation: string; page: T }

/**
 * Kanalin guncel nesli. Hic gecersiz kilinmamis (ya da nesli dusmus) kanal
 * icin '0'. Veritabani sorgusundan ONCE okunmali.
 */
export async function channelMessagesGeneration(channelId: string): Promise<string> {
  const value = await cache.get<string>(generationKey(channelId));
  return typeof value === 'string' && value ? value : '0';
}

/** Girdi yalnizca okuyucunun nesliyle yazildiysa sayfayi dondurur. */
export function currentChannelPage<T>(entry: unknown, generation: string): T | null {
  if (!entry || typeof entry !== 'object') return null;
  const { generation: stored, page } = entry as Partial<CachedChannelPage<T>>;
  return stored === generation && page ? page : null;
}

/**
 * Bir kanalin onbellege alinmis mesaj sayfalarini dusurur.
 *
 * KRITIK OLMAYAN: onbellek dusurulemezse mesaj yine de kalicidir ve TTL
 * dolunca gorunur. Bu yuzden hata gonderimi BOZMAZ — yalnizca loglanir.
 */
export async function invalidateChannelMessages(channelId: string): Promise<void> {
  if (!channelId) return;
  // Once yeni nesil: bu andan sonra baslayan her okuma, yaristaki eski nesille
  // yazilmis sayfayi gormez. Adimlardan biri basarisiz olsa da digeri denenir.
  const steps = [
    () => cache.set(generationKey(channelId), randomUUID(), GENERATION_TTL_SECONDS),
    () => cache.invalidatePattern(channelMessagesCachePrefix(channelId)),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      logger.debug({ event: 'message_cache.invalidate_failed', channelId, err },
        '[cache] kanal mesaj onbellegi dusurulemedi');
    }
  }
}
