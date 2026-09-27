// server/lib/uploadStorageTopology.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÇOK DÜĞÜMLÜ DAĞITIMDA YÜKLEMELER DÜĞÜME YEREL OLAMAZ (Final21 Faz 10 — F21-10-02)
// ════════════════════════════════════════════════════════════════════════════
//
// Yükleme deposu varsayılan olarak yerel disktir ve iki ayrı ayar vardır:
// `CDN_PROVIDER` (genel varlıklar) ve `PRIVATE_STORAGE_PROVIDER` (korumalı
// ekler). İkincisi, birincisi uzak olsa bile AYRICA yerel diske düşer
// (`storageAdapter.ts`).
//
// İki gerçek Bridge örneği (aynı PostgreSQL + Redis, örnek başına ayrı yükleme
// kökü — Kubernetes'te pod başına `emptyDir`) önünde ÖLÇÜLDÜ:
//
//     örnek A üzerinden avatar yüklendi  -> GET A 200, GET B 404
//     örnek B `/api/me` aynı URL'yi kullanıcıya VERİYOR (paylaşılan veritabanı)
//
// Uygulama kaç replika çalıştığını bilemez. Bu yüzden dağıtım bunu AÇIKÇA ilan
// eder (`BRIDGE_MULTI_NODE=true`) ve uygulama, düğüme yerel depolamayla
// açılmayı REDDEDER (fail-closed). Helm şeması aynı kuralı render anında da
// uygular; bu denetim, render koruması olmayan kustomize/compose yollarını da
// kapsar.

const REMOTE_PROVIDERS = new Set(['s3', 'r2', 'minio', 'b2']);

export function sharedUploadStorageProblem(env: NodeJS.ProcessEnv): string | null {
  if (String(env.BRIDGE_MULTI_NODE ?? '').trim().toLowerCase() !== 'true') return null;
  const publicProvider = String(env.CDN_PROVIDER ?? 'local').trim().toLowerCase() || 'local';
  const privateProvider = String(env.PRIVATE_STORAGE_PROVIDER ?? 'local').trim().toLowerCase() || 'local';
  const local: string[] = [];
  if (!REMOTE_PROVIDERS.has(publicProvider)) local.push(`CDN_PROVIDER=${publicProvider}`);
  if (!REMOTE_PROVIDERS.has(privateProvider)) local.push(`PRIVATE_STORAGE_PROVIDER=${privateProvider}`);
  if (local.length === 0) return null;
  return 'BRIDGE_MULTI_NODE=true ama yükleme deposu düğüme yerel '
    + `(${local.join(', ')}). Çok düğümde bir örneğe yüklenen dosya diğerinde 404 döner `
    + 've pod yeniden başlayınca kaybolur. İkisini de s3|r2|minio|b2 yapın '
    + 'ya da tek düğümde BRIDGE_MULTI_NODE ayarını kaldırın.';
}
