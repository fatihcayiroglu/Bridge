// server/lib/channelE2EE.ts
// Sprint 89 — Kanal mesajları E2EE (server-side destek katmanı)
//
// Mimari: Client-side şifreleme, server-side opak saklama
// ─────────────────────────────────────────────────────────
// 1. Kanal kurulum aşaması (channel:e2ee:setup):
//    - Gönderen, kanaldaki her üye için AES-GCM kanal anahtarını
//      kendi public key'i ile sarar (ECDH/X25519 + AES-KW).
//    - Server bu sarmalanmış anahtarları (wrappedKeys) DB'de saklar.
//    - Server içeriği HİÇBİR ZAMAN açık görmez.
//
// 2. Mesaj gönderimi (e2ee:channel mesajı):
//    - Gönderen içeriği AES-GCM ile şifreler: { iv, ciphertext } → base64.
//    - Socket payload: { channelId, serverId, encryptedContent, iv, type:'e2ee' }
//    - Server, plaintext field'ı boş bırakarak mesajı kaydeder;
//      şifreli blob encryptedContent alanında saklanır.
//
// 3. Anahtar dağıtımı (channel:e2ee:keys:get):
//    - Üye, kendi userId için sarmalanmış anahtarı ister.
//    - Server sadece o kullanıcıya ait wrappedKey'i döner.
//
// Güvenlik notları:
//   - Server, anahtarı HİÇBİR ZAMAN açmaz; yalnızca opak blob taşır.
//   - Spam/moderasyon kontrolü şifreli içeriğe uygulanamaz —
//     kanalı E2EE'ye açmak bu trade-off'u kabul etmek demektir.
//   - Discord'un yapamadığı şey: server operatörü dahil hiç kimse
//     içeriği okuyamaz (key escrow yok).

import { cache } from './redisAdapter';

/** Redis'te saklanan kanal E2EE anahtar paketi */
export interface ChannelKeyPackage {
  channelId:   string;
  /** userId → wrappedKey (base64-encoded, ECDH+AES-KW ile sarmalanmış) */
  wrappedKeys: Record<string, string>;
  /** Anahtar rotasyon sayacı — client'lar stale key tespiti için kullanır */
  epoch:       number;
  updatedAt:   number;
}

const KEY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 gün
const redisKey = (channelId: string) => `e2ee:channel:keys:${channelId}`;

/** Kanal için sarmalanmış anahtar paketini kaydet */
export async function setChannelKeyPackage(
  channelId:   string,
  wrappedKeys: Record<string, string>,
): Promise<ChannelKeyPackage> {
  const existing = await getChannelKeyPackage(channelId);
  const pkg: ChannelKeyPackage = {
    channelId,
    wrappedKeys,
    epoch:     (existing?.epoch ?? 0) + 1,
    updatedAt: Date.now(),
  };
  await cache.set(redisKey(channelId), pkg, KEY_TTL_SECONDS);
  return pkg;
}

/** Kanal için mevcut anahtar paketini getir */
export async function getChannelKeyPackage(
  channelId: string,
): Promise<ChannelKeyPackage | null> {
  return (await cache.get(redisKey(channelId))) as ChannelKeyPackage | null;
}

/** Belirli bir üyenin sarmalanmış anahtarını getir */
export async function getWrappedKeyForUser(
  channelId: string,
  userId:    string,
): Promise<{ wrappedKey: string; epoch: number } | null> {
  const pkg = await getChannelKeyPackage(channelId);
  if (!pkg) return null;
  const wrappedKey = pkg.wrappedKeys[userId];
  if (!wrappedKey) return null;
  return { wrappedKey, epoch: pkg.epoch };
}

/** Kanal E2EE durumunu döner (setup yapılmış mı?) */
export async function isChannelE2EEEnabled(channelId: string): Promise<boolean> {
  const pkg = await getChannelKeyPackage(channelId);
  return pkg !== null && Object.keys(pkg.wrappedKeys).length > 0;
}

/** Yeni üye eklenince onun wrappedKey'ini pakete ekle */
export async function addMemberKey(
  channelId:  string,
  userId:     string,
  wrappedKey: string,
): Promise<void> {
  const pkg = await getChannelKeyPackage(channelId);
  if (!pkg) return; // E2EE aktif değil
  pkg.wrappedKeys[userId] = wrappedKey;
  pkg.updatedAt = Date.now();
  await cache.set(redisKey(channelId), pkg, KEY_TTL_SECONDS);
}

/** Üye ayrılınca onun anahtarını paketten sil (forward secrecy için rotate önerilir) */
export async function removeMemberKey(channelId: string, userId: string): Promise<void> {
  const pkg = await getChannelKeyPackage(channelId);
  if (!pkg) return;
  delete pkg.wrappedKeys[userId];
  pkg.updatedAt = Date.now();
  await cache.set(redisKey(channelId), pkg, KEY_TTL_SECONDS);
}
