// client/js/core/permissions/myPermissions.ts
// FAZ C2/C3 — ÇAĞIRANIN KENDİ İZİN BİTLERİ (görünürlük sinyali).
//
// KONUM NOTU: C2'de `channel-perms/` altında doğmuştu; C3'te sticker yönetimi
// de aynı sinyale ihtiyaç duyunca buraya taşındı. Amaç TEK bir izin sahibi
// olması — her yüzeyin kendi izin modelini kurması yasaktır.
//
// ════════════════════════════════════════════════════════════════════════════
// NE DEĞİLDİR
// ════════════════════════════════════════════════════════════════════════════
// Bu bir YETKİ SINIRI DEĞİLDİR. Gerçek sınır arka uçtadır
// (`resolvePermissions` + `MANAGE_CHANNELS` kontrolü, her yazma rotasında).
// Buradaki değer YALNIZCA yetkisi olmayan kullanıcıya ölü/yanıltıcı bir
// kontrol göstermemek içindir. Yanıltıcı olmamanın bedeli fail-closed'dır:
// bit KANITLANAMIYORSA yok sayılır.
//
// Arka uç sözleşmesi (doğrulandı):
//   GET /api/servers/:sid/me/permissions → { permissions: number }
// Kanal izin rotaları da yetkilendirmeyi aynı düzeyde yapar
// (`resolvePermissions(user, sid)`), bu yüzden sinyal ile kapı sapmaz.

// Statik import (Final21 Faz 18): dinamik import'un bir döngüyü kırmak gibi bir gerekçesi
// yoktu (api-fetch/globals bu modülü içe aktarmaz) ve ikisi de zaten ana girişte.
import { apiFetch } from '../api-fetch.js';
import { getAPI } from '../globals.js';

/** `server/lib/permissions.ts` yansıması — yalnız burada gerekenler. */
export const PERM_ADMINISTRATOR   = 1 << 30;   // DİKKAT: 1<<3 MANAGE_SERVER'dır
export const PERM_MANAGE_CHANNELS = 1 << 1;
export const PERM_MANAGE_ROLES    = 1 << 2;
export const PERM_MANAGE_SERVER   = 1 << 3;
export const PERM_MANAGE_MESSAGES = 1 << 9;    // sabitleme/sabitlemeyi kaldırma yetkisi

/** ADMINISTRATOR her biti kapsar (arka uçtaki `hasPermission` ile aynı). */
export function hasPerm(perms: number, flag: number): boolean {
  if ((perms & PERM_ADMINISTRATOR) !== 0) return true;
  return (perms & flag) !== 0;
}

// Sunucu başına önbellek: kanal listesi her render'da N istek atmasın.
const cache = new Map<string, number>();
// UÇUŞTAKİ istek de paylaşılır (Final21 Faz 18). Önbellek yalnız SONUCU tutuyordu;
// ilk gidiş-dönüş sürerken soran her yüzey ıskalıyor ve kendi isteğini atıyordu
// (ölçüldü: girişten hemen sonra aynı sunucu için 4 özdeş istek).
const inFlight = new Map<string, Promise<number>>();
// Temizlemeden ÖNCE başlamış bir sorgu, cevabını temizlemeden SONRA önbelleğe yazamaz.
// Aksi hâlde rol kaldırıldıktan sonra geç gelen eski cevap ("yönetici") önbelleğe girer
// ve yönetici kontrolleri geri görünürdü.
let generation = 0;

/** Sunucu değişimi/oturum değişiminde bayat yetkiyle kontrol gösterilmesin. */
export function clearPermsCache(serverId?: string): void {
  generation += 1;
  if (serverId) { cache.delete(serverId); inFlight.delete(serverId); }
  else { cache.clear(); inFlight.clear(); }
}

/**
 * Çağıranın bu sunucudaki çözülmüş izin bitleri.
 * Ağ hatası / yetkisiz / bozuk yanıt ⇒ 0 (fail-closed).
 */
export async function fetchMyPermissions(serverId: string): Promise<number> {
  if (!serverId) return 0;
  const cached = cache.get(serverId);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(serverId);
  if (pending) return pending;

  const lookup = loadMyPermissions(serverId);
  inFlight.set(serverId, lookup);
  try {
    return await lookup;
  } finally {
    // Başarısızlık ÖNBELLEĞE ALINMAZ (fail-closed 0 kalıcı olmasın); bir sonraki çağrı
    // yeniden sorar. Yalnız bu uçuşun kaydı silinir.
    if (inFlight.get(serverId) === lookup) inFlight.delete(serverId);
  }
}

async function loadMyPermissions(serverId: string): Promise<number> {
  const startedAt = generation;
  try {
    const res = await apiFetch(`${getAPI()}/api/servers/${serverId}/me/permissions`);
    if (!res.ok) return 0;
    const data = await res.json() as { permissions?: unknown };
    const perms = Number(data?.permissions);
    if (!Number.isFinite(perms) || perms < 0) return 0;
    if (startedAt === generation) cache.set(serverId, perms);
    return perms;
  } catch {
    return 0;                       // ağ hatasında yetki VARSAYILMAZ
  }
}

/** Kanal izinleri düzenleyicisini açma yetkisi kanıtlanabiliyor mu? */
export async function canManageChannels(serverId: string): Promise<boolean> {
  return hasPerm(await fetchMyPermissions(serverId), PERM_MANAGE_CHANNELS);
}

/** Rol atama ve profil-sunum ayarlarini yonetme yetkisi. */
export async function canManageRoles(serverId: string): Promise<boolean> {
  return hasPerm(await fetchMyPermissions(serverId), PERM_MANAGE_ROLES);
}

/**
 * Sunucu varlıklarını (sticker paketleri dahil) yönetme yetkisi.
 * Arka uç sticker yazma rotaları MANAGE_SERVER ister
 * (`routes/sticker-packs.ts` — POST/DELETE/PATCH).
 */
export async function canManageServer(serverId: string): Promise<boolean> {
  return hasPerm(await fetchMyPermissions(serverId), PERM_MANAGE_SERVER);
}

/**
 * Mesaj sabitleme/kaldırma yetkisi kanıtlanabiliyor mu? Arka uç `message:pin`
 * soket işleyicisi MANAGE_MESSAGES ister (`socket/handlers/messages-edit.ts`).
 * Yalnız görünürlük sinyali — gerçek sınır arka uçtadır (fail-closed).
 */
export async function canManageMessages(serverId: string): Promise<boolean> {
  return hasPerm(await fetchMyPermissions(serverId), PERM_MANAGE_MESSAGES);
}
