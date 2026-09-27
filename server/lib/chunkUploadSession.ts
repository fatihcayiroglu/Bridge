// server/lib/chunkUploadSession.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PARÇALI YÜKLEME OTURUMU — TAMAMLANMA YANITI VE HAZIRLAMA KONUMU
// ════════════════════════════════════════════════════════════════════════════
// Parçalar, yükleme tamamlanana kadar düğümün yükleme kökü altında
// (`_chunks/<oturum>/`) bekler. Çok düğümlü düzenekte (scripts/multinode)
// ÖLÇÜLEN iki boşluk:
//
//  1. Son parçanın yanıtı kaybolursa (zaman aşımı, bağlantı kopması) istemci
//     aynı parçayı yeniden gönderir. Oturum kapanmış olduğu için yeniden deneme
//     YENİ bir oturum açıyor, `{done:false}` alıyor ve tamamlanmış dosyanın
//     adresini asla öğrenemiyordu; açılan yetim oturum kota yuvası tutuyordu.
//     Tek düğümde de aynıydı (UP-04). → Tamamlanma yanıtı oturum anahtarıyla
//     (kullanıcıya bağlı) saklanır; aynı yüklemenin her yeniden denemesi AYNI
//     yanıtı alır.
//
//  2. Hazırlama deposu düğüme yerel olduğunda (Kubernetes `emptyDir`), yük
//     dengeleyici parçaları farklı düğümlere dağıtırsa her düğüm eksik bir küme
//     tutar: her parça 200 döner, yükleme ASLA tamamlanmaz ve kullanıcı dört
//     böyle yüklemeden sonra oturum sınırına takılır (UP-02/06/07). → Oturumun
//     hazırlandığı düğüm paylaşılan otoritede işaretlenir; hazırlığı başka
//     yerde olan bir parça SESSİZCE kabul edilmez, açık bir 409 alır.
//
// Paylaşılan hazırlama deposunda (docker-compose.cluster.yml) manifest her
// düğümde görünür; işaret yalnızca manifest bulunamadığında okunur, bu yüzden
// o düzenekte davranış değişmez.

import { cache } from './redisAdapter';

export const CHUNK_NODE_ID = process.env.INSTANCE_ID || `node-${process.pid}`;

export interface FinalizedChunkUpload {
  /** Exact manifest the upload was bound to; a replay must match it. */
  manifest: string;
  result: { done: true; url: string; fileName: string; fileType: string; size: number };
}

const finalizedKey = (sessionKey: string): string => `chunkdone:${sessionKey}`;
const stagingKey = (sessionKey: string): string => `chunkstage:${sessionKey}`;

export async function readFinalizedChunkUpload(sessionKey: string): Promise<FinalizedChunkUpload | null> {
  return cache.getAuthoritative<FinalizedChunkUpload>(finalizedKey(sessionKey));
}

export async function recordFinalizedChunkUpload(
  sessionKey: string,
  record: FinalizedChunkUpload,
  ttlSeconds: number,
): Promise<void> {
  await cache.setAuthoritative(finalizedKey(sessionKey), record, Math.max(1, Math.ceil(ttlSeconds)));
}

export async function readChunkStagingNode(sessionKey: string): Promise<string | null> {
  return cache.getAuthoritative<string>(stagingKey(sessionKey));
}

export async function markChunkStagingNode(sessionKey: string, ttlSeconds: number): Promise<void> {
  await cache.setAuthoritative(stagingKey(sessionKey), CHUNK_NODE_ID, Math.max(1, Math.ceil(ttlSeconds)));
}

export async function clearChunkStagingNode(sessionKey: string): Promise<void> {
  await cache.delAuthoritative(stagingKey(sessionKey));
}
