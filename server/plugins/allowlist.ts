// plugins/allowlist.ts
// Security: validates plugin metadata before loading
// SPRINT65: Manifest validation genişletildi — izin modeli, yasaklı izinler, kategori kuralları
// SPRINT77: console.warn kaldırıldı — caller logger'ı kullanır (opsiyonel parametre)

'use strict';

export interface PluginMeta {
  id?:          unknown;
  name?:        unknown;
  version?:     unknown;
  permissions?: unknown;
  category?:    unknown;
  [key: string]: unknown;
}

const REQUIRED_FIELDS: ReadonlyArray<keyof PluginMeta> = ['id', 'name', 'version'];
const ID_PATTERN = /^[a-z0-9_-]{2,64}$/;

// ── İzin modeli ───────────────────────────────────────────────
export const ALLOWED_PERMISSIONS = new Set([
  'messages:read',
  'messages:send',
  'reactions:add',
  'channels:read',
  'members:read',
  'server:info',
  'dm:send',
  'webhooks:send',
  'voice:join',
  'files:upload',
]);

export const RESTRICTED_PERMISSIONS = new Set([
  'admin:read',
  'moderation:timeout',
  'moderation:kick',
  'roles:assign',
]);

// Hiçbir plugin'e verilemeyen izinler
export const BANNED_PERMISSIONS = new Set([
  'admin:write',
  'moderation:ban',
  'moderation:delete_messages',
  'server:delete',
  'roles:manage',
  'members:ban',
  'system:exec',
  'db:raw',
  'token:read',
]);

// Yasaklı kategoriler (PLUGIN_MODERATION.md §içerik kuralları)
export const BANNED_CATEGORIES = new Set([
  'adult',
  'gambling',
  'crypto-trading',
  'surveillance',
]);

export interface ValidationResult {
  ok:      boolean;
  reasons: string[];
}

/**
 * Detaylı manifest doğrulama — her başarısızlığı raporlar.
 */
export function validateManifest(meta: PluginMeta): ValidationResult {
  const reasons: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (!meta[field]) reasons.push(`Eksik zorunlu alan: "${String(field)}"`);
  }

  if (typeof meta.id !== 'string' || !ID_PATTERN.test(meta.id)) {
    reasons.push(`Güvensiz plugin id: "${String(meta.id)}" — yalnızca [a-z0-9_-] (2–64 karakter)`);
  }

  if (typeof meta.version !== 'string' || !/^\d+\.\d+\.\d+/.test(meta.version)) {
    reasons.push(`Geçersiz versiyon: "${String(meta.version)}" — semver formatı bekleniyor (örn. 1.0.0)`);
  }

  if (meta.permissions !== undefined) {
    if (!Array.isArray(meta.permissions)) {
      reasons.push('permissions bir dizi olmalıdır');
    } else {
      for (const perm of meta.permissions) {
        if (typeof perm !== 'string') {
          reasons.push(`Geçersiz izin tipi: ${JSON.stringify(perm)}`);
          continue;
        }
        if (BANNED_PERMISSIONS.has(perm)) {
          reasons.push(`Yasaklı izin: "${perm}" — bu izin hiçbir plugin'e verilemez`);
        } else if (!ALLOWED_PERMISSIONS.has(perm) && !RESTRICTED_PERMISSIONS.has(perm)) {
          reasons.push(`Bilinmeyen izin: "${perm}" — allowlist'te tanımlı değil`);
        }
      }
    }
  }

  if (meta.category !== undefined) {
    if (typeof meta.category !== 'string') {
      reasons.push('category bir string olmalıdır');
    } else if (BANNED_CATEGORIES.has(meta.category)) {
      reasons.push(`Yasaklı kategori: "${meta.category}"`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Hızlı boolean kontrol — geriye dönük uyumluluk için korundu.
 * Detaylı hata için validateManifest() kullanın.
 *
 * @param logger - Opsiyonel; verilmezse red gerekçeleri sessizce yutulur.
 *                 Sprint 77: console.warn kaldırıldı, caller kendi logger'ını geçirir.
 */
export function isAllowed(
  meta: PluginMeta,
  logger?: { warn?: (...args: unknown[]) => void },
): boolean {
  const result = validateManifest(meta);
  if (!result.ok) {
    logger?.warn?.(`[Allowlist] Reddedildi: ${String(meta.id ?? '?')}`, result.reasons);
  }
  return result.ok;
}
